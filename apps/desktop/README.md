# vxbeamer Desktop

This app is a Tauri desktop app with a React frontend.

## Prerequisites

Install these first:

- Node.js 22.12 or newer
- Rust via `rustup`
- `corepack`

You can verify the Node.js requirement in `/home/runner/work/vxbeamer/vxbeamer/package.json`.

## Install dependencies

From the repository root:

```bash
cd /home/runner/work/vxbeamer/vxbeamer
corepack pnpm install
```

## Run in development

From the desktop app directory:

```bash
cd /home/runner/work/vxbeamer/vxbeamer/apps/desktop
corepack pnpm exec tauri dev
```

This command will:

- start the frontend dev server
- compile the Rust/Tauri native shell
- open the desktop app

## Build a production app

From the desktop app directory:

```bash
cd /home/runner/work/vxbeamer/vxbeamer/apps/desktop
corepack pnpm exec tauri build
```

Build outputs are written under:

```text
/home/runner/work/vxbeamer/vxbeamer/apps/desktop/src-tauri/target/release/bundle/
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

Enable Corepack if needed:

```bash
corepack enable
```

### Run on macOS

```bash
cd /home/runner/work/vxbeamer/vxbeamer
corepack pnpm install
cd /home/runner/work/vxbeamer/vxbeamer/apps/desktop
corepack pnpm exec tauri dev
```

### Open the built app

After `corepack pnpm exec tauri build`, the app bundle should be under:

```text
/home/runner/work/vxbeamer/vxbeamer/apps/desktop/src-tauri/target/release/bundle/macos/
```

You can open the generated `.app` bundle from Finder, or from Terminal:

```bash
open "/home/runner/work/vxbeamer/vxbeamer/apps/desktop/src-tauri/target/release/bundle/macos/vxbeamer Desktop.app"
```

### If macOS blocks the app

If Gatekeeper blocks the unsigned app, right-click it in Finder and choose **Open**, or run:

```bash
xattr -dr com.apple.quarantine "/home/runner/work/vxbeamer/vxbeamer/apps/desktop/src-tauri/target/release/bundle/macos/vxbeamer Desktop.app"
```

## Windows

### First-time setup

Install:

- Microsoft Visual Studio C++ Build Tools or Visual Studio with the **Desktop development with C++** workload
- WebView2 (usually already installed on current Windows versions)
- Rust via `rustup`
- Node.js 22.12 or newer

Enable Corepack if needed:

```powershell
corepack enable
```

### Run on Windows

In PowerShell:

```powershell
cd C:\path\to\vxbeamer
corepack pnpm install
cd apps\desktop
corepack pnpm exec tauri dev
```

### Build on Windows

```powershell
cd C:\path\to\vxbeamer\apps\desktop
corepack pnpm exec tauri build
```

The Windows bundle should be under `apps\desktop\src-tauri\target\release\bundle\`.

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/)
- [Tauri VS Code extension](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode)
- [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
