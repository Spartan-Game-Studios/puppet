//! Imported animation clips: Puppet's own copies of the user's FBX / GLB files.
//!
//! ```text
//! <appData>/clips/clips.json          index (names, kinds, animation per entry), written atomically
//! <appData>/clips/<sha256>/clip.fbx   the copied file (or clip.glb)
//! ```
//!
//! Same rules as the model library (library.rs): every path the frontend can
//! reach is built here from a validated id (the file's SHA-256, 64 lower-case
//! hex characters) and an extension from a fixed list, entries that are
//! symlinks are refused, and the import source path is only ever read.
//!
//! `PUPPET_CLIPS_DIR` (or `PUPPET_SETTINGS_DIR`, as `<dir>/clips`) moves the
//! store for tests.

use crate::library::{valid_id, write_atomic};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

pub const EXTS: [&str; 2] = ["fbx", "glb"];
const INDEX: &str = "clips.json";

/// The directory of one entry, or an error for anything that is not an id.
pub fn entry_dir(root: &Path, id: &str) -> Result<PathBuf, String> {
    if !valid_id(id) {
        return Err(format!("not a clip id: {id:?}"));
    }
    let dir = root.join(id);
    if std::fs::symlink_metadata(&dir).map(|m| m.file_type().is_symlink()).unwrap_or(false) {
        return Err("clip entry is a symlink".into());
    }
    Ok(dir)
}

/// `<root>/<id>/clip.<ext>`; `ext` must be one of [`EXTS`].
pub fn entry_file(root: &Path, id: &str, ext: &str) -> Result<PathBuf, String> {
    if !EXTS.contains(&ext) {
        return Err(format!("not a clip type: {ext:?}"));
    }
    Ok(entry_dir(root, id)?.join(format!("clip.{ext}")))
}

/// Copy an external file into an entry (temp + rename). Returns false when
/// the entry already has the file (dedup by hash: nothing copied).
pub fn import_copy(root: &Path, src: &Path, id: &str, ext: &str) -> Result<bool, String> {
    let dest = entry_file(root, id, ext)?;
    if dest.is_file() {
        return Ok(false);
    }
    let dir = entry_dir(root, id)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let tmp = dir.join(format!(".clip.{ext}.{}.tmp", std::process::id()));
    std::fs::copy(src, &tmp).map_err(|e| format!("{}: {e}", src.display()))?;
    std::fs::rename(&tmp, &dest).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })?;
    Ok(true)
}

/// Delete one entry's directory (Puppet's copy only; never follows a symlink out).
pub fn remove(root: &Path, id: &str) -> Result<(), String> {
    if !valid_id(id) {
        return Err(format!("not a clip id: {id:?}"));
    }
    let dir = root.join(id);
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
    let dir = if let Some(d) = std::env::var_os("PUPPET_CLIPS_DIR") {
        PathBuf::from(d)
    } else if let Some(d) = std::env::var_os("PUPPET_SETTINGS_DIR") {
        PathBuf::from(d).join("clips")
    } else {
        app.path().app_data_dir().map_err(|e| e.to_string())?.join("clips")
    };
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

#[tauri::command]
pub fn clips_location(app: AppHandle) -> Result<String, String> {
    Ok(root(&app)?.display().to_string())
}

/// Copy the user's file into the store. `id` is the SHA-256 the frontend
/// computed from the same bytes it parsed.
#[tauri::command(async)]
pub fn clips_import_path(app: AppHandle, path: String, id: String, ext: String) -> Result<bool, String> {
    import_copy(&root(&app)?, Path::new(&path), &id, &ext)
}

/// Raw binary body; headers `x-id` and `x-ext` name the destination.
#[tauri::command(async)]
pub fn clips_write(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(body) = request.body() else {
        return Err("clips_write expects a binary body".into());
    };
    let h = |k: &str| request.headers().get(k).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let path = entry_file(&root(&app)?, &h("x-id"), &h("x-ext"))?;
    write_atomic(&path, body)
}

#[tauri::command(async)]
pub fn clips_read(app: AppHandle, id: String, ext: String) -> Result<tauri::ipc::Response, String> {
    let p = entry_file(&root(&app)?, &id, &ext)?;
    std::fs::read(&p).map(tauri::ipc::Response::new).map_err(|e| format!("clip.{ext}: {e}"))
}

#[tauri::command(async)]
pub fn clips_delete(app: AppHandle, id: String) -> Result<(), String> {
    remove(&root(&app)?, &id)
}

#[tauri::command(async)]
pub fn clips_index_load(app: AppHandle) -> Result<Option<String>, String> {
    load_index(&root(&app)?)
}

#[tauri::command(async)]
pub fn clips_index_save(app: AppHandle, json: String) -> Result<(), String> {
    save_index(&root(&app)?, &json)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("puppet-clips-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn paths_stay_inside_the_store() {
        let root = Path::new("/clips");
        assert_eq!(entry_file(root, ID, "fbx").unwrap(), root.join(ID).join("clip.fbx"));
        assert_eq!(entry_file(root, ID, "glb").unwrap(), root.join(ID).join("clip.glb"));
        for ext in ["", "vrm", "../fbx", "fbx/../../x", "FBX", "gltf", "json"] {
            assert!(entry_file(root, ID, ext).is_err(), "{ext:?} accepted");
        }
        for id in ["..", "../etc", "/etc/passwd", &ID[..63], &ID.to_uppercase()] {
            assert!(entry_dir(root, id).is_err(), "{id:?} accepted");
        }
    }

    #[test]
    fn import_dedups_reads_back_and_removes() {
        let d = scratch("import");
        let root = d.join("clips");
        let src = d.join("Wave.fbx");
        std::fs::write(&src, b"Kaydara FBX Binary").unwrap();
        assert!(import_copy(&root, &src, ID, "fbx").unwrap());
        assert!(!import_copy(&root, &src, ID, "fbx").unwrap());
        assert_eq!(std::fs::read(entry_file(&root, ID, "fbx").unwrap()).unwrap(), b"Kaydara FBX Binary");
        assert!(import_copy(&root, &src, "../escape", "fbx").is_err());
        assert!(import_copy(&root, &src, ID, "exe").is_err());

        assert_eq!(load_index(&root).unwrap(), None);
        save_index(&root, "{\"clips\":[]}").unwrap();
        assert_eq!(load_index(&root).unwrap().as_deref(), Some("{\"clips\":[]}"));

        remove(&root, ID).unwrap();
        assert!(!root.join(ID).exists());
        assert!(src.is_file(), "the original must never be touched");
        remove(&root, ID).unwrap();
        assert!(remove(&root, "..").is_err());
        std::fs::remove_dir_all(&d).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_entries_are_refused() {
        let d = scratch("symlink");
        let root = d.join("clips");
        let outside = d.join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("keep.txt"), b"keep").unwrap();
        std::fs::create_dir_all(&root).unwrap();
        std::os::unix::fs::symlink(&outside, root.join(ID)).unwrap();
        assert!(entry_file(&root, ID, "fbx").is_err());
        assert!(import_copy(&root, &outside.join("keep.txt"), ID, "glb").is_err());
        remove(&root, ID).unwrap();
        assert!(outside.join("keep.txt").is_file());
        std::fs::remove_dir_all(&d).unwrap();
    }
}
