//! "Is a recording already running?" — the one question `toggle` has to
//! answer. The running recorder writes its pid to a file in the runtime
//! directory; a second `toggle` finds it there and signals it to stop.

use std::{fs, io::Write, path::PathBuf};

pub fn lock_path() -> PathBuf {
    match std::env::var_os("XDG_RUNTIME_DIR").filter(|v| !v.is_empty()) {
        Some(dir) => PathBuf::from(dir).join("vxbeamer-linux.pid"),
        None => {
            std::env::temp_dir().join(format!("vxbeamer-linux-{}.pid", unsafe { libc::getuid() }))
        }
    }
}

/// The pid of a live recorder, if there is one. A pid file left behind by a
/// crash — or whose pid now belongs to some other program — does not count.
pub fn running_pid() -> Option<i32> {
    let pid: i32 = fs::read_to_string(lock_path()).ok()?.trim().parse().ok()?;
    if pid <= 0 || pid == std::process::id() as i32 {
        return None;
    }
    if unsafe { libc::kill(pid, 0) } != 0 {
        return None;
    }
    // The process name, not the executable path: `/proc/<pid>/exe` is not
    // always readable, and "can't tell" must not count as "still running" —
    // that would leave every toggle a silent no-op until a reboot.
    let comm = |p: &str| fs::read_to_string(format!("/proc/{p}/comm")).ok();
    match (comm(&pid.to_string()), comm("self")) {
        (Some(theirs), Some(ours)) if theirs == ours => {}
        (_, None) => {} // no /proc at all: trust kill(0)
        _ => return None,
    }
    Some(pid)
}

pub struct Lock {
    path: PathBuf,
    held: bool,
}

impl Lock {
    /// Claims the pid file. Fails if another recorder got there first.
    pub fn acquire() -> Result<Lock, String> {
        let path = lock_path();
        for _ in 0..2 {
            match fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
            {
                Ok(mut file) => {
                    write!(file, "{}", std::process::id()).map_err(|e| e.to_string())?;
                    return Ok(Lock { path, held: true });
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    if running_pid().is_some() {
                        return Err("another recording is already running".into());
                    }
                    let _ = fs::remove_file(&path); // stale
                }
                Err(e) => return Err(format!("could not create {}: {e}", path.display())),
            }
        }
        Err(format!("could not claim {}", path.display()))
    }

    /// Lets the next `toggle` start a new recording, even while this one is
    /// still waiting for its transcript.
    pub fn release(&mut self) {
        if self.held {
            self.held = false;
            if fs::read_to_string(&self.path)
                .ok()
                .as_deref()
                .map(str::trim)
                == Some(&std::process::id().to_string())
            {
                let _ = fs::remove_file(&self.path);
            }
        }
    }
}

impl Drop for Lock {
    fn drop(&mut self) {
        self.release();
    }
}
