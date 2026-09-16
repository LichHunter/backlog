pub mod registry;
mod server;
mod state;

use std::sync::Arc;
use tauri::Manager;

pub use state::AppState;

#[tauri::command]
fn get_server_url(state: tauri::State<'_, Arc<AppState>>) -> String {
    format!("http://127.0.0.1:{}", state.server_port())
}

#[tauri::command]
fn set_data_directory(path: String, state: tauri::State<'_, Arc<AppState>>) -> Result<(), String> {
    state.set_data_dir(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_data_directory(state: tauri::State<'_, Arc<AppState>>) -> Option<String> {
    state.data_dir().map(|p| p.to_string_lossy().to_string())
}

fn get_default_data_dir() -> std::path::PathBuf {
    // Try app's resource directory first, then user's home
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            // In macOS bundle: .app/Contents/MacOS/backlog-app -> .app/Contents/Resources/data
            let resources = parent.join("../Resources/data");
            if resources.exists() || std::fs::create_dir_all(&resources).is_ok() {
                return resources;
            }
        }
    }

    // Fallback to user's home directory
    dirs::data_local_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("backlog-app")
}

fn setup_default_data(state: &Arc<AppState>) {
    let data_dir = get_default_data_dir();

    // Create data directory if needed
    if !data_dir.exists() {
        let _ = std::fs::create_dir_all(&data_dir);
    }

    // Copy example backlog.md if no backlog exists
    let backlog_path = data_dir.join("backlog.md");
    if !backlog_path.exists() {
        // Check for bundled example
        if let Ok(exe) = std::env::current_exe() {
            if let Some(parent) = exe.parent() {
                let example = parent.join("../Resources/testdata/backlog.md");
                if example.exists() {
                    let _ = std::fs::copy(&example, &backlog_path);
                    log::info!("Copied example backlog to {:?}", backlog_path);
                }
            }
        }
    }

    // Set data directory
    let _ = state.set_data_dir(&data_dir.to_string_lossy());
    log::info!("Data directory: {:?}", data_dir);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();

    let port = portpicker::pick_unused_port().expect("No available port");
    let app_state = Arc::new(AppState::new(port));

    // Set up default data directory with example backlog
    setup_default_data(&app_state);

    // Get frontend directory path
    let frontend_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        .map(|p| p.join("../Resources/src"))
        .unwrap_or_else(|| std::path::PathBuf::from("src"));

    log::info!("Frontend directory: {:?}", frontend_dir);

    // Start HTTP server in background thread
    let server_state = app_state.clone();
    let server_frontend_dir = frontend_dir.clone();
    std::thread::spawn(move || {
        server::start_server(server_state, server_frontend_dir);
    });

    // Give server time to start
    std::thread::sleep(std::time::Duration::from_millis(200));

    let mut builder = tauri::Builder::default();

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }));
    }

    let server_url = format!("http://127.0.0.1:{}", port);

    builder
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init())
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![
            get_server_url,
            set_data_directory,
            get_data_directory,
        ])
        .setup(move |app| {
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
