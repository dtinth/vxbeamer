use enigo::{
    Direction::{Click, Press, Release},
    Enigo, Key, Keyboard, Settings,
};
use std::{thread, time::Duration};
use tauri::{image::Image, AppHandle};
use tauri_plugin_clipboard_manager::ClipboardExt;

const PASTE_RESTORE_DELAY_MS: u64 = 150;

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

        let paste_result = send_paste_shortcut();
        thread::sleep(Duration::from_millis(PASTE_RESTORE_DELAY_MS));
        let restore_result = restore_clipboard(&app, snapshot);

        paste_result?;
        restore_result
    })
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(tauri::generate_handler![
            copy_text_to_clipboard,
            paste_text_into_active_app
        ])
        .run(tauri::generate_context!())
        .expect("error while running vxbeamer desktop");
}
