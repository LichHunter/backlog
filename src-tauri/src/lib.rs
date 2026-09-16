pub mod registry;
pub mod server;
mod state;

use registry::Registry;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use tauri::Manager;

pub use state::AppState;

static APP_HANDLE: OnceLock<tauri::AppHandle> = OnceLock::new();

/// Process-wide app handle (todo 4's folder picker); `None` before `.setup()`
/// ran — i.e. always inside the standalone `backlog-server` bin.
pub fn app_handle() -> Option<&'static tauri::AppHandle> {
    APP_HANDLE.get()
}

#[tauri::command]
fn get_server_url(state: tauri::State<'_, Arc<AppState>>) -> String {
    format!("http://127.0.0.1:{}", state.server_port())
}

/// Data root for the registry; overridable via `BACKLOG_DATA_HOME` (tests,
/// standalone bin).
pub fn default_data_root() -> PathBuf {
    std::env::var("BACKLOG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            dirs::data_local_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join("backlog-app")
        })
}

/// Bootstraps an empty registry from the legacy single-project layout.
///
/// No-op when the registry already has projects. Otherwise scans `root`,
/// `root/data`, then `legacy_dirs` (in order) for a `backlog.md`; candidates
/// byte-identical to a fresh seed (the bundled `testdata/backlog.md` example,
/// read from `<exe_dir>/../Resources/testdata/backlog.md` when readable, or
/// the compiled-in skeleton) carry no user data and are ignored. The best
/// non-seed candidate is COPIED — never registered in place — together with
/// its sibling `archive.md` and `backups/` into `root/data/`, and the copy is
/// registered as the default project "Backlog". Sources are left untouched.
/// Bundle-internal candidates (path containing `/.app/`) are therefore only
/// ever copy sources. No candidate anywhere → `root/data/backlog.md` is
/// seeded with the skeleton (the pre-migration bootstrap floor).
pub fn bootstrap_registry(registry: &Registry, root: &Path, legacy_dirs: &[PathBuf]) {
    if !registry.list().is_empty() {
        return;
    }

    let seed_example = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|p| p.to_path_buf()))
        .and_then(|p| std::fs::read(p.join("../Resources/testdata/backlog.md")).ok());
    let is_seed = |bytes: &[u8]| {
        bytes == registry::DEFAULT_BACKLOG_SKELETON.as_bytes()
            || seed_example.as_deref() == Some(bytes)
    };

    let mut candidates: Vec<PathBuf> = vec![root.join("backlog.md"), root.join("data").join("backlog.md")];
    candidates.extend(legacy_dirs.iter().map(|d| d.join("backlog.md")));
    let chosen = candidates.iter().find(|c| match std::fs::read(c) {
        Ok(bytes) => !is_seed(&bytes),
        Err(_) => false, // missing or unreadable candidate → skipped
    });

    let dest_dir = root.join("data");
    if let Some(source) = chosen {
        if let Err(e) = std::fs::create_dir_all(&dest_dir) {
            log::warn!("failed to create {:?}: {}", dest_dir, e);
        }
        let source_dir = source.parent().unwrap_or(Path::new("."));
        copy_if_different(source, &dest_dir.join("backlog.md"));
        let archive = source_dir.join("archive.md");
        if archive.is_file() {
            copy_if_different(&archive, &dest_dir.join("archive.md"));
        }
        let backups = source_dir.join("backups");
        if backups.is_dir() {
            copy_dir_contents(&backups, &dest_dir.join("backups"));
        }
    }

    // The .md form creates missing parents and seeds the skeleton when the
    // file is absent, so this also covers the fresh-world floor.
    let backlog = dest_dir.join("backlog.md");
    let Some(backlog) = backlog.to_str() else {
        log::warn!("data root {:?} is not valid UTF-8; skipping default project", root);
        return;
    };
    if let Err(e) = registry.register(backlog, Some("Backlog".into())) {
        log::warn!("failed to register default project: {}", e);
    }
}

/// `fs::copy` would truncate a file copied onto itself; same-path copies
/// (e.g. the chosen candidate already living at `root/data/backlog.md`)
/// are skipped. Failures are logged — migration must never panic.
fn copy_if_different(source: &Path, dest: &Path) {
    if source.canonicalize().ok() == dest.canonicalize().ok() && dest.exists() {
        return;
    }
    if let Err(e) = std::fs::copy(source, dest) {
        log::warn!("failed to copy {:?} to {:?}: {}", source, dest, e);
    }
}

fn copy_dir_contents(source: &Path, dest: &Path) {
    if let Err(e) = std::fs::create_dir_all(dest) {
        log::warn!("failed to create {:?}: {}", dest, e);
        return;
    }
    let Ok(entries) = std::fs::read_dir(source) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        let dest_path = dest.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir_contents(&entry.path(), &dest_path);
        } else if file_type.is_file() {
            copy_if_different(&entry.path(), &dest_path);
        }
    }
}

/// Legacy `Resources/data` dir inside an app bundle (`Contents/MacOS/exe` →
/// `../Resources/data`); the data root itself when not running from a bundle.
fn bundled_resources_data(root: &Path) -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|p| p.to_path_buf()))
        .map(|p| p.join("../Resources/data"))
        .filter(|p| p.is_dir())
        .unwrap_or_else(|| root.to_path_buf())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();

    let root = default_data_root();
    if let Err(e) = std::fs::create_dir_all(&root) {
        eprintln!("failed to create data root {:?}: {}", root, e);
        std::process::exit(1);
    }
    let registry = Arc::new(Registry::with_path(root.join("projects.json")));
    registry.load_or_default();
    bootstrap_registry(&registry, &root, &[bundled_resources_data(&root)]);

    // Get frontend directory path
    let frontend_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        .map(|p| p.join("../Resources/src"))
        .unwrap_or_else(|| PathBuf::from("src"));

    log::info!("Frontend directory: {:?}", frontend_dir);

    // Bind first, then navigate: bind_and_spawn returns only after the socket
    // is bound, so there is no sleep-and-hope race.
    let (addr, _accept_loop) = match server::bind_and_spawn(registry, frontend_dir, None) {
        Ok(bound) => bound,
        Err(e) => {
            eprintln!("failed to start HTTP server: {}", e);
            std::process::exit(1);
        }
    };

    let server_url = format!("http://127.0.0.1:{}", addr.port());
    let app_state = Arc::new(AppState::new(addr.port()));

    let mut builder = tauri::Builder::default();

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }));
    }

    builder
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init())
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![get_server_url])
        .setup(move |app| {
            let _ = APP_HANDLE.set(app.handle().clone());
            log::info!("Server running at {}", server_url);

            if let Some(window) = app.get_webview_window("main") {
                let url = server_url.clone();
                let _ = window.eval(format!("window.location.href = '{}'", url));
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
