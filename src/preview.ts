import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { compileDocument, CompilationResult } from './compiler';

export class BotoxPreviewPanel {
    public static currentPanels: Map<string, BotoxPreviewPanel> = new Map();
    private readonly _panel: vscode.WebviewPanel;
    private readonly _documentUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];
    private _lastPdfBase64: string = '';
    private _isCompiling: boolean = false;
    private _pendingCompile: boolean = false;

    public static createOrShow(documentUri: vscode.Uri, viewColumn?: vscode.ViewColumn) {
        const key = documentUri.toString();
        const existing = BotoxPreviewPanel.currentPanels.get(key);

        if (existing) {
            existing._panel.reveal(viewColumn);
            return existing;
        }

        const column = viewColumn || vscode.ViewColumn.Beside;
        const panel = vscode.window.createWebviewPanel(
            'botoxPreview',
            `Preview: ${path.basename(documentUri.fsPath)}`,
            column,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.file(path.dirname(documentUri.fsPath))
                ]
            }
        );

        const previewPanel = new BotoxPreviewPanel(panel, documentUri);
        BotoxPreviewPanel.currentPanels.set(key, previewPanel);
        return previewPanel;
    }

    private constructor(panel: vscode.WebviewPanel, documentUri: vscode.Uri) {
        this._panel = panel;
        this._documentUri = documentUri;

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        this._panel.webview.onDidReceiveMessage(
            message => {
                switch (message.command) {
                    case 'refresh':
                        this.update();
                        return;
                    case 'exportPdf':
                        vscode.commands.executeCommand('botox.compilePdf', this._documentUri);
                        return;
                }
            },
            null,
            this._disposables
        );

        this.update();
    }

    public async update() {
        if (this._isCompiling) {
            this._pendingCompile = true;
            return;
        }

        this._isCompiling = true;
        this._panel.webview.postMessage({ type: 'status', message: 'Compiling with Botox...' });

        try {
            const result: CompilationResult = await compileDocument(this._documentUri.fsPath);

            if (result.success && result.pdfBytes) {
                const base64 = Buffer.from(result.pdfBytes).toString('base64');
                this._lastPdfBase64 = base64;
                this._panel.title = `Preview: ${path.basename(this._documentUri.fsPath)}`;
                this._panel.webview.html = this._getHtmlForWebview(base64, result.durationMs);
            } else {
                this._panel.webview.postMessage({
                    type: 'error',
                    message: result.error || 'Unknown compilation error'
                });
            }
        } catch (e: any) {
            this._panel.webview.postMessage({
                type: 'error',
                message: e.message || String(e)
            });
        } finally {
            this._isCompiling = false;
            if (this._pendingCompile) {
                this._pendingCompile = false;
                this.update();
            }
        }
    }

    public dispose() {
        BotoxPreviewPanel.currentPanels.delete(this._documentUri.toString());
        this._panel.dispose();

        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }

    private _getHtmlForWebview(pdfBase64: string, durationMs?: number): string {
        const title = path.basename(this._documentUri.fsPath);
        const timingStr = durationMs ? `${durationMs}ms` : '';

        return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Botox Preview: ${title}</title>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
  <style>
    :root {
      --bg: var(--vscode-editor-background, #1e1e1e);
      --fg: var(--vscode-editor-foreground, #d4d4d4);
      --toolbar-bg: var(--vscode-editorGroupHeader-tabsBackground, #252526);
      --toolbar-border: var(--vscode-editorGroup-border, #333);
      --btn-bg: var(--vscode-button-secondaryBackground, #3a3d41);
      --btn-fg: var(--vscode-button-secondaryForeground, #ffffff);
      --btn-hover: var(--vscode-button-secondaryHoverBackground, #45494e);
      --badge-bg: var(--vscode-badge-background, #007acc);
      --badge-fg: var(--vscode-badge-foreground, #ffffff);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: var(--bg);
      color: var(--fg);
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    #toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 12px;
      background: var(--toolbar-bg);
      border-bottom: 1px solid var(--toolbar-border);
      font-size: 12px;
      user-select: none;
      z-index: 10;
    }
    .tool-group {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    button {
      background: var(--btn-bg);
      color: var(--btn-fg);
      border: none;
      padding: 4px 10px;
      border-radius: 3px;
      cursor: pointer;
      font-size: 11px;
      display: flex;
      align-items: center;
      gap: 4px;
    }
    button:hover { background: var(--btn-hover); }
    .badge {
      background: var(--badge-bg);
      color: var(--badge-fg);
      padding: 2px 6px;
      border-radius: 10px;
      font-size: 10px;
      font-weight: bold;
    }
    #status {
      font-size: 11px;
      opacity: 0.8;
    }
    #error-banner {
      display: none;
      background: #7f1d1d;
      color: #fecaca;
      padding: 8px 12px;
      font-family: monospace;
      font-size: 12px;
      border-bottom: 1px solid #b91c1c;
      white-space: pre-wrap;
    }
    #viewer-container {
      flex: 1;
      overflow-y: auto;
      overflow-x: auto;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 20px 10px;
      gap: 16px;
    }
    .page-container {
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35);
      border-radius: 2px;
      background: #ffffff;
      margin-bottom: 8px;
    }
    canvas {
      display: block;
    }
  </style>
</head>
<body>
  <div id="toolbar">
    <div class="tool-group">
      <button id="btn-refresh" title="Reload Preview">↻ Reload</button>
      <button id="btn-export" title="Compile PDF to file">Export PDF</button>
      <span class="badge">Botox</span>
    </div>
    <div class="tool-group">
      <button id="btn-zoom-out" title="Zoom Out">−</button>
      <span id="zoom-level">100%</span>
      <button id="btn-zoom-in" title="Zoom In">+</button>
      <button id="btn-zoom-fit" title="Fit Width">Fit</button>
    </div>
    <div class="tool-group">
      <span id="page-info">Pages: ...</span>
      <span id="timing">${timingStr}</span>
    </div>
  </div>

  <div id="error-banner"></div>
  <div id="viewer-container"></div>

  <script>
    const vscode = acquireVsCodeApi();
    const pdfData = atob("${pdfBase64}");
    let pdfDoc = null;
    let currentScale = 1.2;
    const container = document.getElementById('viewer-container');
    const zoomLabel = document.getElementById('zoom-level');
    const pageInfo = document.getElementById('page-info');
    const errorBanner = document.getElementById('error-banner');

    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

    async function loadPdf() {
      try {
        errorBanner.style.display = 'none';
        const loadingTask = pdfjsLib.getDocument({ data: pdfData });
        pdfDoc = await loadingTask.promise;
        pageInfo.textContent = pdfDoc.numPages + (pdfDoc.numPages === 1 ? ' page' : ' pages');
        renderAllPages();
      } catch (err) {
        showError('PDF rendering failed: ' + err.message);
      }
    }

    async function renderAllPages() {
      if (!pdfDoc) return;
      container.innerHTML = '';
      zoomLabel.textContent = Math.round(currentScale * 100) + '%';

      for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
        const page = await pdfDoc.getPage(pageNum);
        const viewport = page.getViewport({ scale: currentScale });

        const pageBox = document.createElement('div');
        pageBox.className = 'page-container';
        pageBox.id = 'page-' + pageNum;

        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        canvas.height = viewport.height;
        canvas.width = viewport.width;

        pageBox.appendChild(canvas);
        container.appendChild(pageBox);

        await page.render({
          canvasContext: context,
          viewport: viewport
        }).promise;
      }
    }

    function showError(msg) {
      errorBanner.textContent = msg;
      errorBanner.style.display = 'block';
    }

    document.getElementById('btn-zoom-in').addEventListener('click', () => {
      currentScale = Math.min(currentScale + 0.15, 3.0);
      renderAllPages();
    });

    document.getElementById('btn-zoom-out').addEventListener('click', () => {
      currentScale = Math.max(currentScale - 0.15, 0.4);
      renderAllPages();
    });

    document.getElementById('btn-zoom-fit').addEventListener('click', () => {
      currentScale = 1.0;
      renderAllPages();
    });

    document.getElementById('btn-refresh').addEventListener('click', () => {
      vscode.postMessage({ command: 'refresh' });
    });

    document.getElementById('btn-export').addEventListener('click', () => {
      vscode.postMessage({ command: 'exportPdf' });
    });

    window.addEventListener('message', event => {
      const message = event.data;
      if (message.type === 'error') {
        showError(message.message);
      }
    });

    loadPdf();
  </script>
</body>
</html>`;
    }
}
