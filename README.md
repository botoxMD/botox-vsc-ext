# Botox VS Code Extension

Official VS Code extension for [Botox](https://github.com/botoxMD/botox-cli) - Publication-grade Markdown typesetting and live preview powered by Typst.

## Features

- **Side-by-Side Live Vector Preview**: Render crystal-clear Typst-typeset pages right beside your active Markdown document with infinite vector clarity.
- **Embedded Standalone Compiler**: Includes the Botox native compiler out of the box with zero external dependencies (no Node, Python, TeX Live, or Pandoc needed). Automatically self-provisions prebuilt binaries on demand.
- **Real-Time Follow Cursor & Synchronized Scroll**: Automatically synchronizes and vertically centers the preview at your exact editing cursor location, seamlessly handling unnumbered headings, title blocks, and Table of Contents offsets.
- **Instant Live Typesetting**: Live compilation as you type with intelligent in-flight process cancellation and sub-second rendering.
- **Smart DOM Diffing**: Only re-renders changed pages in the preview, preserving scroll stability and eliminating browser layout thrashing.
- **Built-in Preview Controls**:
  - Zoom In (`Ctrl/Cmd + +`), Zoom Out (`Ctrl/Cmd + -`), Reset (`Ctrl/Cmd + 0`), and Fit to Width
  - Follow Cursor toggle button
  - Live compilation timing badge
- **Direct PDF Export**: Export publication-grade PDFs to disk alongside your Markdown file with a single click.
- **Template Scaffolding**: Quick commands to initialize documents and slide decks with standard settings.

## Getting Started

1. Open any Markdown file (`.md`).
2. Click the **Botox Preview** button in the top-right editor title bar, or press `Ctrl+K V` (`Cmd+K V` on macOS).
3. Start typing — the live preview compiles and centers automatically.

The extension bundles the standalone compiler natively, so no manual installation of Rust or Botox CLI is required.

## Commands

| Command | Title | Default Shortcut |
| :--- | :--- | :--- |
| `botox.openPreview` | Botox: Open Live PDF Preview | `Ctrl+K V` / `Cmd+K V` |
| `botox.compilePdf` | Botox: Compile to PDF | - |
| `botox.initDocument` | Botox: Initialize New Document | - |
| `botox.initSlides` | Botox: Initialize Slide Deck | - |
| `botox.toggleSyncScroll` | Botox: Toggle Follow Cursor / Sync Scroll | - |

## Settings

| Setting | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `botox.executablePath` | string | `botox` | Custom path to the `botox` binary (defaults to bundled binary, `~/.local/bin/botox`, or `PATH`) |
| `botox.autoCompileOnSave` | boolean | `true` | Automatically compile and update the preview whenever the file is saved |
| `botox.autoCompileOnChange` | boolean | `true` | Automatically update the live preview on text changes before saving |
| `botox.debounceDelay` | number | `120` | Delay in milliseconds to wait after the last keystroke before recompiling |
| `botox.syncScroll` | boolean | `true` | Automatically synchronize preview scroll and position to follow the editor cursor |
| `botox.bibliography` | boolean | `true` | Transform web links into an automatic IEEE-standard bibliography in documents |

## License

MIT License. See [LICENSE](LICENSE) for details.
