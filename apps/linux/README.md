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

### With mise (recommended)

Releases are static binaries for x86_64 and arm64, signed with
[packslip](https://packslip.dev). [mise](https://mise.jdx.dev) 2026.9.2 or
newer checks the signature before it installs anything:

```bash
mise use -g packslip:github.com/dtinth/vxbeamer/apps/linux
```

Upgrade later with `mise upgrade`. `mise which vxbeamer-linux` prints the
binary's path, which you need for the keyboard shortcut. `latest` skips
releases younger than 24 hours, so name an exact version (`…/apps/linux@1.2.3`)
to get one straight away.

The `.desktop` file ships inside the archive. Copy it into
`~/.local/share/applications/` and change its `Exec=` line to the full path
from `mise which`.

### Without mise

Download `vxbeamer-linux-<version>-linux-x64-musl.tar.gz` (or `-arm64-`) from
a [`linux-v*` release](https://github.com/dtinth/vxbeamer/releases). Extract it,
then put `vxbeamer-linux` on your `PATH`, for example in `~/.local/bin`. You can
check the download with `packslip verify packslip.apps-linux.sigstore.json
--artifact <archive>`.

### From source

You need a Rust toolchain (<https://rustup.rs>). No system libraries are
needed to build it.

```bash
cd apps/linux
cargo build --release
install -Dm755 target/release/vxbeamer-linux ~/.local/bin/vxbeamer-linux
install -Dm644 vxbeamer-linux.desktop ~/.local/share/applications/vxbeamer-linux.desktop
```

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

## Releasing

Each changesets release also publishes `linux-v<version>`, through the
`publish-linux` job in `.github/workflows/publish.yml`. To make a release by
hand, or a test release, push a tag:

```bash
git tag linux-v1.2.3-test.1 && git push origin linux-v1.2.3-test.1
```

A version with a `-` suffix is a prerelease. mise installs it only when it is
asked for by exact version. The `linux-` prefix is required: packslip finds a
monorepo tool's versions only from tags prefixed with its subpath, its last
segment or the repository name, so the changesets tag (`vxasr@…`) would be
invisible to it.
