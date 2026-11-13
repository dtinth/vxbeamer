//! Microphone capture, by running whichever recorder the system has.
//!
//! The backend wants raw 16 kHz mono signed 16-bit little-endian PCM, the
//! same as the web app sends. Every Linux audio stack ships a command that
//! produces exactly that on stdout and does the resampling in the sound
//! server, so there is no audio library linked in here and no device
//! selection to get wrong: the default source is whatever the desktop's
//! own sound settings say it is.

use std::path::PathBuf;

pub const SAMPLE_RATE: u32 = 16_000;

fn known_recorders() -> Vec<Vec<String>> {
    let rate = SAMPLE_RATE.to_string();
    let v = |args: &[&str]| args.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    vec![
        // PulseAudio API — served by pipewire-pulse on Plasma 6. (Not
        // pw-record: what it writes to stdout differs between versions —
        // `--raw` only exists in newer ones.)
        v(&[
            "parecord",
            "--raw",
            "--format=s16le",
            "--channels=1",
            &format!("--rate={rate}"),
        ]),
        // ALSA — through pipewire-alsa or pulse's ALSA plugin when present.
        v(&[
            "arecord", "-q", "-t", "raw", "-f", "S16_LE", "-c", "1", "-r", &rate,
        ]),
    ]
}

pub fn find_in_path(program: &str) -> Option<PathBuf> {
    if program.contains('/') {
        let path = PathBuf::from(program);
        return path.is_file().then_some(path);
    }
    std::env::split_paths(&std::env::var_os("PATH")?)
        .map(|dir| dir.join(program))
        .find(|path| path.is_file())
}

/// The configured recorder, or the first known one that is installed.
pub fn recorder(configured: Option<&Vec<String>>) -> Result<Vec<String>, String> {
    if let Some(command) = configured.filter(|c| !c.is_empty()) {
        return Ok(command.clone());
    }
    known_recorders()
        .into_iter()
        .find(|command| find_in_path(&command[0]).is_some())
        .ok_or_else(|| {
            "No audio recorder found. Install one of: parecord (pulseaudio-utils / libpulse) \
             or arecord (alsa-utils)"
                .into()
        })
}
