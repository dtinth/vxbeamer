use enigo::{
    Direction::{Click, Press, Release},
    Enigo, Key, Keyboard, Settings,
};
use std::{process::Command, thread, time::Duration};
#[cfg(target_os = "macos")]
use std::sync::mpsc;
use tauri::{image::Image, AppHandle, Manager, Theme};
use tauri_plugin_clipboard_manager::ClipboardExt;

// Give the target app a brief moment to consume the temporary clipboard contents before restoring them.
const PASTE_RESTORE_DELAY_MS: u64 = 150;
// Match the requested desktop window/title-bar color with the app's dark surface.
const DESKTOP_WINDOW_BACKGROUND_COLOR: tauri::utils::config::Color =
    tauri::utils::config::Color(0x12, 0x14, 0x0d, 0xff);

enum ClipboardSnapshot {
    Empty,
    Text(String),
    Image {
        bytes: Vec<u8>,
        width: u32,
        height: u32,
    },
}

#[tauri::command]
async fn copy_text_to_clipboard(app: AppHandle, text: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.clipboard().write_text(text).map_err(|err| err.to_string())
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
async fn paste_text_into_active_app(
    app: AppHandle,
    text: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let snapshot = snapshot_clipboard(&app);
        app.clipboard()
            .write_text(&text)
            .map_err(|err| err.to_string())?;

        let paste_result = trigger_paste_shortcut(&app);
        thread::sleep(Duration::from_millis(PASTE_RESTORE_DELAY_MS));
        let restore_result = restore_clipboard(&app, snapshot);

        paste_result?;
        restore_result
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
async fn open_external_url(url: String) -> Result<(), String> {
    let trimmed = url.trim().to_string();
    if !(trimmed.starts_with("http://") || trimmed.starts_with("https://")) {
        return Err("Only HTTP(S) URLs are supported".into());
    }

    tauri::async_runtime::spawn_blocking(move || open_external_url_blocking(&trimmed))
        .await
        .map_err(|err| err.to_string())?
}

fn snapshot_clipboard(app: &AppHandle) -> ClipboardSnapshot {
    if let Ok(text) = app.clipboard().read_text() {
        return ClipboardSnapshot::Text(text);
    }

    if let Ok(image) = app.clipboard().read_image() {
        return ClipboardSnapshot::Image {
            bytes: image.rgba().to_vec(),
            width: image.width(),
            height: image.height(),
        };
    }

    ClipboardSnapshot::Empty
}

fn restore_clipboard(app: &AppHandle, snapshot: ClipboardSnapshot) -> Result<(), String> {
    match snapshot {
        ClipboardSnapshot::Empty => app.clipboard().clear().map_err(|err| err.to_string()),
        ClipboardSnapshot::Text(text) => app
            .clipboard()
            .write_text(text)
            .map_err(|err| err.to_string()),
        ClipboardSnapshot::Image {
            bytes,
            width,
            height,
        } => app
            .clipboard()
            .write_image(&Image::new_owned(bytes, width, height))
            .map_err(|err| err.to_string()),
    }
}

fn send_paste_shortcut() -> Result<(), String> {
    let mut enigo = Enigo::new(&Settings::default()).map_err(|err| err.to_string())?;
    #[cfg(target_os = "macos")]
    let modifier = Key::Meta;
    #[cfg(not(target_os = "macos"))]
    let modifier = Key::Control;

    enigo.key(modifier, Press).map_err(|err| err.to_string())?;
    enigo
        .key(Key::Unicode('v'), Click)
        .map_err(|err| err.to_string())?;
    enigo.key(modifier, Release).map_err(|err| err.to_string())?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn trigger_paste_shortcut(app: &AppHandle) -> Result<(), String> {
    let (sender, receiver) = mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = sender.send(send_paste_shortcut());
    })
    .map_err(|err| err.to_string())?;

    receiver
        .recv()
        .map_err(|err| err.to_string())?
}

#[cfg(not(target_os = "macos"))]
fn trigger_paste_shortcut(_app: &AppHandle) -> Result<(), String> {
    send_paste_shortcut()
}

fn open_external_url_blocking(url: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let status = Command::new("open")
        .arg(url)
        .status()
        .map_err(|err| err.to_string())?;

    #[cfg(target_os = "linux")]
    let status = Command::new("xdg-open")
        .arg(url)
        .status()
        .map_err(|err| err.to_string())?;

    #[cfg(target_os = "windows")]
    let status = Command::new("rundll32")
        .arg("url.dll,FileProtocolHandler")
        .arg(url)
        .status()
        .map_err(|err| err.to_string())?;

    if status.success() {
        Ok(())
    } else {
        Err(format!("Failed to open URL (exit status: {status})"))
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            if let Some(main_window) = app.get_webview_window("main") {
                main_window.set_theme(Some(Theme::Dark))?;
                main_window.set_background_color(Some(DESKTOP_WINDOW_BACKGROUND_COLOR))?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            copy_text_to_clipboard,
            paste_text_into_active_app,
            open_external_url
        ])
        .run(tauri::generate_context!())
        .expect("error while running vxbeamer desktop");
}
