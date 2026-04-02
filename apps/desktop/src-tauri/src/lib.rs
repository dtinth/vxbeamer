use std::{thread, time::Duration};

use arboard::{Clipboard, ImageData};
use enigo::{
    Direction::{Click, Press, Release},
    Enigo, Key, Keyboard, Settings,
};

#[derive(Debug)]
enum ClipboardSnapshot {
    Text(String),
    Image(ImageData<'static>),
    Unsupported,
}

#[tauri::command]
fn copy_text(text: String) -> Result<(), String> {
    let mut clipboard = Clipboard::new().map_err(|error| error.to_string())?;
    clipboard.set_text(text).map_err(|error| error.to_string())
}

#[tauri::command]
fn paste_text_with_restore(text: String) -> Result<(), String> {
    if text.is_empty() {
        return Ok(());
    }

    let snapshot = capture_clipboard();
    let mut clipboard = Clipboard::new().map_err(|error| error.to_string())?;
    clipboard
        .set_text(text.clone())
        .map_err(|error| error.to_string())?;
    drop(clipboard);

    simulate_paste()?;

    thread::spawn(move || {
        thread::sleep(Duration::from_millis(250));
        restore_clipboard_if_unchanged(snapshot, &text);
    });

    Ok(())
}

fn capture_clipboard() -> ClipboardSnapshot {
    let Ok(mut clipboard) = Clipboard::new() else {
        return ClipboardSnapshot::Unsupported;
    };

    if let Ok(text) = clipboard.get_text() {
        return ClipboardSnapshot::Text(text);
    }

    if let Ok(image) = clipboard.get_image() {
        return ClipboardSnapshot::Image(image);
    }

    ClipboardSnapshot::Unsupported
}

fn restore_clipboard_if_unchanged(snapshot: ClipboardSnapshot, temporary_text: &str) {
    let Ok(mut clipboard) = Clipboard::new() else {
        return;
    };

    let Ok(current_text) = clipboard.get_text() else {
        return;
    };
    if current_text != temporary_text {
        return;
    }

    match snapshot {
        ClipboardSnapshot::Text(text) => {
            let _ = clipboard.set_text(text);
        }
        ClipboardSnapshot::Image(image) => {
            let _ = clipboard.set_image(image);
        }
        ClipboardSnapshot::Unsupported => {}
    }
}

fn simulate_paste() -> Result<(), String> {
    let mut enigo = Enigo::new(&Settings::default()).map_err(|error| error.to_string())?;
    let modifier = paste_modifier_key();

    enigo
        .key(modifier, Press)
        .map_err(|error| error.to_string())?;
    enigo
        .key(Key::Unicode('v'), Click)
        .map_err(|error| error.to_string())?;
    enigo
        .key(modifier, Release)
        .map_err(|error| error.to_string())?;

    Ok(())
}

#[cfg(target_os = "macos")]
fn paste_modifier_key() -> Key {
    Key::Meta
}

#[cfg(not(target_os = "macos"))]
fn paste_modifier_key() -> Key {
    Key::Control
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![copy_text, paste_text_with_restore])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
