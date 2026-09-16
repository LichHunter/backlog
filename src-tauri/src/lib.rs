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

/// Bootstrap floor: an empty registry gets one default project so the legacy
/// unscoped routes always have something to serve. The full startup migration
/// from the legacy single-project layout is todo 8.
pub fn ensure_default_project(registry: &Registry, root: &Path) {
    if !registry.list().is_empty() {
        return;
    }
    // Register the backlog file itself: `register` accepts an existing dir or
    // a .md path, and creates missing parents + seeds the skeleton.
    let backlog = root.join("data").join("backlog.md");
    let Some(backlog) = backlog.to_str() else {
        log::warn!("data root {:?} is not valid UTF-8; skipping default project", root);
        return;
    };
    if let Err(e) = registry.register(backlog, Some("Backlog".into())) {
        log::warn!("failed to register default project: {}", e);
    }
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
    ensure_default_project(&registry, &root);

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
                let _ = window.eval(&format!("window.location.href = '{}'", url));
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
