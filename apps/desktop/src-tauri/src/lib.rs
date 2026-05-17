use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager;
use tauri_plugin_shell::ShellExt;

#[tauri::command]
fn server_url() -> String {
    let port = std::env::var("TRADING_SERVER_PORT").unwrap_or_else(|_| "4242".into());
    format!("ws://localhost:{}", port)
}

// TRA-413 — desktop error telemetry, host (Rust) process half.
//
// The Tauri host process is the desktop equivalent of an Electron "main"
// process. It has no HTTP client, and a panic here tears the whole app down
// before the renderer could report anything. So the panic hook writes a
// structured record to a crash file; on its next launch the renderer drains
// that file via the `take_crash_reports` command and forwards each record to
// the same `/api/client-error` destination renderer errors use. The error then
// lands in the server's queryable `errors.jsonl` / `ERROR_WEBHOOK_URL` with a
// trace id, satisfying "a thrown error in the main process surfaces in the
// queryable error destination".

/// Path of the JSONL crash file. In the system temp dir so the panic hook can
/// reach it without a Tauri `App` handle (the hook runs as a global handler).
fn crash_file_path() -> PathBuf {
    std::env::temp_dir().join("trading-app-desktop-crashes.jsonl")
}

/// Nanoseconds since the Unix epoch — fits in u64 until well past year 2500.
fn unix_nanos() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0)
}

/// Install a panic hook that appends one JSON record per panic to the crash
/// file, then delegates to the default hook. Best-effort: a failure to record a
/// crash must not itself panic.
fn install_panic_hook() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let nanos = unix_nanos();
        let message = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| (*s).to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "unknown panic".to_string());
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "unknown".to_string());
        let record = serde_json::json!({
            "ts": nanos,
            "traceId": format!("desktop-main-{}", nanos),
            "message": message,
            "location": location,
            "source": "tauri-main",
        });
        if let Ok(mut file) = OpenOptions::new()
            .create(true)
            .append(true)
            .open(crash_file_path())
        {
            let _ = writeln!(file, "{}", record);
        }
        default_hook(info);
    }));
}

/// Read and clear pending host-process crash records. Called by the renderer on
/// startup; returns each record as a raw JSON string. The file is removed so
/// every crash is reported exactly once.
#[tauri::command]
fn take_crash_reports() -> Vec<String> {
    let path = crash_file_path();
    let file = match File::open(&path) {
        Ok(f) => f,
        Err(_) => return Vec::new(),
    };
    let reports: Vec<String> = BufReader::new(file)
        .lines()
        .filter_map(|line| line.ok())
        .filter(|line| !line.trim().is_empty())
        .collect();
    let _ = std::fs::remove_file(&path);
    reports
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    install_panic_hook();
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![server_url, take_crash_reports])
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
