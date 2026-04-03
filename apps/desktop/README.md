# vxbeamer Desktop

This app is a Tauri desktop app with a React frontend.

## Prerequisites

Install these first:

- Vite+ (`vp`) available on your `PATH`
- Node.js 22.12 or newer
- Rust via `rustup`

You can verify the Node.js requirement in the repository root `package.json`.

## Install dependencies

From the repository root:

```bash
cd /path/to/vxbeamer
vp install
```

## Run in development

From the desktop app directory:

```bash
cd /path/to/vxbeamer/apps/desktop
vp exec tauri dev
```

This command will:

- start the frontend dev server
- compile the Rust/Tauri native shell
- open the desktop app

## Build a production app

From the desktop app directory:

```bash
cd /path/to/vxbeamer/apps/desktop
vp exec tauri build
```

Build outputs are written under:

```text
apps/desktop/src-tauri/target/release/bundle/
```

## macOS

### First-time setup

Install Xcode Command Line Tools:

```bash
xcode-select --install
```

Install Rust:

```bash
curl https://sh.rustup.rs -sSf | sh
```

Make sure `vp` is installed and available on your `PATH`.

```bash
vp --version
```

### Run on macOS

```bash
cd /path/to/vxbeamer
vp install
cd apps/desktop
vp exec tauri dev
```

### Open the built app

After `vp exec tauri build`, the app bundle should be under:

```text
apps/desktop/src-tauri/target/release/bundle/macos/
```

You can open the generated `.app` bundle from Finder, or from Terminal:

```bash
open "/path/to/vxbeamer/apps/desktop/src-tauri/target/release/bundle/macos/vxbeamer Desktop.app"
```

### If macOS blocks the app

If Gatekeeper blocks the unsigned app, right-click it in Finder and choose **Open**, or run:

```bash
xattr -dr com.apple.quarantine "/path/to/vxbeamer/apps/desktop/src-tauri/target/release/bundle/macos/vxbeamer Desktop.app"
```

## Windows

### First-time setup

Install:

- Microsoft Visual Studio C++ Build Tools or Visual Studio with the **Desktop development with C++** workload
- WebView2 (usually already installed on current Windows versions)
- Rust via `rustup`
- Node.js 22.12 or newer

Make sure `vp` is installed and available on your `PATH`.

```powershell
vp --version
```

### Run on Windows

In PowerShell:

```powershell
cd C:\path\to\vxbeamer
vp install
cd apps\desktop
vp exec tauri dev
```

### Build on Windows

```powershell
cd C:\path\to\vxbeamer\apps\desktop
vp exec tauri build
```

The Windows bundle should be under `apps\desktop\src-tauri\target\release\bundle\`.

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/)
- [Tauri VS Code extension](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode)
- [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
