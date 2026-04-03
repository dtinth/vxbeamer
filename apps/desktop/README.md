# vxbeamer Desktop

A Tauri-based desktop wrapper for the vxbeamer web app. It serves the built
website assets inside a native webview and adds desktop-specific features such
as acting on swipe events received from another device (copy to clipboard or
paste into the active application).

## Prerequisites

| Requirement                   | Notes                                                                                                                              |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **Node.js ≥ 20**              | Managed by `voidzero-dev/setup-vp` in CI; use [nvm](https://github.com/nvm-sh/nvm) or [fnm](https://github.com/Schniz/fnm) locally |
| **pnpm**                      | Enabled via `corepack enable pnpm`                                                                                                 |
| **Rust (stable)**             | Install from <https://rustup.rs/>                                                                                                  |
| **Platform system libraries** | See table below                                                                                                                    |

### Linux system libraries

```bash
sudo apt-get update
sudo apt-get install -y \
  pkg-config \
  libglib2.0-dev \
  libgtk-3-dev \
  libwebkit2gtk-4.1-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  libxdo-dev \
  libssl-dev
```

### macOS

No extra system libraries are required. Xcode Command Line Tools must be
installed (`xcode-select --install`).

### Windows

No extra system libraries are required. Make sure the
[Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
(or Visual Studio with the "Desktop development with C++" workload) are
installed.

## Development

Start the live-reloading development server (runs the website dev server and
opens the Tauri webview against it):

```bash
# From the repository root
corepack pnpm install           # install all workspace dependencies

# Then either:
corepack pnpm exec vp run desktop#dev
# or, from apps/desktop:
cd apps/desktop
corepack pnpm exec vp run website#dev   # in a separate terminal
node_modules/.bin/tauri dev
```

The website dev server listens on port **20470** (see `tauri.conf.json`).

## Building for production

From the **repository root**:

```bash
corepack pnpm install          # ensure all dependencies are installed
corepack pnpm exec vp run desktop#build
```

Or from the `apps/desktop` directory:

```bash
node scripts/prepare-web-assets.mjs   # builds the website and copies dist/
node_modules/.bin/tauri build
```

`prepare-web-assets.mjs` builds the website via `vp run website#build` and
copies the output into `apps/desktop/dist/`, which Tauri then bundles.

### Output bundles

| Platform              | Location                                    |
| --------------------- | ------------------------------------------- |
| Linux `.deb`          | `src-tauri/target/release/bundle/deb/`      |
| Linux `.AppImage`     | `src-tauri/target/release/bundle/appimage/` |
| macOS `.dmg`          | `src-tauri/target/release/bundle/dmg/`      |
| Windows `.msi`        | `src-tauri/target/release/bundle/msi/`      |
| Windows `.exe` (NSIS) | `src-tauri/target/release/bundle/nsis/`     |

## CI

The [Build Desktop](.github/workflows/desktop.yml) workflow builds the app on
all three platforms (Linux, macOS, Windows) on every push to `main` and on
pull requests. The resulting bundles are uploaded as GitHub Actions artifacts.
