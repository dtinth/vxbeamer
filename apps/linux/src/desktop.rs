//! The desktop integrations: notifications and the clipboard, over the
//! session D-Bus where possible so nothing extra needs installing on KDE.

use std::{
    collections::HashMap,
    io::Write,
    process::{Command, Stdio},
    sync::OnceLock,
};
use zbus::{blocking::Connection, zvariant::Value};

fn session_bus() -> Option<&'static Connection> {
    static BUS: OnceLock<Option<Connection>> = OnceLock::new();
    BUS.get_or_init(|| Connection::session().ok()).as_ref()
}

/// One notification that is updated in place as the session goes on
/// (Listening… → partial text → the transcript), rather than a stack of them.
#[derive(Default)]
pub struct Notifier {
    id: u32,
}

pub enum Urgency {
    Low = 0,
    Normal = 1,
    Critical = 2,
}

impl Notifier {
    /// Shows or replaces the notification. `timeout_ms` of 0 keeps it up
    /// until replaced. Failures are not fatal: the clipboard is the point.
    pub fn show(
        &mut self,
        summary: &str,
        body: &str,
        icon: &str,
        urgency: Urgency,
        timeout_ms: i32,
    ) {
        let Some(bus) = session_bus() else { return };
        let mut hints: HashMap<&str, Value> = HashMap::new();
        hints.insert("urgency", Value::U8(urgency as u8));
        // Progress chatter has no business in the notification history.
        hints.insert("transient", Value::Bool(timeout_ms == 0));
        hints.insert("desktop-entry", Value::Str("vxbeamer-linux".into()));
        let actions: Vec<&str> = vec![];
        let reply = bus.call_method(
            Some("org.freedesktop.Notifications"),
            "/org/freedesktop/Notifications",
            Some("org.freedesktop.Notifications"),
            "Notify",
            &(
                "vxbeamer", self.id, icon, summary, body, actions, hints, timeout_ms,
            ),
        );
        match reply.and_then(|m| m.body().deserialize::<u32>()) {
            Ok(id) => self.id = id,
            Err(e) => eprintln!("vxbeamer: notification failed: {e}"),
        }
    }
}

/// Puts `text` on the clipboard. Returns how, for the log.
pub fn copy_to_clipboard(text: &str) -> Result<&'static str, String> {
    // Klipper first: it is part of Plasma (X11 and Wayland alike), and it
    // owns the selection itself, so this process can exit straight away.
    if let Some(bus) = session_bus() {
        let result = bus.call_method(
            Some("org.kde.klipper"),
            "/klipper",
            Some("org.kde.klipper.klipper"),
            "setClipboardContents",
            &(text,),
        );
        if result.is_ok() {
            return Ok("Klipper");
        }
    }

    let wayland = std::env::var_os("WAYLAND_DISPLAY").is_some_and(|v| !v.is_empty());
    let x11 = std::env::var_os("DISPLAY").is_some_and(|v| !v.is_empty());
    // Each of these forks a child that keeps serving the selection after
    // the command itself returns.
    let candidates: &[(&'static str, &[&str], bool)] = &[
        ("wl-copy", &[], wayland),
        ("xclip", &["-selection", "clipboard"], x11),
        ("xsel", &["--clipboard", "--input"], x11),
    ];
    for (program, args, applicable) in candidates {
        if !applicable {
            continue;
        }
        if pipe_into(program, args, text).is_ok() {
            return Ok(program);
        }
    }
    Err("no clipboard available (tried Klipper, wl-copy, xclip, xsel)".into())
}

fn pipe_into(program: &str, args: &[&str], text: &str) -> Result<(), String> {
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    child
        .stdin
        .take()
        .ok_or("no stdin")?
        .write_all(text.as_bytes())
        .map_err(|e| e.to_string())?;
    let status = child.wait().map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("{program} exited with {status}"))
    }
}
