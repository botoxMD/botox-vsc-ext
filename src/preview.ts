import * as vscode from 'vscode';
import * as path from 'path';
import { abortActivePreview, compileForPreview, VectorCompilationResult, VectorHeadingInfo } from './compiler';
import { reportCompilationSuccess, reportCompilationFailure } from './extension';

export class BotoxPreviewPanel {
    public static currentPanels: Map<string, BotoxPreviewPanel> = new Map();
    private readonly _panel: vscode.WebviewPanel;
    private readonly _documentUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];
    private _isCompiling: boolean = false;
    private _pendingCompile: boolean = false;
    private _pendingContent?: string;
    private _htmlInitialized: boolean = false;
    private _lastHeadings: VectorHeadingInfo[] = [];
    private _lastNumPages: number = 0;
    private _activeDocumentTheme: string = 'academic';
    private _isSlides: boolean = false;

    public static get(documentUri: vscode.Uri): BotoxPreviewPanel | undefined {
        const direct = BotoxPreviewPanel.currentPanels.get(documentUri.toString());
        if (direct) return direct;
        for (const panel of BotoxPreviewPanel.currentPanels.values()) {
            if (panel._documentUri.fsPath === documentUri.fsPath) {
                return panel;
            }
        }
        return undefined;
    }

    public static createOrShow(documentUri: vscode.Uri, viewColumn?: vscode.ViewColumn) {
        const key = documentUri.toString();
        const existing = BotoxPreviewPanel.get(documentUri);

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

    public static revive(panel: vscode.WebviewPanel, documentUri: vscode.Uri): BotoxPreviewPanel {
        const key = documentUri.toString();
        const existing = BotoxPreviewPanel.get(documentUri);
        if (existing) {
            existing._panel.dispose();
        }

        panel.title = `Preview: ${path.basename(documentUri.fsPath)}`;
        panel.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.file(path.dirname(documentUri.fsPath))
            ]
        };

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
                    case 'changeDocumentTheme':
                        if (message.theme && typeof message.theme === 'string') {
                            this._activeDocumentTheme = message.theme;
                            this._updateDocumentFrontmatterTheme(message.theme);
                            this.update();
                        }
                        return;
                    case 'toggleDocumentSlides':
                        if (typeof message.isSlides === 'boolean') {
                            this._updateDocumentFrontmatterSlides(message.isSlides);
                            this.update();
                        }
                        return;
                    case 'exportPdf':
                        vscode.commands.executeCommand('botox.compilePdf', this._documentUri, this._activeDocumentTheme);
                        return;
                    case 'installBinary':
                        vscode.env.openExternal(vscode.Uri.parse('https://github.com/botoxMD/botox-cli'));
                        return;
                    case 'openSettings':
                        vscode.commands.executeCommand('workbench.action.openSettings', 'botox.executablePath');
                        return;
                    case 'toggleSyncScroll': {
                        const config = vscode.workspace.getConfiguration('botox');
                        const current = config.get<boolean>('syncScroll', true);
                        config.update('syncScroll', !current, vscode.ConfigurationTarget.Global);
                        return;
                    }
                }
            },
            null,
            this._disposables
        );

        this.update();
    }

    public scrollToLine(
        line: number,
        totalLines: number,
        queryText?: string,
        headingText?: string,
        isHeading?: boolean,
        frontmatterEndLine?: number,
        prevHeading?: { text: string; line: number } | null,
        nextHeading?: { text: string; line: number } | null
    ) {
        this._panel.webview.postMessage({
            type: 'syncScroll',
            line,
            totalLines,
            queryText,
            headingText,
            isHeading: Boolean(isHeading),
            frontmatterEndLine: frontmatterEndLine !== undefined ? frontmatterEndLine : -1,
            prevHeading: prevHeading || null,
            nextHeading: nextHeading || null
        });
    }

    public setSyncScrollEnabled(enabled: boolean) {
        this._panel.webview.postMessage({
            type: 'setSyncScroll',
            enabled
        });
    }

    private async _updateDocumentFrontmatterTheme(newTheme: string) {
        try {
            const doc = await vscode.workspace.openTextDocument(this._documentUri);
            const text = doc.getText();
            const edit = new vscode.WorkspaceEdit();

            const fmRegex = /^---\r?\n([\s\S]*?)\r?\n---/;
            const match = text.match(fmRegex);

            if (match) {
                const fmBody = match[1];
                const themeLineRegex = /^[ \t]*theme:\s*.*$/m;
                if (themeLineRegex.test(fmBody)) {
                    const newFmBody = fmBody.replace(themeLineRegex, `theme: ${newTheme}`);
                    const fullFm = `---\n${newFmBody}\n---`;
                    const range = new vscode.Range(doc.positionAt(0), doc.positionAt(match[0].length));
                    edit.replace(this._documentUri, range, fullFm);
                } else {
                    const closingIndex = text.indexOf('---', 3);
                    if (closingIndex !== -1) {
                        edit.insert(this._documentUri, doc.positionAt(closingIndex), `theme: ${newTheme}\n`);
                    }
                }
            } else {
                edit.insert(this._documentUri, new vscode.Position(0, 0), `---\ntheme: ${newTheme}\n---\n\n`);
            }

            await vscode.workspace.applyEdit(edit);
        } catch (err) {
            console.error('Botox: Failed to update document frontmatter theme:', err);
        }
    }

    private async _updateDocumentFrontmatterSlides(enableSlides: boolean) {
        try {
            const doc = await vscode.workspace.openTextDocument(this._documentUri);
            const text = doc.getText();
            const edit = new vscode.WorkspaceEdit();

            const fmRegex = /^---\r?\n([\s\S]*?)\r?\n---/;
            const match = text.match(fmRegex);

            if (match) {
                const fmBody = match[1];
                const marpLineRegex = /^[ \t]*(marp|slides|presentation):\s*.*$/m;
                if (marpLineRegex.test(fmBody)) {
                    const newFmBody = fmBody.replace(marpLineRegex, `marp: ${enableSlides}`);
                    const fullFm = `---\n${newFmBody}\n---`;
                    const range = new vscode.Range(doc.positionAt(0), doc.positionAt(match[0].length));
                    edit.replace(this._documentUri, range, fullFm);
                } else {
                    const closingIndex = text.indexOf('---', 3);
                    if (closingIndex !== -1) {
                        edit.insert(this._documentUri, doc.positionAt(closingIndex), `marp: ${enableSlides}\n`);
                    }
                }
            } else {
                edit.insert(this._documentUri, new vscode.Position(0, 0), `---\nmarp: ${enableSlides}\n---\n\n`);
            }

            await vscode.workspace.applyEdit(edit);
        } catch (err) {
            console.error('Botox: Failed to update document frontmatter slides:', err);
        }
    }

    public async update(liveContent?: string) {
        if (this._isCompiling) {
            this._pendingCompile = true;
            this._pendingContent = liveContent;
            abortActivePreview(this._documentUri.fsPath);
            return;
        }

        this._isCompiling = true;
        this._panel.webview.postMessage({ type: 'status', message: 'Typesetting with Botox...' });

        try {
            let content = liveContent;
            if (content === undefined) {
                const doc = vscode.workspace.textDocuments.find(
                    d => d.uri.toString() === this._documentUri.toString()
                );
                if (doc) {
                    content = doc.getText();
                }
            }

            if (content) {
                const themeMatch = content.match(/^theme:\s*["']?([a-zA-Z0-9_-]+)["']?/m);
                if (themeMatch && themeMatch[1]) {
                    this._activeDocumentTheme = themeMatch[1].toLowerCase();
                }
            }

            const result: VectorCompilationResult = await compileForPreview(
                this._documentUri.fsPath,
                content,
                this._activeDocumentTheme
            );

            if (result.success && result.pages) {
                if (result.isSlides !== undefined && result.isSlides !== this._isSlides) {
                    this._isSlides = result.isSlides;
                    const docThemeList = ['academic', 'modern', 'elegant', 'technical', 'compact', 'minimal'];
                    const slideThemeList = ['default', 'academic', 'gaia', 'uncover', 'dark', 'nord'];
                    const hasExplicitTheme = content && /^theme:\s*["']?([a-zA-Z0-9_-]+)["']?/m.test(content);
                    if (!hasExplicitTheme) {
                        this._activeDocumentTheme = this._isSlides ? 'default' : 'academic';
                    } else if (this._isSlides && !slideThemeList.includes(this._activeDocumentTheme)) {
                        this._activeDocumentTheme = 'default';
                    } else if (!this._isSlides && !docThemeList.includes(this._activeDocumentTheme)) {
                        this._activeDocumentTheme = 'academic';
                    }
                }
                this._lastHeadings = result.headings || [];
                this._lastNumPages = result.numPages || result.pages.length;
                reportCompilationSuccess(this._documentUri, result.durationMs);
                this._panel.title = `Preview: ${path.basename(this._documentUri.fsPath)}`;
                if (!this._htmlInitialized) {
                    this._panel.webview.html = this._getHtmlForWebview(result.pages, result.headings || [], result.durationMs, undefined, this._isSlides);
                    this._htmlInitialized = true;
                } else {
                    this._panel.webview.postMessage({
                        type: 'pages',
                        pages: result.pages,
                        headings: result.headings || [],
                        durationMs: result.durationMs,
                        isSlides: this._isSlides,
                        activeTheme: this._activeDocumentTheme
                    });
                }
            } else if (result.error && result.error.includes('Aborted:')) {
                // Aborted because a newer compile was triggered; suppress error
                return;
            } else {
                const errMsg = result.error || 'Compilation failed with unknown error.';
                reportCompilationFailure(this._documentUri, errMsg);
                if (!this._htmlInitialized) {
                    this._panel.webview.html = this._getHtmlForWebview([], [], result.durationMs, errMsg, this._isSlides);
                    this._htmlInitialized = true;
                } else {
                    this._panel.webview.postMessage({
                        type: 'error',
                        message: errMsg
                    });
                }
            }
        } catch (e: any) {
            const errMsg = e.message || String(e);
            reportCompilationFailure(this._documentUri, errMsg);
            if (!this._htmlInitialized) {
                this._panel.webview.html = this._getHtmlForWebview([], [], undefined, errMsg, this._isSlides);
                this._htmlInitialized = true;
            } else {
                this._panel.webview.postMessage({
                    type: 'error',
                    message: errMsg
                });
            }
        } finally {
            this._isCompiling = false;
            if (this._pendingCompile) {
                this._pendingCompile = false;
                const nextContent = this._pendingContent;
                this._pendingContent = undefined;
                this.update(nextContent);
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

    private _getHtmlForWebview(initialPages: string[], initialHeadings: VectorHeadingInfo[] = [], durationMs?: number, initialError?: string, isSlides: boolean = false): string {
        const title = path.basename(this._documentUri.fsPath);
        const timingStr = durationMs ? `${durationMs}ms` : '';
        const pagesJson = JSON.stringify(initialPages);
        const headingsJson = JSON.stringify(initialHeadings);
        const initialErrorJson = JSON.stringify(initialError || null);
        const initialSync = vscode.workspace.getConfiguration('botox').get<boolean>('syncScroll', true);
        const activeTheme = this._activeDocumentTheme;

        return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Botox Preview: ${title}</title>
  <style>
    :root {
      --bg: var(--vscode-editor-background, #1e1e1e);
      --fg: var(--vscode-editor-foreground, #d4d4d4);
      --toolbar-bg: var(--vscode-editorGroupHeader-tabsBackground, #252526);
      --toolbar-border: var(--vscode-editorGroup-border, rgba(255, 255, 255, 0.08));
      --btn-bg: var(--vscode-button-secondaryBackground, rgba(255, 255, 255, 0.07));
      --btn-fg: var(--vscode-button-secondaryForeground, #e2e8f0);
      --btn-hover: var(--vscode-button-secondaryHoverBackground, rgba(255, 255, 255, 0.14));
      --accent: var(--vscode-focusBorder, #38bdf8);
      --canvas-bg: var(--bg);
      --page-bg: #ffffff;
      --page-shadow: 0 10px 32px rgba(0, 0, 0, 0.35);
      --page-border: rgba(0, 0, 0, 0.08);
      --svg-filter: none;
    }

    body[data-theme="auto"] {
      --canvas-bg: var(--vscode-editor-background, #1e1e1e);
      --page-bg: #ffffff;
      --page-shadow: 0 10px 32px rgba(0, 0, 0, 0.4);
      --page-border: rgba(255, 255, 255, 0.06);
      --svg-filter: none;
    }

    body[data-theme="light"] {
      --canvas-bg: #f1f5f9;
      --toolbar-bg: #ffffff;
      --toolbar-border: #e2e8f0;
      --fg: #1e293b;
      --btn-bg: #f8fafc;
      --btn-fg: #334155;
      --btn-hover: #e2e8f0;
      --page-bg: #ffffff;
      --page-shadow: 0 12px 36px rgba(15, 23, 42, 0.12);
      --page-border: #cbd5e1;
      --svg-filter: none;
    }

    body[data-theme="warm"] {
      --canvas-bg: #f4efe4;
      --toolbar-bg: #ede5d5;
      --toolbar-border: #ddcfba;
      --fg: #382f25;
      --btn-bg: #faf5eb;
      --btn-fg: #453b2f;
      --btn-hover: #e4d8c3;
      --page-bg: #fcf8f0;
      --page-shadow: 0 12px 36px rgba(90, 65, 40, 0.15);
      --page-border: #e2d4bc;
      --svg-filter: sepia(0.32) contrast(0.98);
    }

    body[data-theme="dark"] {
      --canvas-bg: #0f172a;
      --toolbar-bg: #1e293b;
      --toolbar-border: #334155;
      --fg: #f8fafc;
      --btn-bg: #334155;
      --btn-fg: #f8fafc;
      --btn-hover: #475569;
      --page-bg: #1e293b;
      --page-shadow: 0 14px 44px rgba(0, 0, 0, 0.65);
      --page-border: rgba(255, 255, 255, 0.08);
      --svg-filter: invert(0.88) hue-rotate(180deg);
    }

    body[data-theme="nord"] {
      --canvas-bg: #242933;
      --toolbar-bg: #2e3440;
      --toolbar-border: #434c5e;
      --fg: #eceff4;
      --btn-bg: #3b4252;
      --btn-fg: #eceff4;
      --btn-hover: #4c566a;
      --page-bg: #2e3440;
      --page-shadow: 0 14px 44px rgba(0, 0, 0, 0.6);
      --page-border: #4c566a;
      --svg-filter: invert(0.86) hue-rotate(190deg) brightness(1.04);
    }

    body[data-theme="oled"] {
      --canvas-bg: #000000;
      --toolbar-bg: #0d0d0d;
      --toolbar-border: #222222;
      --fg: #ffffff;
      --btn-bg: #181818;
      --btn-fg: #ffffff;
      --btn-hover: #282828;
      --page-bg: #0a0a0a;
      --page-shadow: 0 0 0 1px #2a2a2a;
      --page-border: #2a2a2a;
      --svg-filter: invert(1);
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: var(--canvas-bg);
      color: var(--fg);
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      user-select: none;
      -webkit-user-select: none;
      transition: background-color 0.2s ease, color 0.2s ease;
    }
    #toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 5px 12px;
      background: var(--toolbar-bg);
      border-bottom: 1px solid var(--toolbar-border);
      font-size: 11px;
      user-select: none;
      z-index: 100;
      gap: 8px;
      box-shadow: 0 1px 4px rgba(0, 0, 0, 0.15);
      flex-wrap: wrap;
      transition: background-color 0.2s ease, border-color 0.2s ease;
    }
    .tool-group {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-shrink: 0;
    }
    .theme-select {
      background: var(--btn-bg);
      color: var(--btn-fg);
      border: 1px solid var(--toolbar-border);
      border-radius: 4px;
      padding: 3px 8px;
      font-size: 11px;
      font-family: inherit;
      cursor: pointer;
      outline: none;
      transition: all 0.15s ease;
    }
    .theme-select:hover {
      background: var(--btn-hover);
      border-color: var(--accent);
    }
    .theme-select:focus {
      border-color: var(--accent);
    }
    .tool-btn {
      background: var(--btn-bg);
      color: var(--btn-fg);
      border: 1px solid var(--toolbar-border);
      padding: 3px 8px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 11px;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      font-family: inherit;
      transition: all 0.15s ease;
    }
    .tool-btn:hover {
      background: var(--btn-hover);
      color: #ffffff;
    }
    .tool-btn.active {
      border-color: var(--accent);
      background: var(--btn-hover);
      color: #38bdf8;
    }
    .icon-btn {
      background: transparent;
      color: var(--btn-fg);
      border: 1px solid transparent;
      padding: 4px 6px;
      border-radius: 4px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 11px;
      transition: all 0.15s ease;
    }
    .icon-btn:hover {
      background: var(--btn-hover);
      color: #ffffff;
    }
    .segmented-control {
      display: inline-flex;
      align-items: center;
      background: var(--btn-bg);
      border: 1px solid var(--toolbar-border);
      border-radius: 4px;
      overflow: hidden;
    }
    .segmented-control button {
      background: transparent;
      color: var(--btn-fg);
      border: none;
      padding: 3px 8px;
      font-size: 11px;
      cursor: pointer;
      border-right: 1px solid var(--toolbar-border);
      transition: background 0.15s ease;
    }
    .segmented-control button:last-child {
      border-right: none;
    }
    .segmented-control button:hover {
      background: var(--btn-hover);
      color: #ffffff;
    }
    .segmented-control button.active {
      background: var(--accent);
      color: #ffffff;
    }
    .segmented-control .zoom-label {
      padding: 3px 7px;
      font-size: 11px;
      font-variant-numeric: tabular-nums;
      min-width: 42px;
      text-align: center;
      border-right: 1px solid var(--toolbar-border);
      cursor: pointer;
    }
    .segmented-control .zoom-label:hover {
      background: var(--btn-hover);
    }
    .follow-cursor-label {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      color: var(--btn-fg);
      cursor: pointer;
      user-select: none;
      padding: 3px 6px;
      border-radius: 4px;
      transition: background 0.15s ease;
    }
    .follow-cursor-label:hover {
      background: var(--btn-hover);
    }
    .follow-cursor-label input[type="checkbox"] {
      cursor: pointer;
      margin: 0;
      width: 13px;
      height: 13px;
      accent-color: var(--vscode-focusBorder, #38bdf8);
    }
    .page-nav-pill {
      display: inline-flex;
      align-items: center;
      background: var(--btn-bg);
      border: 1px solid var(--toolbar-border);
      border-radius: 4px;
      overflow: hidden;
      padding: 0 2px;
    }
    .page-nav-pill button {
      background: transparent;
      border: none;
      color: var(--btn-fg);
      padding: 3px 6px;
      cursor: pointer;
      font-size: 10px;
    }
    .page-nav-pill button:hover {
      color: #ffffff;
    }
    .page-nav-pill input {
      width: 32px;
      text-align: center;
      background: transparent;
      border: none;
      color: var(--fg);
      font-size: 11px;
      font-family: inherit;
      padding: 2px 0;
      outline: none;
    }
    .page-nav-pill .sep {
      opacity: 0.5;
      font-size: 10px;
      margin: 0 2px;
    }
    .page-nav-pill .total {
      font-size: 11px;
      padding-right: 4px;
      opacity: 0.85;
    }

    /* Full-screen Error Card when no pages rendered */
    .full-error-container {
      display: flex;
      justify-content: center;
      align-items: center;
      width: 100%;
      min-height: 60vh;
      padding: 40px 20px;
    }
    .full-error-card {
      background: rgba(30, 20, 20, 0.85);
      border: 1px solid #7f1d1d;
      border-radius: 12px;
      padding: 32px 36px;
      max-width: 820px;
      width: 100%;
      box-shadow: 0 20px 50px rgba(0, 0, 0, 0.6);
      backdrop-filter: blur(12px);
      user-select: text;
      -webkit-user-select: text;
    }
    .full-error-header {
      display: flex;
      align-items: center;
      gap: 16px;
      margin-bottom: 20px;
      padding-bottom: 16px;
      border-bottom: 1px solid rgba(239, 68, 68, 0.25);
    }
    .full-error-icon {
      background: rgba(239, 68, 68, 0.15);
      padding: 10px;
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .full-error-title {
      font-size: 18px;
      font-weight: 700;
      color: #f87171;
      letter-spacing: -0.2px;
    }
    .full-error-sub {
      font-size: 12px;
      color: var(--fg);
      opacity: 0.75;
      margin-top: 3px;
    }
    .full-error-code {
      background: #0d1117;
      color: #fecaca;
      border: 1px solid #30363d;
      border-radius: 8px;
      padding: 18px 20px;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 12px;
      line-height: 1.6;
      white-space: pre-wrap;
      overflow-x: auto;
      max-height: 52vh;
      overflow-y: auto;
      margin-bottom: 22px;
    }
    .full-error-actions {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 18px;
    }
    .full-error-actions button {
      padding: 6px 14px;
      font-size: 12px;
      border-radius: 4px;
      font-weight: 600;
    }
    .full-error-actions button.primary {
      background: #dc2626;
      color: #ffffff;
      border: 1px solid transparent;
    }
    .full-error-actions button.primary:hover {
      background: #b91c1c;
    }
    .full-error-hint {
      font-size: 11px;
      color: var(--fg);
      opacity: 0.7;
      line-height: 1.5;
    }
    .full-error-hint code {
      background: rgba(255, 255, 255, 0.1);
      padding: 2px 5px;
      border-radius: 3px;
    }

    /* Floating Error HUD at bottom when pages are active */
    #error-hud {
      display: none;
      position: fixed;
      bottom: 20px;
      left: 50%;
      transform: translateX(-50%);
      width: calc(100% - 40px);
      max-width: 860px;
      background: rgba(20, 10, 10, 0.95);
      border: 1px solid #dc2626;
      border-radius: 8px;
      box-shadow: 0 12px 40px rgba(0, 0, 0, 0.7);
      backdrop-filter: blur(16px);
      z-index: 1000;
      overflow: hidden;
      transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
    }
    .error-hud-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 9px 14px;
      cursor: pointer;
      user-select: none;
      background: rgba(220, 38, 38, 0.15);
      border-bottom: 1px solid transparent;
    }
    #error-hud.expanded .error-hud-header {
      border-bottom-color: rgba(220, 38, 38, 0.3);
    }
    .error-hud-summary {
      display: flex;
      align-items: center;
      gap: 10px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1;
    }
    .error-hud-badge {
      background: #dc2626;
      color: #ffffff;
      padding: 2px 7px;
      border-radius: 4px;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.5px;
      text-transform: uppercase;
      flex-shrink: 0;
    }
    .error-hud-text {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px;
      color: #fecaca;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .error-hud-controls {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-shrink: 0;
      margin-left: 12px;
    }
    .hud-btn {
      background: rgba(255, 255, 255, 0.1);
      color: #fecaca;
      border: 1px solid rgba(255, 255, 255, 0.15);
      padding: 3px 8px;
      border-radius: 4px;
      font-size: 10px;
      cursor: pointer;
    }
    .hud-btn:hover {
      background: rgba(255, 255, 255, 0.2);
      color: #ffffff;
    }
    .error-hud-body {
      display: none;
      padding: 12px 16px;
      max-height: 48vh;
      overflow-y: auto;
      user-select: text;
      -webkit-user-select: text;
    }
    #error-hud.expanded .error-hud-body {
      display: block;
    }
    .error-hud-pre {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 12px;
      line-height: 1.5;
      color: #fca5a5;
      white-space: pre-wrap;
      background: rgba(0, 0, 0, 0.4);
      padding: 12px;
      border-radius: 6px;
      border: 1px solid rgba(255, 255, 255, 0.05);
    }
    .error-hud-footer {
      margin-top: 10px;
      font-size: 11px;
      opacity: 0.65;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    #viewer-container {
      flex: 1;
      overflow-y: auto;
      overflow-x: auto;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 28px 16px 56px;
      gap: 24px;
      background: var(--canvas-bg);
      transition: background 0.2s ease;
    }
    .page-box {
      background: var(--page-bg);
      box-shadow: var(--page-shadow);
      border: 1px solid var(--page-border);
      border-radius: 4px;
      margin: 0 auto;
      display: block;
      position: relative;
      flex-shrink: 0;
      transition: width 0.12s ease-out, background 0.2s ease, box-shadow 0.2s ease;
      user-select: text;
      -webkit-user-select: text;
    }
    .page-box, .page-box * {
      user-select: text;
      -webkit-user-select: text;
    }
    .page-box ::selection {
      background: rgba(56, 189, 248, 0.45);
      color: inherit;
    }
    .botox-text-layer {
      user-select: text;
      -webkit-user-select: text;
    }
    .botox-text-layer text {
      user-select: text;
      -webkit-user-select: text;
      cursor: text;
    }
    .page-box svg {
      width: 100% !important;
      height: 100% !important;
      display: block;
      pointer-events: auto;
      filter: var(--svg-filter);
      transition: filter 0.2s ease;
    }
    body[data-theme="dark"] .page-box svg image,
    body[data-theme="nord"] .page-box svg image,
    body[data-theme="oled"] .page-box svg image {
      filter: invert(1) hue-rotate(180deg);
    }
    .page-box.pause-step {
      display: none !important;
    }
  </style>
</head>
<body>
  <div id="toolbar">
    <div class="tool-group">
      <select id="theme-select" class="theme-select" title="${isSlides ? 'Slide Theme (Marp / Presentation)' : 'Document Theme (Typst)'}"></select>
      <button id="btn-toggle-slides" class="tool-btn ${isSlides ? 'active' : ''}" title="Toggle Slides Deck (sets marp: true/false in document)">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M2 3h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zm1 2v6h10V5H3z"/></svg>
        <span>Slides</span>
      </button>
    </div>
    <div class="tool-group">
      <div class="segmented-control">
        <button id="btn-zoom-out" title="Zoom Out (Ctrl -)">−</button>
        <button id="btn-zoom-reset" class="zoom-label" title="Click to Reset Zoom (100%)"><span id="zoom-level">100%</span></button>
        <button id="btn-zoom-in" title="Zoom In (Ctrl +)">+</button>
        <button id="btn-zoom-fit" title="Fit to Available Width">Fit</button>
      </div>
      <label id="follow-cursor-label" class="follow-cursor-label" title="Follow active cursor and editor scroll">
        <input type="checkbox" id="chk-follow-cursor" ${initialSync ? 'checked' : ''} />
        <span>Follow cursor</span>
      </label>
    </div>
    <div class="tool-group">
      <button id="btn-error-badge" class="tool-btn" style="display: none; color: #fca5a5; background: #7f1d1d; border-color: #ef4444;" title="Toggle Error Details">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8zm9-3a1 1 0 1 1-2 0 1 1 0 0 1 2 0zm-.25 3a.75.75 0 0 0-1.5 0v3.5a.75.75 0 0 0 1.5 0V8z"/></svg>
        <span>Error</span>
      </button>
      <div class="page-nav-pill">
        <button id="btn-prev-page" title="Previous Page (PageUp)">◂</button>
        <input id="page-input" type="number" min="1" max="1" value="1" title="Type page number and press Enter" />
        <span class="sep">/</span>
        <span id="page-total" class="total">1</span>
        <button id="btn-next-page" title="Next Page (PageDown)">▸</button>
      </div>
      <button id="btn-refresh" class="icon-btn" title="Reload typeset preview">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" d="M8 3a5 5 0 1 0 4.546 2.914.5.5 0 0 1 .908-.417A6 6 0 1 1 8 2v1z"/><path d="M8 4.466V.534a.25.25 0 0 1 .41-.192l2.36 1.966c.12.1.12.284 0 .384L8.41 4.658A.25.25 0 0 1 8 4.466z"/></svg>
      </button>
      <button id="btn-export" class="icon-btn" title="Export PDF with Botox">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M.5 9.9a.5.5 0 0 1 .5.5v2.5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-2.5a.5.5 0 0 1 1 0v2.5a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2v-2.5a.5.5 0 0 1 .5-.5z"/><path d="M7.646 11.854a.5.5 0 0 0 .708 0l3-3a.5.5 0 0 0-.708-.708L8.5 10.293V1.5a.5.5 0 0 0-1 0v8.793L5.354 8.146a.5.5 0 1 0-.708.708l3 3z"/></svg>
      </button>
    </div>
  </div>

  <div id="viewer-container"></div>

  <div id="error-hud">
    <div class="error-hud-header" id="error-hud-header">
      <div class="error-hud-summary">
        <span class="error-hud-badge">Build Error</span>
        <span class="error-hud-text" id="error-hud-text"></span>
      </div>
      <div class="error-hud-controls">
        <button id="btn-hud-expand" class="hud-btn">Details ▾</button>
        <button id="btn-hud-copy" class="hud-btn">Copy</button>
        <button id="btn-hud-close" class="hud-btn" title="Dismiss HUD">✕</button>
      </div>
    </div>
    <div class="error-hud-body" id="error-hud-body">
      <div class="error-hud-pre" id="error-hud-pre"></div>
      <div class="error-hud-footer">
        <span>Fix syntax or markup in editor to automatically resume live typesetting.</span>
        <button id="btn-hud-copy2" class="hud-btn">Copy Full Error</button>
      </div>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    vscode.setState({ documentUri: '${this._documentUri.toString()}' });
    const container = document.getElementById('viewer-container');
    const zoomLabel = document.getElementById('zoom-level');
    const pageInput = document.getElementById('page-input');
    const pageTotal = document.getElementById('page-total');
    const btnPrevPage = document.getElementById('btn-prev-page');
    const btnNextPage = document.getElementById('btn-next-page');
    const btnToggleSlides = document.getElementById('btn-toggle-slides');
    const btnErrorBadge = document.getElementById('btn-error-badge');
    const errorHud = document.getElementById('error-hud');
    const errorHudHeader = document.getElementById('error-hud-header');
    const errorHudText = document.getElementById('error-hud-text');
    const errorHudPre = document.getElementById('error-hud-pre');
    const btnHudExpand = document.getElementById('btn-hud-expand');
    const btnHudCopy = document.getElementById('btn-hud-copy');
    const btnHudCopy2 = document.getElementById('btn-hud-copy2');
    const btnHudClose = document.getElementById('btn-hud-close');
    const btnFit = document.getElementById('btn-zoom-fit');
    const chkFollowCursor = document.getElementById('chk-follow-cursor');
    const followCursorLabel = document.getElementById('follow-cursor-label');
    const themeSelect = document.getElementById('theme-select');

    const slideThemes = [
      { id: 'default', label: 'Default (Clean Light)' },
      { id: 'gaia', label: 'Gaia (Marp Warm / Terracotta)' },
      { id: 'uncover', label: 'Uncover (Marp Minimalist / Cyan)' },
      { id: 'nord', label: 'Nord (Frost Dark)' },
      { id: 'dark', label: 'Dark (Slate Modern)' },
      { id: 'academic', label: 'Academic (White Beamer)' }
    ];

    const docThemes = [
      { id: 'academic', label: 'Academic (Typst / LaTeX)' },
      { id: 'modern', label: 'Modern Report (Typst)' },
      { id: 'elegant', label: 'Elegant Book (Typst)' },
      { id: 'technical', label: 'Technical Spec (Typst)' },
      { id: 'compact', label: 'Compact 2-Col (Typst)' },
      { id: 'minimal', label: 'Minimalist (Typst)' }
    ];

    let currentIsSlides = ${isSlides ? 'true' : 'false'};

    function renderThemeOptions(isSlides, activeTheme) {
      if (!themeSelect) return;
      currentIsSlides = isSlides;
      const list = isSlides ? slideThemes : docThemes;
      themeSelect.title = isSlides ? "Slide Theme (Marp / Presentation)" : "Document Theme (Typst)";

      const prevVal = (activeTheme || themeSelect.value || '').toLowerCase();
      themeSelect.innerHTML = '';
      let matched = false;
      for (const t of list) {
        const opt = document.createElement('option');
        opt.value = t.id;
        opt.textContent = t.label;
        if (t.id === prevVal) {
          opt.selected = true;
          matched = true;
        }
        themeSelect.appendChild(opt);
      }
      if (!matched && list.length > 0) {
        themeSelect.value = list[0].id;
      }
    }

    if (themeSelect) {
      themeSelect.addEventListener('change', (e) => {
        const chosen = e.target.value;
        const state = vscode.getState() || {};
        vscode.setState({ ...state, docTheme: chosen });
        vscode.postMessage({
          command: 'changeDocumentTheme',
          theme: chosen
        });
      });
    }

    const savedState = vscode.getState() || {};
    renderThemeOptions(currentIsSlides, savedState.docTheme || "${activeTheme}");

    let currentErrorMessage = '';
    let currentScale = 1.0;
    let isFitWidth = false;
    let syncScrollEnabled = ${initialSync};
    const basePageWidth = 820;

    function updateSyncButtonUI() {
      if (chkFollowCursor) {
        chkFollowCursor.checked = syncScrollEnabled;
      }
      if (followCursorLabel) {
        followCursorLabel.title = syncScrollEnabled
          ? 'Follow cursor is active (click to disable)'
          : 'Follow cursor is disabled (click to enable)';
      }
    }

    if (chkFollowCursor) {
      chkFollowCursor.addEventListener('change', () => {
        syncScrollEnabled = chkFollowCursor.checked;
        updateSyncButtonUI();
        vscode.postMessage({ command: 'toggleSyncScroll' });
      });
    }

    function copyToClipboard(text, btnElement) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => {
          if (btnElement) {
            const orig = btnElement.textContent;
            btnElement.textContent = '✓ Copied';
            setTimeout(() => { btnElement.textContent = orig; }, 2000);
          }
        });
      }
    }

    btnHudCopy.addEventListener('click', (e) => {
      e.stopPropagation();
      copyToClipboard(currentErrorMessage, btnHudCopy);
    });
    btnHudCopy2.addEventListener('click', (e) => {
      e.stopPropagation();
      copyToClipboard(currentErrorMessage, btnHudCopy2);
    });

    function toggleHudDetails(forceState) {
      const isExpanded = forceState !== undefined ? forceState : !errorHud.classList.contains('expanded');
      if (isExpanded) {
        errorHud.classList.add('expanded');
        btnHudExpand.textContent = 'Collapse ▴';
      } else {
        errorHud.classList.remove('expanded');
        btnHudExpand.textContent = 'Details ▾';
      }
    }

    errorHudHeader.addEventListener('click', () => {
      toggleHudDetails();
    });

    btnHudExpand.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleHudDetails();
    });

    btnHudClose.addEventListener('click', (e) => {
      e.stopPropagation();
      errorHud.style.display = 'none';
    });

    btnErrorBadge.addEventListener('click', () => {
      if (errorHud.style.display === 'none') {
        errorHud.style.display = 'block';
        toggleHudDetails(true);
      } else {
        toggleHudDetails();
      }
    });

    function escapeHtml(str) {
      return (str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function showError(msg) {
      currentErrorMessage = msg || '';
      btnErrorBadge.style.display = 'inline-flex';

      let category = 'Typst Error';
      let sub = 'Typst encountered an issue compiling your Markdown';
      let tip = 'Check for unclosed delimiters (*, _, [, ]), unescaped $, or frontmatter YAML formatting.';

      let isMissingCli = (msg || '').includes('Botox compiler binary not found') ||
                         (msg || '').includes('Botox CLI binary is not installed') ||
                         (msg || '').includes('Could not obtain Botox compiler binary');

      if (isMissingCli) {
        category = 'Botox CLI Required';
        sub = 'The standalone Botox command-line binary is not installed';
        tip = 'Install the Botox CLI binary on your system, or set its custom location in VS Code Settings.';
      } else if ((msg || '').includes('[LaTeX Error]') || (msg || '').includes('LaTeX Error')) {
        category = 'LaTeX Error';
        sub = 'Mathematical formula or LaTeX syntax issue detected';
        tip = 'Check your LaTeX math syntax, unclosed braces ({, }), missing fractions, or math symbols.';
      } else if ((msg || '').includes('[Resource Error]') || (msg || '').includes('Resource Error') || (msg || '').toLowerCase().includes('file not found')) {
        category = 'Resource Error';
        sub = 'Image or referenced file could not be found';
        tip = 'Verify the image or file path is relative to the Markdown file or workspace.';
      }

      let cleanMsg = (msg || '')
        .replace(/^Compilation failed:\s*/i, '')
        .replace(/^\[(?:LaTeX|Typst|Resource) Error\]\s*/i, '')
        .replace(/^(?:LaTeX|Typst|Resource) Error:\s*/i, '')
        .trim();

      const firstLine = cleanMsg.split(String.fromCharCode(10))[0] || 'Compilation error';
      errorHudText.textContent = category + ': ' + firstLine;
      errorHudPre.textContent = msg;

      if (renderedPageSvgs.length === 0) {
        if (pageTotal) pageTotal.textContent = '!';
        errorHud.style.display = 'none';

        const actionsHtml = isMissingCli
          ? '<div class="full-error-actions">' +
              '<button id="btn-full-install" class="primary">Install Botox CLI (GitHub)</button>' +
              '<button id="btn-full-settings">Configure Path</button>' +
              '<button id="btn-full-retry">Retry</button>' +
            '</div>'
          : '<div class="full-error-actions">' +
              '<button id="btn-full-copy" class="primary">Copy Error Details</button>' +
              '<button id="btn-full-retry">Retry Compilation</button>' +
            '</div>';

        container.innerHTML =
          '<div class="full-error-container">' +
            '<div class="full-error-card">' +
              '<div class="full-error-header">' +
                '<div class="full-error-icon">' +
                  '<svg width="24" height="24" viewBox="0 0 16 16" fill="#ef4444"><path fill-rule="evenodd" d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8zm9-3a1 1 0 1 1-2 0 1 1 0 0 1 2 0zm-.25 3a.75.75 0 0 0-1.5 0v3.5a.75.75 0 0 0 1.5 0V8z"/></svg>' +
                '</div>' +
                '<div>' +
                  '<div class="full-error-title">' + escapeHtml(category) + '</div>' +
                  '<div class="full-error-sub">' + escapeHtml(sub) + '</div>' +
                '</div>' +
              '</div>' +
              '<div class="full-error-code">' + escapeHtml(msg) + '</div>' +
              actionsHtml +
              '<div class="full-error-hint">' +
                '<strong>Tip:</strong> ' + tip +
              '</div>' +
            '</div>' +
          '</div>';

        document.getElementById('btn-full-install')?.addEventListener('click', () => {
          vscode.postMessage({ command: 'installBinary' });
        });
        document.getElementById('btn-full-settings')?.addEventListener('click', () => {
          vscode.postMessage({ command: 'openSettings' });
        });
        document.getElementById('btn-full-copy')?.addEventListener('click', function() {
          copyToClipboard(currentErrorMessage, this);
        });
        document.getElementById('btn-full-retry')?.addEventListener('click', () => {
          vscode.postMessage({ command: 'refresh' });
        });
      } else {
        errorHud.style.display = 'block';
      }
    }

    function hideError() {
      currentErrorMessage = '';
      btnErrorBadge.style.display = 'none';
      errorHud.style.display = 'none';
      errorHud.classList.remove('expanded');
    }

    function calculatePageWidth() {
      if (isFitWidth) {
        const available = container.clientWidth - 48;
        return Math.max(available, 280);
      }
      return Math.round(basePageWidth * currentScale);
    }

    let cachedPageMetrics = [];
    let renderedPageSvgs = [];

    function updatePageMetrics() {
      const containerRect = container.getBoundingClientRect();
      const pages = container.querySelectorAll('.page-box');
      cachedPageMetrics = [];
      for (let i = 0; i < pages.length; i++) {
        if (pages[i].classList.contains('pause-step')) {
          cachedPageMetrics.push({ top: 0, height: 0 });
          continue;
        }
        const r = pages[i].getBoundingClientRect();
        cachedPageMetrics.push({
          top: r.top - containerRect.top + container.scrollTop,
          height: pages[i].offsetHeight || r.height
        });
      }
    }

    function applyScaleToPages() {
      const targetWidth = calculatePageWidth();
      const pages = container.querySelectorAll('.page-box');
      pages.forEach(p => {
        p.style.width = targetWidth + 'px';
      });

      if (isFitWidth) {
        zoomLabel.textContent = 'Fit';
        btnFit.classList.add('active');
      } else {
        zoomLabel.textContent = Math.round(currentScale * 100) + '%';
        btnFit.classList.remove('active');
      }

      updatePageMetrics();
    }

    function scrollToElement(el) {
      const elRect = el.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();

      const offset = containerRect.height / 2;
      const currentScroll = container.scrollTop;
      const targetScroll = currentScroll + (elRect.top - containerRect.top) - offset;

      const maxScroll = container.scrollHeight - container.clientHeight;
      const clampedTarget = Math.max(0, Math.min(targetScroll, maxScroll));

      const distance = Math.abs(currentScroll - clampedTarget);
      container.scrollTo({
        top: clampedTarget,
        behavior: distance < 1400 ? 'smooth' : 'auto'
      });
    }

    let documentHeadings = ${headingsJson};
    let hasToc = false;
    let firstBodyPage = 0;

    function detectDocumentStructure() {
      hasToc = false;
      firstBodyPage = 0;

      for (let i = 0; i < documentHeadings.length; i++) {
        const h = documentHeadings[i];
        const hText = (h.text || '').toLowerCase().trim();
        if (/^(contents|table of contents|summary|outline|sommaire|inhalt)$/i.test(hText)) {
          hasToc = true;
          for (let j = i + 1; j < documentHeadings.length; j++) {
            if (documentHeadings[j].page_index > h.page_index) {
              firstBodyPage = documentHeadings[j].page_index;
              break;
            }
          }
          break;
        }
      }
    }

    function findBestHeading(query, targetRatio, totalPages) {
      if (!query || query.length < 3 || documentHeadings.length === 0) return null;

      const cleanQuery = query.toLowerCase().replace(/[^a-z0-9 ]/gi, ' ').replace(/[ ]+/g, ' ').trim();
      if (cleanQuery.length < 3) return null;

      const words = cleanQuery.split(' ').filter(w => w.length >= 3);
      const effectiveStartPage = hasToc ? firstBodyPage : 0;
      const expectedPageIndex = effectiveStartPage + Math.round(targetRatio * Math.max(0, totalPages - 1 - effectiveStartPage));

      let bestHeading = null;
      let bestScore = -1;

      for (const h of documentHeadings) {
        if (hasToc && h.page_index < firstBodyPage) {
          continue;
        }

        const cleanH = (h.text || '').toLowerCase().replace(/[^a-z0-9 ]/gi, ' ').replace(/[ ]+/g, ' ').trim();
        if (cleanH.length < 2) continue;

        let score = 0;
        if (cleanH === cleanQuery) {
          score = 100;
        } else if (cleanH.includes(cleanQuery) || cleanQuery.includes(cleanH)) {
          const overlap = Math.min(cleanH.length, cleanQuery.length);
          score = 70 + Math.min(overlap, 30);
        } else if (words.length > 0) {
          let matched = 0;
          for (const w of words) {
            if (cleanH.includes(w)) matched++;
          }
          if (matched > 0) {
            score = (matched / words.length) * 50;
          }
        }

        if (score > 0) {
          const pageDist = Math.abs(h.page_index - expectedPageIndex);
          const finalScore = score - pageDist * 10;
          if (finalScore > bestScore) {
            bestScore = finalScore;
            bestHeading = h;
          }
        }
      }

      return bestScore > 25 ? bestHeading : null;
    }

    function getHeadingPosition(headingText) {
      if (!headingText || documentHeadings.length === 0 || cachedPageMetrics.length === 0) return null;
      const cleanTarget = headingText.toLowerCase().replace(/[^a-z0-9 ]/gi, ' ').replace(/[ ]+/g, ' ').trim();
      if (cleanTarget.length < 2) return null;

      // Priority 1: Exact match
      for (const h of documentHeadings) {
        if (hasToc && h.page_index < firstBodyPage) continue;
        const cleanH = (h.text || '').toLowerCase().replace(/[^a-z0-9 ]/gi, ' ').replace(/[ ]+/g, ' ').trim();
        if (cleanH === cleanTarget) {
          if (h.page_index < cachedPageMetrics.length) {
            const m = cachedPageMetrics[h.page_index];
            return m.top + (h.y_ratio * m.height);
          }
        }
      }

      // Priority 2: Substring match
      for (const h of documentHeadings) {
        if (hasToc && h.page_index < firstBodyPage) continue;
        const cleanH = (h.text || '').toLowerCase().replace(/[^a-z0-9 ]/gi, ' ').replace(/[ ]+/g, ' ').trim();
        if (cleanH.includes(cleanTarget) || cleanTarget.includes(cleanH)) {
          if (h.page_index < cachedPageMetrics.length) {
            const m = cachedPageMetrics[h.page_index];
            return m.top + (h.y_ratio * m.height);
          }
        }
      }
      return null;
    }

    function handleSyncScroll(line, totalLines, queryText, headingText, isHeading, frontmatterEndLine, prevHeading, nextHeading) {
      if (!syncScrollEnabled || totalLines <= 1) return;

      if (cachedPageMetrics.length === 0 || cachedPageMetrics.some(m => !m.height || m.height <= 0)) {
        updatePageMetrics();
      }
      const totalPages = cachedPageMetrics.length;
      if (totalPages === 0) return;

      const maxScroll = container.scrollHeight - container.clientHeight;
      if (maxScroll <= 0) return;

      if (line <= 0) {
        container.scrollTop = 0;
        return;
      }
      if (line >= totalLines - 1) {
        container.scrollTop = maxScroll;
        return;
      }

      const halfViewport = container.clientHeight / 2;

      // 1. If cursor is in YAML frontmatter, interpolate over the title block on Page 1
      let targetY = null;
      const prevPos = prevHeading ? getHeadingPosition(prevHeading.text) : null;
      const nextPos = nextHeading ? getHeadingPosition(nextHeading.text) : null;

      if (frontmatterEndLine !== undefined && frontmatterEndLine >= 0 && line <= frontmatterEndLine) {
        const topPage = cachedPageMetrics[0];
        const fmFrac = Math.min(Math.max(line / Math.max(1, frontmatterEndLine), 0), 1);
        const titleBlockHeight = topPage.height * 0.35;
        targetY = topPage.top + fmFrac * titleBlockHeight;
      } else if (prevPos !== null && nextPos !== null && nextHeading.line > prevHeading.line) {
        const frac = Math.min(Math.max((line - prevHeading.line) / (nextHeading.line - prevHeading.line), 0), 1);
        targetY = prevPos + frac * (nextPos - prevPos);
      } else if (prevPos !== null) {
        const remainingLines = Math.max(1, totalLines - 1 - prevHeading.line);
        const frac = Math.min(Math.max((line - prevHeading.line) / remainingLines, 0), 1);

        // Look for subsequent heading in documentHeadings even if not in .md (e.g. References)
        let nextDocHeadingPos = null;
        let foundPrev = false;
        const cleanTarget = prevHeading.text.toLowerCase().replace(/[^a-z0-9 ]/gi, ' ').replace(/[ ]+/g, ' ').trim();

        for (const h of documentHeadings) {
          if (foundPrev) {
            if (h.page_index < cachedPageMetrics.length) {
              const m = cachedPageMetrics[h.page_index];
              nextDocHeadingPos = m.top + (h.y_ratio * m.height);
            }
            break;
          }
          const cleanH = (h.text || '').toLowerCase().replace(/[^a-z0-9 ]/gi, ' ').replace(/[ ]+/g, ' ').trim();
          if (cleanH === cleanTarget || cleanH.includes(cleanTarget) || cleanTarget.includes(cleanH)) {
            foundPrev = true;
          }
        }

        let endY;
        if (nextDocHeadingPos !== null) {
          endY = nextDocHeadingPos;
        } else {
          const lastPage = cachedPageMetrics[totalPages - 1];
          endY = lastPage.top + lastPage.height;
        }

        targetY = prevPos + frac * (endY - prevPos);
      } else if (nextPos !== null) {
        const bodyStartLine = (frontmatterEndLine !== undefined && frontmatterEndLine >= 0) ? frontmatterEndLine + 1 : 0;
        const spanLines = Math.max(1, nextHeading.line - bodyStartLine);
        const frac = Math.min(Math.max((line - bodyStartLine) / spanLines, 0), 1);
        const effectiveStartPage = hasToc ? firstBodyPage : 0;
        const firstPage = cachedPageMetrics[effectiveStartPage] || cachedPageMetrics[0];
        targetY = firstPage.top + frac * (nextPos - firstPage.top);
      }

      // 3. Fallback: Proportional scroll accounting for TOC / frontmatter offset
      if (targetY === null) {
        const bodyStartLine = (frontmatterEndLine !== undefined && frontmatterEndLine >= 0) ? frontmatterEndLine + 1 : 0;
        const bodyTotalLines = Math.max(1, totalLines - bodyStartLine);
        const bodyRatio = Math.min(Math.max((line - bodyStartLine) / (bodyTotalLines - 1), 0), 1);

        const effectiveStartPage = hasToc ? firstBodyPage : 0;
        const targetPageFraction = effectiveStartPage + bodyRatio * Math.max(0, totalPages - 1 - effectiveStartPage);
        const targetPageIdx = Math.min(Math.floor(targetPageFraction), totalPages - 1);
        const pageRemainder = targetPageFraction - targetPageIdx;

        const pageBox = cachedPageMetrics[targetPageIdx];
        targetY = pageBox.top;
        if (pageRemainder > 0 && targetPageIdx < totalPages - 1) {
          const nextBox = cachedPageMetrics[targetPageIdx + 1];
          targetY += pageRemainder * (nextBox.top - pageBox.top);
        } else {
          targetY += pageRemainder * pageBox.height;
      // Centered vertically in viewport!
      const centeredTarget = targetY - halfViewport;
      const clampedTarget = Math.max(0, Math.min(centeredTarget, maxScroll));
      container.scrollTop = clampedTarget;
    }

    let currentPageIndex = 0;

    function setupPageBox(pageBox, svgContent, i, targetWidth) {
      const isPauseStep = svgContent.includes('data-pause-step="true"') || svgContent.includes('pause-step');
      pageBox.className = isPauseStep ? 'page-box pause-step' : 'page-box';
      pageBox.id = 'page-' + (i + 1);
      pageBox.style.width = targetWidth + 'px';

      const vbMatch = svgContent.match(/viewBox=["']([0-9.]+)[ ]+([0-9.]+)[ ]+([0-9.]+)[ ]+([0-9.]+)["']/);
      if (vbMatch) {
        const vbWidth = parseFloat(vbMatch[3]);
        const vbHeight = parseFloat(vbMatch[4]);
        if (vbWidth > 0 && vbHeight > 0) {
          pageBox.style.aspectRatio = vbWidth + " / " + vbHeight;
        }
      }

      pageBox.innerHTML = svgContent;

      const svgEl = pageBox.querySelector('svg');
      if (svgEl) {
        svgEl.removeAttribute('width');
        svgEl.removeAttribute('height');
        svgEl.style.width = '100%';
        svgEl.style.height = '100%';
        svgEl.style.display = 'block';
        svgEl.style.userSelect = 'text';
        svgEl.style.webkitUserSelect = 'text';
        svgEl.style.pointerEvents = 'auto';
      }
    }

    function getNextVisibleIndex(idx) {
      const pages = container.querySelectorAll('.page-box');
      for (let i = idx + 1; i < pages.length; i++) {
        if (!pages[i].classList.contains('pause-step')) return i;
      }
      return idx;
    }

    function getPrevVisibleIndex(idx) {
      const pages = container.querySelectorAll('.page-box');
      for (let i = idx - 1; i >= 0; i--) {
        if (!pages[i].classList.contains('pause-step')) return i;
      }
      return idx;
    }

    function updatePageIndicator() {
      if (!pageInput || !pageTotal) return;
      const allPages = container.querySelectorAll('.page-box');
      if (allPages.length === 0) {
        pageInput.value = '0';
        pageTotal.textContent = '0';
        return;
      }
      const visiblePages = Array.from(allPages).filter(p => !p.classList.contains('pause-step'));
      const totalVisible = visiblePages.length > 0 ? visiblePages.length : allPages.length;
      pageTotal.textContent = totalVisible;
      pageInput.max = totalVisible;
      const curBox = allPages[currentPageIndex];
      const vIdx = visiblePages.indexOf(curBox);
      pageInput.value = (vIdx >= 0 ? vIdx : 0) + 1;
    }

    function scrollToPage(pageIdx) {
      if (cachedPageMetrics.length === 0) {
        updatePageMetrics();
      }
      const total = cachedPageMetrics.length;
      if (total === 0) return;
      const clamped = Math.max(0, Math.min(pageIdx, total - 1));
      currentPageIndex = clamped;
      updatePageIndicator();

      const m = cachedPageMetrics[clamped];
      if (m && m.height > 0) {
        container.scrollTo({
          top: m.top - 16,
          behavior: 'smooth'
        });
      }
    }

    function renderPages(pages, headings, durationMs) {
      hideError();
      if (headings) {
        documentHeadings = headings;
      }
      detectDocumentStructure();

      if (!pages || pages.length === 0) {
        if (pageTotal) pageTotal.textContent = '0';
        if (pageInput) {
          pageInput.value = '0';
          pageInput.max = '0';
        }
        container.innerHTML = '<div style="margin-top: 40px; opacity: 0.6;">No content to display.</div>';
        renderedPageSvgs = [];
        cachedPageMetrics = [];
        return;
      }

      if (currentPageIndex >= pages.length) {
        currentPageIndex = Math.max(0, pages.length - 1);
      }

      const targetWidth = calculatePageWidth();
      const prevScrollTop = container.scrollTop;
      const prevScrollHeight = container.scrollHeight;

      const existingBoxes = Array.from(container.children).filter(c => c.classList && c.classList.contains('page-box'));
      if (existingBoxes.length !== container.children.length) {
        container.innerHTML = '';
        existingBoxes.length = 0;
        renderedPageSvgs = [];
      }

      while (existingBoxes.length > pages.length) {
        const last = existingBoxes.pop();
        if (last) last.remove();
      }

      for (let i = 0; i < pages.length; i++) {
        if (i < existingBoxes.length) {
          const box = existingBoxes[i];
          if (renderedPageSvgs[i] !== pages[i]) {
            setupPageBox(box, pages[i], i, targetWidth);
            renderedPageSvgs[i] = pages[i];
          } else {
            box.style.width = targetWidth + 'px';
          }
        } else {
          const newBox = document.createElement('div');
          setupPageBox(newBox, pages[i], i, targetWidth);
          container.appendChild(newBox);
          existingBoxes.push(newBox);
          renderedPageSvgs[i] = pages[i];
        }
      }
      renderedPageSvgs.length = pages.length;

      updatePageMetrics();
      updatePageIndicator();

      // Preserve relative reading position if total height shifted
      if (prevScrollHeight > 0 && prevScrollTop > 0 && Math.abs(container.scrollHeight - prevScrollHeight) > 10) {
        const scrollRatio = prevScrollTop / prevScrollHeight;
        container.scrollTop = scrollRatio * container.scrollHeight;
      }
    }

    container.addEventListener('scroll', () => {
      if (cachedPageMetrics.length === 0) return;
      const scrollCenter = container.scrollTop + container.clientHeight / 2;
      for (let i = 0; i < cachedPageMetrics.length; i++) {
        const m = cachedPageMetrics[i];
        if (m.height === 0) continue;
        if (scrollCenter >= m.top && scrollCenter <= m.top + m.height) {
          if (currentPageIndex !== i) {
            currentPageIndex = i;
            updatePageIndicator();
          }
          break;
        }
      }
    });

    if (pageInput) {
      pageInput.addEventListener('change', () => {
        const val = parseInt(pageInput.value, 10);
        if (isNaN(val)) return;
        const visiblePages = Array.from(container.querySelectorAll('.page-box:not(.pause-step)'));
        const targetBox = visiblePages[val - 1];
        if (targetBox) {
          const allPages = Array.from(container.querySelectorAll('.page-box'));
          scrollToPage(allPages.indexOf(targetBox));
        }
      });
      pageInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          pageInput.dispatchEvent(new Event('change'));
        }
      });
    }

    if (btnPrevPage) {
      btnPrevPage.addEventListener('click', () => {
        scrollToPage(getPrevVisibleIndex(currentPageIndex));
      });
    }
    if (btnNextPage) {
      btnNextPage.addEventListener('click', () => {
        scrollToPage(getNextVisibleIndex(currentPageIndex));
      });
    }

    if (btnToggleSlides) {
      btnToggleSlides.addEventListener('click', () => {
        const nextVal = !currentIsSlides;
        currentIsSlides = nextVal;
        btnToggleSlides.classList.toggle('active', nextVal);
        vscode.postMessage({
          command: 'toggleDocumentSlides',
          isSlides: nextVal
        });
      });
    }

    // Ctrl + Wheel / Pinch Zoom
    container.addEventListener('wheel', (e) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        isFitWidth = false;
        const delta = e.deltaY < 0 ? 0.15 : -0.15;
        currentScale = Math.max(0.35, Math.min(3.5, currentScale + delta));
        applyScaleToPages();
      }
    }, { passive: false });

    // Zoom controls
    document.getElementById('btn-zoom-in').addEventListener('click', () => {
      isFitWidth = false;
      currentScale = Math.min(currentScale + 0.15, 3.5);
      applyScaleToPages();
    });

    document.getElementById('btn-zoom-out').addEventListener('click', () => {
      isFitWidth = false;
      currentScale = Math.max(currentScale - 0.15, 0.35);
      applyScaleToPages();
    });

    document.getElementById('btn-zoom-reset').addEventListener('click', () => {
      isFitWidth = false;
      currentScale = 1.0;
      applyScaleToPages();
    });

    btnFit.addEventListener('click', () => {
      isFitWidth = !isFitWidth;
      applyScaleToPages();
    });

    window.addEventListener('resize', () => {
      if (isFitWidth) {
        applyScaleToPages();
      } else {
        updatePageMetrics();
      }
    });

    // Keyboard shortcuts in webview
    window.addEventListener('keydown', (e) => {
      if (e.key === 'PageDown') {
        e.preventDefault();
        scrollToPage(getNextVisibleIndex(currentPageIndex));
        return;
      } else if (e.key === 'PageUp') {
        e.preventDefault();
        scrollToPage(getPrevVisibleIndex(currentPageIndex));
        return;
      }

      if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) {
        e.preventDefault();
        isFitWidth = false;
        currentScale = Math.min(currentScale + 0.15, 3.5);
        applyScaleToPages();
      } else if ((e.ctrlKey || e.metaKey) && (e.key === '-' || e.key === '_')) {
        e.preventDefault();
        isFitWidth = false;
        currentScale = Math.max(currentScale - 0.15, 0.35);
        applyScaleToPages();
      } else if ((e.ctrlKey || e.metaKey) && e.key === '0') {
        e.preventDefault();
        isFitWidth = false;
        currentScale = 1.0;
        applyScaleToPages();
      }
    });

    document.getElementById('btn-refresh').addEventListener('click', () => {
      vscode.postMessage({ command: 'refresh' });
    });

    document.getElementById('btn-export').addEventListener('click', () => {
      vscode.postMessage({ command: 'exportPdf' });
    });

    // Listen for extension messages
    window.addEventListener('message', event => {
      const message = event.data;
      if (message.type === 'pages') {
        if (typeof message.isSlides === 'boolean') {
          currentIsSlides = message.isSlides;
          renderThemeOptions(message.isSlides, message.activeTheme);
          if (btnToggleSlides) {
            btnToggleSlides.classList.toggle('active', message.isSlides);
          }
        } else if (message.activeTheme && themeSelect) {
          themeSelect.value = message.activeTheme;
        }
        renderPages(message.pages, message.headings || [], message.durationMs);
        if (message.activeTheme) {
          const state = vscode.getState() || {};
          vscode.setState({ ...state, docTheme: message.activeTheme });
        }
      } else if (message.type === 'syncScroll') {
        handleSyncScroll(
          message.line,
          message.totalLines,
          message.queryText,
          message.headingText,
          message.isHeading,
          message.frontmatterEndLine,
          message.prevHeading,
          message.nextHeading
        );
      } else if (message.type === 'setSyncScroll') {
        syncScrollEnabled = Boolean(message.enabled);
        updateSyncButtonUI();
      } else if (message.type === 'error') {
        showError(message.message);
      } else if (message.type === 'status') {
        // subtle status update
      }
    });

    // Initial render from embedded data
    const initialPages = ${pagesJson};
    const initialHeadings = ${headingsJson};
    const initialError = ${initialErrorJson};
    renderPages(initialPages, initialHeadings, ${durationMs || 0});
    if (initialError) {
      showError(initialError);
    }
  </script>
</body>
</html>`;
    }
}

export class BotoxPreviewSerializer implements vscode.WebviewPanelSerializer {
    async deserializeWebviewPanel(webviewPanel: vscode.WebviewPanel, state: any): Promise<void> {
        let uriString = state?.documentUri;
        if (!uriString) {
            const active = vscode.window.activeTextEditor;
            if (active && (active.document.languageId === 'markdown' || active.document.fileName.endsWith('.md'))) {
                uriString = active.document.uri.toString();
            }
        }
        if (uriString) {
            try {
                const uri = vscode.Uri.parse(uriString);
                BotoxPreviewPanel.revive(webviewPanel, uri);
                return;
            } catch (e) {
                console.error('Failed to revive Botox preview:', e);
            }
        }
        webviewPanel.dispose();
    }
}

