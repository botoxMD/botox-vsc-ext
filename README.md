# Botox VS Code Extension

[![VS Code Extension](https://img.shields.io/badge/VS%20Code-Extension-007acc.svg?logo=visual-studio-code)](https://github.com/botoxMD/botox-vsc-ext)
[![Typescript](https://img.shields.io/badge/Language-TypeScript-3178c6.svg?logo=typescript)](https://www.typescriptlang.org/)
[![CLI Companion](https://img.shields.io/badge/Companion-Botox%20CLI-dea584.svg)](https://github.com/botoxMD/botox-cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Live vector preview and typesetting for Markdown documents and slide decks using [Botox](https://github.com/botoxMD/botox-cli).

## Zero-Friction Setup (Automatic Backend Installation)

**No manual prerequisites required.** When you install the extension, it automatically downloads, verifies, and configures the matching pre-built [Botox CLI](https://github.com/botoxMD/botox-cli) binary for your operating system and architecture (`x86_64` and `aarch64` for Linux, macOS, and Windows).

- **Automatic Updates**: When the extension updates or when a newer compiler backend is released, it automatically keeps your compiler synchronized.
- **Manual Control**: You can manually check or reinstall the compiler backend anytime via `Ctrl+Shift+P` -> `Botox: Download / Update Compiler Backend`.
- **Custom Executables**: If you prefer building from source or using a custom build, set `botox.executablePath` in your VS Code Settings.

## Features

- **Side-by-Side Live Vector Preview**: Renders pages directly beside your active Markdown document with vector SVG scaling.
- **Real-Time Follow Cursor & Synchronized Scroll**: Automatically centers the preview on your active editing position, tracking headings, title blocks, and sections.
- **Fast Live Typesetting**: Recompiles as you type with automatic debouncing and in-flight process cancellation.
- **Smart Page Diffing**: Updates only pages that changed to eliminate layout jumping.
- **Preview Controls**: Zoom in/out, fit to width, page navigation, and document theme switching.
- **Direct PDF Export**: Export publication-grade PDFs to disk with a single click (`Ctrl+Shift+P` -> `Botox: Compile to PDF`).
- **Template Scaffolding**: Quick commands to initialize documents (`botox.initDocument`) and slide decks (`botox.initSlides`).

## Installation

Until published to the VS Code Marketplace, you can install the extension `.vsix` package:

### Method 1: Using the VS Code UI
1. Open VS Code.
2. Go to the Extensions view (`Ctrl+Shift+X` or `Cmd+Shift+X`).
3. Click the `...` (Views and More Actions) menu at the top of the Extensions pane.
4. Select **Install from VSIX...** and choose the `botox-*.vsix` file.

### Method 2: Using the Command Line
If the `code` CLI is in your system `PATH`:
```bash
code --install-extension botox-0.14.5.vsix
```
*(If `code` is not recognized in your terminal, use Method 1 above, or in VS Code press `F1` and run `Shell Command: Install 'code' command in PATH`.)*

## Getting Started

1. Open any Markdown file (`.md`).
2. Click the **Botox Preview** button in the top-right editor title bar, or press `Ctrl+K V` (`Cmd+K V` on macOS).
3. The preview will automatically render and synchronize as you write.

## Commands

| Command | Title | Shortcut |
| :--- | :--- | :--- |
| `botox.openPreview` | Botox: Open Live PDF Preview | `Ctrl+K V` / `Cmd+K V` |
| `botox.compilePdf` | Botox: Compile to PDF | `Ctrl+Alt+B` / `Cmd+Alt+B` |
| `botox.exportMarkdown` | Botox: Export to Normal Markdown | - |
| `botox.downloadBackend` | Botox: Download / Update Compiler Backend | - |
| `botox.initDocument` | Botox: Initialize New Document | - |
| `botox.initSlides` | Botox: Initialize Slide Deck | - |
| `botox.toggleSyncScroll` | Botox: Toggle Follow Cursor / Sync Scroll | - |
| `botox.setup` | Botox: Configure Defaults (Setup Wizard) | - |

## Settings

| Setting | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `botox.executablePath` | string | `botox` | Path to the `botox` CLI binary (checks custom path, extension storage, `~/.local/bin`, or `PATH`) |
| `botox.autoDownloadBackend` | boolean | `true` | Automatically download and manage the pre-built compiler backend when missing or outdated |
| `botox.autoCompileOnSave` | boolean | `true` | Automatically compile and update the preview whenever the file is saved |
| `botox.autoCompileOnChange` | boolean | `true` | Update the live preview on text changes before saving |
| `botox.debounceDelay` | number | `120` | Delay in milliseconds to wait after the last keystroke before recompiling |
| `botox.syncScroll` | boolean | `true` | Automatically synchronize preview scroll position to follow editor cursor |

## License

This project is licensed under the [MIT License](LICENSE).

