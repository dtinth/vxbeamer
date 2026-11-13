# vxbeamer for Linux

A small native program (Rust, no webview) that brings the Android app's
toggle to the Linux desktop. Bind it to a global shortcut. The first press starts
listening. The second press stops it, waits for the transcript and copies it
to the clipboard. A desktop notification shows what it is hearing while it works.

It is designed for KDE Plasma (X11 and Wayland), but works on any desktop
with a freedesktop notification server and a clipboard tool.

## How it works

`vxbeamer-linux toggle` is the whole interface:

- **Nothing running →** it becomes the recorder. It pipes the default microphone
  (via `parecord`, or `arecord` as a fallback) into the backend's `/ws` as 16 kHz
  mono PCM, the same wire format the web and Android apps use, and watches
  `/sse` for its own transcript.
- **Already running →** it sends the running recorder `SIGUSR1` and exits.
  The recorder turns the mic off, waits for the final transcript, puts it on
  the clipboard and shows it in a notification.

Pressing the shortcut again while a transcript is still on its way starts a
new recording, as the Android tile does.

The clipboard goes through Klipper over D-Bus when it is there (always, on
Plasma). Otherwise it uses `wl-copy`, `xclip` or `xsel`. The transcript is
also printed to stdout, so the command works in scripts too.

## Install

You need a Rust toolchain (<https://rustup.rs>). No system libraries are
needed to build it.

```bash
cd apps/linux
cargo build --release
install -Dm755 target/release/vxbeamer-linux ~/.local/bin/vxbeamer-linux
install -Dm644 vxbeamer-linux.desktop ~/.local/share/applications/vxbeamer-linux.desktop
```

A prebuilt x86_64 binary is also attached to each run of the
[Build Linux](../../.github/workflows/linux.yml) workflow.

At runtime it needs a recorder. Plasma installs usually have one already:

| Distro          | Package                     |
| --------------- | --------------------------- |
| Debian / Ubuntu | `pulseaudio-utils`          |
| Fedora          | `pulseaudio-utils`          |
| Arch            | `libpulse`                  |

## Pair

1. Open `/pair` on your backend in a browser and sign in.
2. Copy the pairing link it shows, then run:

```bash
vxbeamer-linux pair 'https://your-backend.example.com/pair#XXXX-XXXX-XXXX'
```

The backend URL and tokens are saved to `~/.config/vxbeamer/linux.json`
(mode 0600) and refreshed automatically. Run `vxbeamer-linux doctor` to
check everything is in place.

## Bind a shortcut in KDE Plasma

System Settings → Keyboard → Shortcuts → **Add New** → **Application…**.
Pick **vxbeamer: Toggle transcription** (from the `.desktop` file installed
above) and assign a key, e.g. <kbd>Meta</kbd>+<kbd>H</kbd>.

Without the `.desktop` file, use **Add New → Command or Script…** and enter
the full path, `~/.local/bin/vxbeamer-linux toggle`. Shortcuts do not run
through your shell profile, so a bare name only works if `~/.local/bin`
is on the session's `PATH`.

## Commands

| Command                        | What it does                                         |
| ------------------------------ | ---------------------------------------------------- |
| `vxbeamer-linux toggle`        | Start listening, or stop and copy the transcript     |
| `vxbeamer-linux start`         | Start listening (does nothing if already listening)  |
| `vxbeamer-linux stop`          | Stop listening (does nothing if not listening)       |
| `vxbeamer-linux pair <link>`   | Sign in with a pairing link                          |
| `vxbeamer-linux doctor`        | Check pairing, session, recorder and clipboard       |

`start` and `stop` suit push-to-talk setups that can run one command on key
press and another on release.

## Options

Optional keys in `~/.config/vxbeamer/linux.json`:

| Key             | Meaning                                                                                                                             |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `recordCommand` | Recorder argv, e.g. `["parecord", "--device=my-mic", "--raw", "--format=s16le", "--channels=1", "--rate=16000"]` to pick a microphone other than the default (`pactl list short sources` lists them). It must write raw 16 kHz mono s16le PCM to stdout. |
| `configuration` | ASR configuration id from `/asr/configurations`; the backend's default when unset.                                                  |

Re-pairing keeps both.

## Development

```bash
cargo test
cargo clippy
```
