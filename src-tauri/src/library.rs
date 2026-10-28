//! Model library storage: Puppet's own copies of imported VRMs.
//!
//! ```text
//! <appData>/library/library.json          index (favourites, names, times), written atomically
//! <appData>/library/<sha256>/model.vrm    the copied model
//! <appData>/library/<sha256>/thumb.png    bust thumbnail (rendered by the frontend)
//! <appData>/library/<sha256>/meta.json    measured info (written last: marks the entry complete)
//! ```
//!
//! Every path the frontend can reach is built here from a validated id (64
//! lower-case hex characters, the file's SHA-256) and a file name from a fixed
//! list, so nothing outside the library directory can be read, written or
//! deleted through these commands. The import source path is the one
//! exception: it is only ever read (copied from), like `read_file`.
//!
//! `PUPPET_LIBRARY_DIR` (or `PUPPET_SETTINGS_DIR`, as `<dir>/library`) moves the
//! library for tests.

use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

pub const FILES: [&str; 3] = ["model.vrm", "thumb.png", "meta.json"];
const INDEX: &str = "library.json";

pub fn valid_id(id: &str) -> bool {
    id.len() == 64 && id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// The directory of one entry, or an error for anything that is not a library
/// id. An entry that is a symlink is refused, so nothing is read or written
/// through one to somewhere outside the library.
pub fn entry_dir(root: &Path, id: &str) -> Result<PathBuf, String> {
    if !valid_id(id) {
        return Err(format!("not a library id: {id:?}"));
    }
    let dir = root.join(id);
    if std::fs::symlink_metadata(&dir).map(|m| m.file_type().is_symlink()).unwrap_or(false) {
        return Err("library entry is a symlink".into());
    }
    Ok(dir)
}

/// One file of one entry; `file` must be one of [`FILES`].
pub fn entry_file(root: &Path, id: &str, file: &str) -> Result<PathBuf, String> {
    if !FILES.contains(&file) {
        return Err(format!("not a library file: {file:?}"));
    }
    Ok(entry_dir(root, id)?.join(file))
}

/// Write via a temp file in the same directory, then rename over the target,
/// so a reader (or a crash) sees the old file or the new one, never half of one.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let dir = path.parent().ok_or("no parent directory")?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let name = path.file_name().ok_or("no file name")?.to_string_lossy();
    let tmp = dir.join(format!(".{name}.{}.tmp", std::process::id()));
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })
}

/// Copy an external file into an entry as `model.vrm` (temp + rename). Returns
/// false when the entry already has its model (dedup by hash: nothing copied).
pub fn import_copy(root: &Path, src: &Path, id: &str) -> Result<bool, String> {
    let dest = entry_file(root, id, "model.vrm")?;
    if dest.is_file() {
        return Ok(false);
    }
    let dir = entry_dir(root, id)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let tmp = dir.join(format!(".model.vrm.{}.tmp", std::process::id()));
    std::fs::copy(src, &tmp).map_err(|e| format!("{}: {e}", src.display()))?;
    std::fs::rename(&tmp, &dest).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })?;
    Ok(true)
}

#[derive(Serialize, Debug)]
pub struct Entry {
    pub id: String,
    pub size: u64,
    pub has_thumb: bool,
    /// meta.json contents.
    pub meta: String,
}

/// Complete entries (model + meta.json present). Stray files, half-written
/// imports and anything not named like an id are ignored.
pub fn list(root: &Path) -> Result<Vec<Entry>, String> {
    let mut out = Vec::new();
    let rd = match std::fs::read_dir(root) {
        Ok(r) => r,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(out),
        Err(e) => return Err(e.to_string()),
    };
    for de in rd.flatten() {
        let name = de.file_name().to_string_lossy().to_string();
        if !valid_id(&name) || !de.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let dir = de.path();
        let Ok(model) = std::fs::metadata(dir.join("model.vrm")) else { continue };
        let Ok(meta) = std::fs::read_to_string(dir.join("meta.json")) else { continue };
        out.push(Entry { id: name, size: model.len(), has_thumb: dir.join("thumb.png").is_file(), meta });
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(out)
}

/// Delete one entry's directory (Puppet's copy only).
pub fn remove(root: &Path, id: &str) -> Result<(), String> {
    if !valid_id(id) {
        return Err(format!("not a library id: {id:?}"));
    }
    let dir = root.join(id);
    // Never follow a symlink out of the library.
    match std::fs::symlink_metadata(&dir) {
        Ok(m) if m.file_type().is_symlink() => std::fs::remove_file(&dir).map_err(|e| e.to_string()),
        Ok(_) => std::fs::remove_dir_all(&dir).map_err(|e| e.to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

pub fn load_index(root: &Path) -> Result<Option<String>, String> {
    match std::fs::read_to_string(root.join(INDEX)) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

pub fn save_index(root: &Path, json: &str) -> Result<(), String> {
    write_atomic(&root.join(INDEX), json.as_bytes())
}

// ---------------------------------------------------------------- Tauri commands

pub fn root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = if let Some(d) = std::env::var_os("PUPPET_LIBRARY_DIR") {
        PathBuf::from(d)
    } else if let Some(d) = std::env::var_os("PUPPET_SETTINGS_DIR") {
        PathBuf::from(d).join("library")
    } else {
        app.path().app_data_dir().map_err(|e| e.to_string())?.join("library")
    };
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

#[tauri::command]
pub fn library_location(app: AppHandle) -> Result<String, String> {
    Ok(root(&app)?.display().to_string())
}

#[tauri::command(async)]
pub fn library_list(app: AppHandle) -> Result<Vec<Entry>, String> {
    list(&root(&app)?)
}

/// Copy the user's file into the library. `id` is the SHA-256 the frontend
/// computed from the same bytes it parsed.
#[tauri::command(async)]
pub fn library_import_path(app: AppHandle, path: String, id: String) -> Result<bool, String> {
    import_copy(&root(&app)?, Path::new(&path), &id)
}

/// Raw binary body; headers `x-id` and `x-file` name the destination.
#[tauri::command(async)]
pub fn library_write(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(body) = request.body() else {
        return Err("library_write expects a binary body".into());
    };
    let h = |k: &str| request.headers().get(k).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let path = entry_file(&root(&app)?, &h("x-id"), &h("x-file"))?;
    write_atomic(&path, body)
}

#[tauri::command(async)]
pub fn library_read(app: AppHandle, id: String, file: String) -> Result<tauri::ipc::Response, String> {
    let p = entry_file(&root(&app)?, &id, &file)?;
    std::fs::read(&p).map(tauri::ipc::Response::new).map_err(|e| format!("{file}: {e}"))
}

#[tauri::command(async)]
pub fn library_delete(app: AppHandle, id: String) -> Result<(), String> {
    remove(&root(&app)?, &id)
}

#[tauri::command(async)]
pub fn library_index_load(app: AppHandle) -> Result<Option<String>, String> {
    load_index(&root(&app)?)
}

#[tauri::command(async)]
pub fn library_index_save(app: AppHandle, json: String) -> Result<(), String> {
    save_index(&root(&app)?, &json)
}

/// Show an entry's model file in Finder / Explorer / the file manager.
#[tauri::command(async)]
pub fn library_reveal(app: AppHandle, id: String) -> Result<(), String> {
    let file = entry_file(&root(&app)?, &id, "model.vrm")?;
    if !file.is_file() {
        return Err("not in the library".into());
    }
    reveal(&file)
}

fn reveal(file: &Path) -> Result<(), String> {
    use std::process::Command;
    #[cfg(target_os = "macos")]
    let r = Command::new("open").arg("-R").arg(file).spawn();
    #[cfg(target_os = "windows")]
    let r = Command::new("explorer").arg(format!("/select,{}", file.display())).spawn();
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    let r = Command::new("xdg-open").arg(file.parent().unwrap_or(file)).spawn();
    r.map(|_| ()).map_err(|e| e.to_string())
}

/// The empty state's "where to get models" links, opened in the system browser.
/// Only these three URLs can be opened.
pub const HELP_LINKS: [(&str, &str); 3] = [
    ("vroid-hub", "https://hub.vroid.com/en"),
    ("open-source-avatars", "https://www.opensourceavatars.com/"),
    ("vroid-studio", "https://vroid.com/en/studio"),
];

#[tauri::command(async)]
pub fn library_open_link(which: String) -> Result<(), String> {
    let url = HELP_LINKS.iter().find(|(k, _)| *k == which).map(|(_, u)| *u).ok_or("unknown link")?;
    use std::process::Command;
    #[cfg(target_os = "macos")]
    let r = Command::new("open").arg(url).spawn();
    #[cfg(target_os = "windows")]
    let r = Command::new("cmd").args(["/C", "start", "", url]).spawn();
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    let r = Command::new("xdg-open").arg(url).spawn();
    r.map(|_| ()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("puppet-lib-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn ids_are_sha256_hex_only() {
        assert!(valid_id(ID));
        for bad in [
            "",
            "..",
            "../etc",
            &ID[..63],
            &format!("{ID}0"),
            &ID.to_uppercase(),
            &format!("../{}", &ID[3..]),
            &format!("/{}", &ID[1..]),
            &format!("{}\\x", &ID[..62]),
            &format!("{}é", &ID[..62]),
        ] {
            assert!(!valid_id(bad), "{bad:?} accepted");
        }
    }

    #[test]
    fn paths_stay_inside_the_library() {
        let root = Path::new("/lib");
        assert_eq!(entry_file(root, ID, "thumb.png").unwrap(), root.join(ID).join("thumb.png"));
        assert!(entry_dir(root, "../../etc").is_err());
        assert!(entry_dir(root, "/etc/passwd").is_err());
        for f in ["../model.vrm", "model.vrm/../../x", "/etc/passwd", "library.json", "", ".", "..", "MODEL.VRM"] {
            assert!(entry_file(root, ID, f).is_err(), "{f:?} accepted");
        }
        for f in FILES {
            assert!(entry_file(root, ID, f).unwrap().starts_with(root.join(ID)));
        }
    }

    #[test]
    fn atomic_write_replaces_whole_file_and_leaves_no_temp() {
        let d = scratch("atomic");
        let p = d.join("library.json");
        write_atomic(&p, b"{\"a\":1}").unwrap();
        write_atomic(&p, b"{\"b\":2}").unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "{\"b\":2}");
        let names: Vec<_> = std::fs::read_dir(&d).unwrap().flatten().map(|e| e.file_name()).collect();
        assert_eq!(names.len(), 1, "temp file left behind: {names:?}");
        assert!(save_index(&d, "{}").is_ok());
        assert_eq!(load_index(&d).unwrap().as_deref(), Some("{}"));
        std::fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn import_dedups_lists_and_removes() {
        let d = scratch("import");
        let root = d.join("library");
        let src = d.join("avatar.vrm");
        std::fs::write(&src, b"glTF-fake").unwrap();
        assert_eq!(load_index(&root).unwrap(), None);
        assert!(list(&root).unwrap().is_empty());

        assert!(import_copy(&root, &src, ID).unwrap());
        // Not listed until meta.json exists (an interrupted import stays invisible).
        assert!(list(&root).unwrap().is_empty());
        write_atomic(&entry_file(&root, ID, "meta.json").unwrap(), b"{\"id\":1}").unwrap();
        let l = list(&root).unwrap();
        assert_eq!(l.len(), 1);
        assert_eq!(l[0].id, ID);
        assert_eq!(l[0].size, 9);
        assert!(!l[0].has_thumb);
        assert_eq!(l[0].meta, "{\"id\":1}");

        // Same hash again: nothing copied, original kept.
        std::fs::write(&src, b"changed").unwrap();
        assert!(!import_copy(&root, &src, ID).unwrap());
        assert_eq!(std::fs::read(entry_file(&root, ID, "model.vrm").unwrap()).unwrap(), b"glTF-fake");
        assert!(import_copy(&root, &src, "../escape").is_err());

        // Junk in the library dir is ignored.
        std::fs::create_dir_all(root.join("not-an-id")).unwrap();
        std::fs::write(root.join("stray.txt"), b"x").unwrap();
        assert_eq!(list(&root).unwrap().len(), 1);

        assert!(remove(&root, "..").is_err());
        remove(&root, ID).unwrap();
        assert!(list(&root).unwrap().is_empty());
        assert!(src.is_file(), "the original must never be touched");
        remove(&root, ID).unwrap(); // already gone: fine
        std::fs::remove_dir_all(&d).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn remove_does_not_follow_symlinks_out() {
        let d = scratch("symlink");
        let root = d.join("library");
        let outside = d.join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("keep.txt"), b"keep").unwrap();
        std::fs::create_dir_all(&root).unwrap();
        std::os::unix::fs::symlink(&outside, root.join(ID)).unwrap();
        assert!(entry_file(&root, ID, "model.vrm").is_err());
        assert!(import_copy(&root, &outside.join("keep.txt"), ID).is_err());
        remove(&root, ID).unwrap();
        assert!(outside.join("keep.txt").is_file());
        std::fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn only_known_help_links() {
        assert!(HELP_LINKS.iter().all(|(_, u)| u.starts_with("https://")));
    }
}
