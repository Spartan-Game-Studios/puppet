//! The app was called Puppet (identifier com.spartangamestudios.puppet). The
//! config and data folders are named after the identifier, so on the first
//! VPuppet launch move the old folders to the new names, keeping the library,
//! clips and settings. A new folder that already exists is left alone.

use std::path::Path;
use tauri::{AppHandle, Manager};

const OLD_ID: &str = "com.spartangamestudios.puppet";

pub fn from_puppet(app: &AppHandle) {
    let p = app.path();
    // Config and data are the same folder on macOS and Windows; the second
    // rename then finds nothing to move.
    for dir in [p.app_config_dir(), p.app_data_dir(), p.app_local_data_dir()].into_iter().flatten() {
        move_old(&dir);
    }
}

fn move_old(new: &Path) {
    let Some(old) = new.parent().map(|d| d.join(OLD_ID)) else { return };
    if old == new || !old.is_dir() || new.exists() {
        return;
    }
    match std::fs::rename(&old, new) {
        Ok(()) => println!("[vpuppet] moved {} -> {}", old.display(), new.display()),
        Err(e) => eprintln!("[vpuppet] could not move {} -> {}: {e}", old.display(), new.display()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn moves_the_old_folder_once() {
        let root = std::env::temp_dir().join(format!("vpuppet-migrate-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let old = root.join(OLD_ID);
        let new = root.join("com.spartangamestudios.vpuppet");
        std::fs::create_dir_all(old.join("library")).unwrap();
        std::fs::write(old.join("settings.json"), "{}").unwrap();
        move_old(&new);
        assert!(new.join("settings.json").is_file() && new.join("library").is_dir());
        assert!(!old.exists());
        // An existing new folder is never overwritten.
        std::fs::create_dir_all(&old).unwrap();
        std::fs::write(old.join("settings.json"), "old").unwrap();
        move_old(&new);
        assert_eq!(std::fs::read_to_string(new.join("settings.json")).unwrap(), "{}");
        let _ = std::fs::remove_dir_all(&root);
    }
}
