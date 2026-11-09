//! The app is a client of the flashcards server (see `server/`), which owns
//! all the data. The only thing left on the device is, for people upgrading,
//! the database the app used to keep locally; these commands hand it over so
//! the setup screen can upload it to the server once.

use std::path::PathBuf;

use tauri::{ipc::Response, AppHandle, Manager, Runtime};

/// Where the local-only versions of the app kept their database.
fn legacy_database<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("flashcards.db"))
}

fn with_suffix(path: &std::path::Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}

/// Size in bytes of the old local database, or `None` if there is none.
#[tauri::command]
fn legacy_database_size<R: Runtime>(app: AppHandle<R>) -> Result<Option<u64>, String> {
    let path = legacy_database(&app)?;
    match std::fs::metadata(&path) {
        Ok(meta) if meta.len() > 0 => Ok(Some(meta.len())),
        _ => Ok(None),
    }
}

/// The raw bytes of the old database (`part = "database"`) or of its
/// write-ahead log (`part = "wal"`, empty if there is none). The log can hold
/// recent changes that never made it into the main file, so both are sent.
#[tauri::command]
fn read_legacy_database<R: Runtime>(app: AppHandle<R>, part: String) -> Result<Response, String> {
    let path = legacy_database(&app)?;
    let path = match part.as_str() {
        "database" => path,
        "wal" => with_suffix(&path, "-wal"),
        _ => return Err(format!("unknown part `{part}`")),
    };
    match std::fs::read(&path) {
        Ok(bytes) => Ok(Response::new(bytes)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound && part == "wal" => {
            Ok(Response::new(Vec::new()))
        }
        Err(e) => Err(format!("could not read {}: {e}", path.display())),
    }
}

/// Renames the old database once it has been uploaded, so the upload is not
/// offered again. The files are kept, just out of the way.
#[tauri::command]
fn archive_legacy_database<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let path = legacy_database(&app)?;
    for suffix in ["", "-wal", "-shm"] {
        let from = with_suffix(&path, suffix);
        if from.exists() {
            let to = with_suffix(&path, &format!(".uploaded{suffix}"));
            std::fs::rename(&from, &to)
                .map_err(|e| format!("could not rename {}: {e}", from.display()))?;
        }
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(tauri::generate_handler![
            legacy_database_size,
            read_legacy_database,
            archive_legacy_database,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
