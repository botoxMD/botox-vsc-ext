# Botox VS Code Extension

Official VS Code extension for [Botox](https://github.com/botoxMD/botox-cli) - Modern, fast Markdown typesetting and PDF previewing powered by Typst.

## Features

- **Side-by-Side Live Preview**: Render high-fidelity Typst-typeset PDFs right beside your active Markdown document.
- **Embedded PDF Viewer**: Built-in canvas viewer powered by PDF.js with:
  - Zoom In, Zoom Out, Zoom Reset, and Fit to Width
  - Multi-page navigation (Next, Previous, Jump to Page)
  - Dark mode and light mode theme integration
  - Interactive error notifications showing compilation issues
- **Direct PDF Export**: Export compiled PDFs to disk alongside your Markdown file or custom build location.
- **Template Scaffolding**: Quick commands to initialize standard documents and slide decks with presets.
- **Configurable Auto-Refresh**: Live compile on save or debounced compilation on every keystroke.

## Requirements

The extension requires the Botox CLI binary installed on your system.

If not already installed, build or install `botox` from source or release:
```bash
git clone https://github.com/botoxMD/botox-cli.git
cd botox-cli
cargo build --release
cp target/release/botox ~/.local/bin/
```

Verify that `botox --version` works in your terminal.

## Commands

| Command | Title | Default Shortcut |
| :--- | :--- | :--- |
| `botox.openPreview` | Botox: Open Live PDF Preview | `Ctrl+K V` / `Cmd+K V` |
| `botox.compilePdf` | Botox: Compile to PDF | - |
| `botox.initDocument` | Botox: Initialize Markdown Document | - |
| `botox.initSlides` | Botox: Initialize Slide Deck | - |

You can also launch the preview from the top-right editor title bar button when viewing any `.md` file.

## Settings

| Setting | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `botox.executablePath` | string | `botox` | Path to the `botox` executable (or command name if in `PATH`) |
| `botox.autoCompileOnSave` | boolean | `true` | Automatically compile and update the preview whenever the file is saved |
| `botox.autoCompileOnChange` | boolean | `false` | Automatically compile and update the preview while typing |
| `botox.debounceDelay` | number | `800` | Delay in milliseconds before triggering compilation while typing |

## Development

1. Clone repository:
   ```bash
   git clone https://github.com/botoxMD/botox-vsc-ext.git
   cd botox-vsc-ext
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Compile extension:
   ```bash
   npm run compile
   ```
4. Package VSIX package:
   ```bash
   npx @vscode/vsce package
   ```

To test locally in VS Code, press `F5` to open an Extension Development Host window.

## License

MIT License. See [LICENSE](LICENSE) for details.
