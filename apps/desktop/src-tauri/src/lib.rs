use tauri::Manager;
use tauri_plugin_shell::ShellExt;

#[tauri::command]
fn server_url() -> String {
    let port = std::env::var("TRADING_SERVER_PORT").unwrap_or_else(|_| "4242".into());
    format!("ws://localhost:{}", port)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![server_url])
        .setup(|app| {
            #[cfg(debug_assertions)]
            app.get_webview_window("main").unwrap().open_devtools();

            // Spawn the Node trading server as a background sidecar.
            // The sidecar binary must be placed in src-tauri/binaries/ at build time.
            // In development, the server is started separately via `pnpm server:dev`.
            #[cfg(not(debug_assertions))]
            {
                let shell = app.shell();
                let _ = shell
                    .sidecar("trading-server")
                    .expect("trading-server sidecar not found")
                    .spawn();
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
