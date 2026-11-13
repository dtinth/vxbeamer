//! vxbeamer for the Linux desktop: bind `vxbeamer-linux toggle` to a global
//! shortcut, press it to start listening, press it again to stop — the
//! transcript lands on the clipboard, like the Android app's tile.

mod capture;
mod config;
mod desktop;
mod events;
mod lock;
mod pairing;
mod session;
mod urls;

use std::process::ExitCode;

const USAGE: &str = "\
vxbeamer-linux — toggle voice transcription from a global shortcut

USAGE:
    vxbeamer-linux pair <link>   Sign in with a link from your backend's /pair page
    vxbeamer-linux toggle        Start listening, or stop and copy the transcript
    vxbeamer-linux start         Start listening (no-op if already listening)
    vxbeamer-linux stop          Stop listening (no-op if not listening)
    vxbeamer-linux doctor        Check that everything needed is in place

Bind `vxbeamer-linux toggle` to a key in System Settings → Keyboard →
Shortcuts → Add New → Command or Script.
";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.first().map(String::as_str) {
        Some("pair") => match args.get(1) {
            Some(link) => pair(link),
            None => Err("usage: vxbeamer-linux pair <link>".into()),
        },
        Some("toggle") => toggle(true, true),
        Some("start") => toggle(true, false),
        Some("stop") => toggle(false, true),
        Some("doctor") => doctor(),
        Some("-h" | "--help" | "help") => {
            print!("{USAGE}");
            Ok(())
        }
        _ => {
            eprint!("{USAGE}");
            return ExitCode::from(2);
        }
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("vxbeamer: {e}");
            ExitCode::FAILURE
        }
    }
}

fn toggle(may_start: bool, may_stop: bool) -> Result<(), String> {
    if let Some(pid) = lock::running_pid() {
        if may_stop {
            if unsafe { libc::kill(pid, libc::SIGUSR1) } != 0 {
                return Err(format!("could not signal the recording (pid {pid})"));
            }
            eprintln!("vxbeamer: stopping");
        }
        return Ok(());
    }
    if !may_start {
        return Ok(());
    }
    session::run(lock::Lock::acquire()?)
}

fn pair(input: &str) -> Result<(), String> {
    let link = pairing::parse_link(input).ok_or(
        "That is not a pairing link. Open /pair on your backend and copy the link it shows \
         (it looks like https://your-backend/pair#XXXX-XXXX-XXXX).",
    )?;
    let url = urls::endpoint(&link.backend_url, "/auth/pair").ok_or("invalid backend URL")?;
    let tokens = config::post_json(&url, serde_json::json!({ "code": link.code }))
        .map_err(|e| format!("Pairing failed: {e}"))?;
    // Keep the local preferences (recorder, configuration) across re-pairing.
    let mut config = config::Config::load().unwrap_or_default();
    config.backend_url = link.backend_url.clone();
    config.refresh_token.clear();
    config.save_tokens(tokens)?;
    if config.refresh_token.is_empty() {
        return Err("The backend did not return a refresh token".into());
    }
    println!(
        "Paired with {}. Config saved to {}",
        link.backend_url,
        config::config_path().display()
    );
    Ok(())
}

fn doctor() -> Result<(), String> {
    let mut ok = true;
    let mut check = |label: &str, result: Result<String, String>| match result {
        Ok(detail) => println!("✓ {label}: {detail}"),
        Err(detail) => {
            ok = false;
            println!("✗ {label}: {detail}");
        }
    };

    let config = config::Config::load();
    check(
        "Paired",
        config
            .as_ref()
            .map(|c| c.backend_url.clone())
            .map_err(Clone::clone),
    );
    if let Ok(mut config) = config.clone() {
        check(
            "Session",
            config
                .current_access_token()
                .map(|_| "token is valid".into()),
        );
    }
    let configured = config.as_ref().ok().and_then(|c| c.record_command.clone());
    check(
        "Recorder",
        capture::recorder(configured.as_ref()).map(|command| command.join(" ")),
    );

    let clipboard_tools: Vec<&str> = ["wl-copy", "xclip", "xsel"]
        .into_iter()
        .filter(|tool| capture::find_in_path(tool).is_some())
        .collect();
    let klipper = zbus::blocking::Connection::session()
        .ok()
        .and_then(|bus| {
            zbus::blocking::fdo::DBusProxy::new(&bus)
                .ok()?
                .name_has_owner("org.kde.klipper".try_into().ok()?)
                .ok()
        })
        .unwrap_or(false);
    check(
        "Clipboard",
        match (klipper, clipboard_tools.is_empty()) {
            (true, _) => Ok("Klipper (D-Bus)".into()),
            (false, false) => Ok(clipboard_tools.join(", ")),
            (false, true) => {
                Err("no Klipper on D-Bus and none of wl-copy, xclip, xsel installed".into())
            }
        },
    );
    if ok {
        Ok(())
    } else {
        Err("some checks failed".into())
    }
}
