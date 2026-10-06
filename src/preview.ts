import * as vscode from 'vscode';
import * as path from 'path';
import { compileForPreview, VectorCompilationResult, VectorHeadingInfo } from './compiler';

export class BotoxPreviewPanel {
    public static currentPanels: Map<string, BotoxPreviewPanel> = new Map();
    private readonly _panel: vscode.WebviewPanel;
    private readonly _documentUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];
    private _isCompiling: boolean = false;
    private _pendingCompile: boolean = false;
    private _htmlInitialized: boolean = false;

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

    public async update(liveContent?: string) {
        if (this._isCompiling) {
            this._pendingCompile = true;
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

            const result: VectorCompilationResult = await compileForPreview(
                this._documentUri.fsPath,
                content
            );

            if (result.success && result.pages) {
                this._panel.title = `Preview: ${path.basename(this._documentUri.fsPath)}`;
                if (!this._htmlInitialized) {
                    this._panel.webview.html = this._getHtmlForWebview(result.pages, result.headings || [], result.durationMs);
                    this._htmlInitialized = true;
                } else {
                    this._panel.webview.postMessage({
                        type: 'pages',
                        pages: result.pages,
                        headings: result.headings || [],
                        durationMs: result.durationMs
                    });
                }
            } else {
                this._panel.webview.postMessage({
                    type: 'error',
                    message: result.error || 'Compilation failed with unknown error.'
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

    private _getHtmlForWebview(initialPages: string[], initialHeadings: VectorHeadingInfo[] = [], durationMs?: number): string {
        const title = path.basename(this._documentUri.fsPath);
        const timingStr = durationMs ? `${durationMs}ms` : '';
        const pagesJson = JSON.stringify(initialPages);
        const headingsJson = JSON.stringify(initialHeadings);
        const initialSync = vscode.workspace.getConfiguration('botox').get<boolean>('syncScroll', true);

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
      --toolbar-border: var(--vscode-editorGroup-border, #333333);
      --btn-bg: var(--vscode-button-secondaryBackground, #3a3d41);
      --btn-fg: var(--vscode-button-secondaryForeground, #ffffff);
      --btn-hover: var(--vscode-button-secondaryHoverBackground, #45494e);
      --badge-bg: var(--vscode-badge-background, #007acc);
      --badge-fg: var(--vscode-badge-foreground, #ffffff);
      --accent: var(--vscode-focusBorder, #007acc);
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
      user-select: none;
      -webkit-user-select: none;
    }
    #toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 14px;
      background: var(--toolbar-bg);
      border-bottom: 1px solid var(--toolbar-border);
      font-size: 12px;
      user-select: none;
      z-index: 100;
      box-shadow: 0 2px 6px rgba(0, 0, 0, 0.2);
    }
    .tool-group {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    button {
      background: var(--btn-bg);
      color: var(--btn-fg);
      border: 1px solid transparent;
      padding: 4px 10px;
      border-radius: 3px;
      cursor: pointer;
      font-size: 11px;
      display: flex;
      align-items: center;
      gap: 4px;
      font-family: inherit;
    }
    button:hover { background: var(--btn-hover); }
    button.active {
      border-color: var(--accent);
      background: var(--btn-hover);
    }
    button.active-sync {
      border-color: var(--accent);
      background: var(--btn-hover);
      color: #38bdf8;
      font-weight: 600;
    }
    .badge {
      background: var(--badge-bg);
      color: var(--badge-fg);
      padding: 2px 7px;
      border-radius: 10px;
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.5px;
    }
    .timing-badge {
      background: rgba(255, 255, 255, 0.08);
      color: var(--fg);
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 10px;
      font-family: monospace;
      opacity: 0.85;
    }
    #zoom-level {
      min-width: 44px;
      text-align: center;
      font-size: 11px;
      font-variant-numeric: tabular-nums;
    }
    #error-banner {
      display: none;
      background: #7f1d1d;
      color: #fecaca;
      padding: 10px 14px;
      font-family: monospace;
      font-size: 12px;
      border-bottom: 1px solid #b91c1c;
      white-space: pre-wrap;
      max-height: 180px;
      overflow-y: auto;
    }
    #viewer-container {
      flex: 1;
      overflow-y: auto;
      overflow-x: auto;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 50vh 16px 50vh;
      gap: 20px;
      scroll-behavior: smooth;
    }
    .page-box {
      background: #ffffff;
      box-shadow: 0 6px 24px rgba(0, 0, 0, 0.4);
      border-radius: 3px;
      margin: 0 auto;
      display: block;
      position: relative;
      flex-shrink: 0;
      transition: width 0.12s ease-out;
      user-select: none;
      -webkit-user-select: none;
    }
    .page-box svg {
      width: 100% !important;
      height: 100% !important;
      display: block;
      user-select: none;
      -webkit-user-select: none;
      pointer-events: none;
    }
    .page-indicator {
      font-size: 11px;
      opacity: 0.85;
    }
  </style>
</head>
<body>
  <div id="toolbar">
    <div class="tool-group">
      <button id="btn-refresh" title="Reload typeset preview">Reload</button>
      <button id="btn-export" title="Compile PDF to file">Export PDF</button>
      <span class="badge">Pure Vector</span>
    </div>
    <div class="tool-group">
      <button id="btn-sync" class="${initialSync ? 'active-sync' : ''}" title="Follow active cursor and editor scroll (click to toggle)">
        Follow Cursor: ${initialSync ? 'ON' : 'OFF'}
      </button>
      <button id="btn-zoom-out" title="Zoom Out (Ctrl -)">−</button>
      <span id="zoom-level">100%</span>
      <button id="btn-zoom-in" title="Zoom In (Ctrl +)">+</button>
      <button id="btn-zoom-reset" title="Reset Zoom (100%)">100%</button>
      <button id="btn-zoom-fit" title="Fit to Available Width">Fit Width</button>
    </div>
    <div class="tool-group">
      <span id="page-info" class="page-indicator">Loading...</span>
      <span id="timing" class="timing-badge">${timingStr}</span>
    </div>
  </div>

  <div id="error-banner"></div>
  <div id="viewer-container"></div>

  <script>
    const vscode = acquireVsCodeApi();
    const container = document.getElementById('viewer-container');
    const zoomLabel = document.getElementById('zoom-level');
    const pageInfo = document.getElementById('page-info');
    const timingBadge = document.getElementById('timing');
    const errorBanner = document.getElementById('error-banner');
    const btnFit = document.getElementById('btn-zoom-fit');
    const btnSync = document.getElementById('btn-sync');

    let currentScale = 1.0;
    let isFitWidth = false;
    let syncScrollEnabled = ${initialSync};
    const basePageWidth = 820;

    function updateSyncButtonUI() {
      if (syncScrollEnabled) {
        btnSync.classList.add('active-sync');
        btnSync.textContent = 'Follow Cursor: ON';
        btnSync.title = 'Cursor and scroll synchronization is active (click to disable)';
      } else {
        btnSync.classList.remove('active-sync');
        btnSync.textContent = 'Follow Cursor: OFF';
        btnSync.title = 'Cursor and scroll synchronization is disabled (click to enable)';
      }
    }

    btnSync.addEventListener('click', () => {
      syncScrollEnabled = !syncScrollEnabled;
      updateSyncButtonUI();
      vscode.postMessage({ command: 'toggleSyncScroll' });
    });

    function showError(msg) {
      errorBanner.textContent = msg;
      errorBanner.style.display = 'block';
    }

    function hideError() {
      errorBanner.style.display = 'none';
      errorBanner.textContent = '';
    }

    function calculatePageWidth() {
      if (isFitWidth) {
        const available = container.clientWidth - 48;
        return Math.max(available, 280);
      }
      return Math.round(basePageWidth * currentScale);
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

      const cleanQuery = query.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
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

        const cleanH = (h.text || '').toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
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
      if (!headingText || documentHeadings.length === 0) return null;
      const cleanTarget = headingText.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
      if (cleanTarget.length < 2) return null;

      const pages = container.querySelectorAll('.page-box');
      const containerRect = container.getBoundingClientRect();

      // Priority 1: Exact match
      for (const h of documentHeadings) {
        if (hasToc && h.page_index < firstBodyPage) continue;
        const cleanH = (h.text || '').toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
        if (cleanH === cleanTarget) {
          if (h.page_index < pages.length) {
            const pageBox = pages[h.page_index];
            const pageTop = pageBox.getBoundingClientRect().top - containerRect.top + container.scrollTop;
            return pageTop + (h.y_ratio * pageBox.offsetHeight);
          }
        }
      }

      // Priority 2: Substring match
      for (const h of documentHeadings) {
        if (hasToc && h.page_index < firstBodyPage) continue;
        const cleanH = (h.text || '').toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
        if (cleanH.includes(cleanTarget) || cleanTarget.includes(cleanH)) {
          if (h.page_index < pages.length) {
            const pageBox = pages[h.page_index];
            const pageTop = pageBox.getBoundingClientRect().top - containerRect.top + container.scrollTop;
            return pageTop + (h.y_ratio * pageBox.offsetHeight);
          }
        }
      }
      return null;
    }

    function handleSyncScroll(line, totalLines, queryText, headingText, isHeading, frontmatterEndLine, prevHeading, nextHeading) {
      if (!syncScrollEnabled || totalLines <= 1) return;

      const pages = container.querySelectorAll('.page-box');
      const totalPages = pages.length;
      if (totalPages === 0) return;

      const containerRect = container.getBoundingClientRect();
      const maxScroll = container.scrollHeight - container.clientHeight;
      if (maxScroll <= 0) return;

      const halfViewport = container.clientHeight / 2;

      // 1. If cursor is in YAML frontmatter, interpolate over the title block on Page 1
      let targetY = null;
      const prevPos = prevHeading ? getHeadingPosition(prevHeading.text) : null;
      const nextPos = nextHeading ? getHeadingPosition(nextHeading.text) : null;

      if (frontmatterEndLine !== undefined && frontmatterEndLine >= 0 && line <= frontmatterEndLine) {
        const topPage = pages[0];
        const topPageTop = topPage.getBoundingClientRect().top - containerRect.top + container.scrollTop;
        const fmFrac = Math.min(Math.max(line / Math.max(1, frontmatterEndLine), 0), 1);
        const titleBlockHeight = topPage.offsetHeight * 0.35;
        targetY = topPageTop + fmFrac * titleBlockHeight;
      } else if (prevPos !== null && nextPos !== null && nextHeading.line > prevHeading.line) {
        const frac = Math.min(Math.max((line - prevHeading.line) / (nextHeading.line - prevHeading.line), 0), 1);
        targetY = prevPos + frac * (nextPos - prevPos);
      } else if (prevPos !== null) {
        const remainingLines = Math.max(1, totalLines - 1 - prevHeading.line);
        const frac = Math.min(Math.max((line - prevHeading.line) / remainingLines, 0), 1);

        // Look for subsequent heading in documentHeadings even if not in .md (e.g. References)
        let nextDocHeadingPos = null;
        let foundPrev = false;
        const cleanTarget = prevHeading.text.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();

        for (const h of documentHeadings) {
          if (foundPrev) {
            if (h.page_index < pages.length) {
              const pBox = pages[h.page_index];
              const pTop = pBox.getBoundingClientRect().top - containerRect.top + container.scrollTop;
              nextDocHeadingPos = pTop + (h.y_ratio * pBox.offsetHeight);
            }
            break;
          }
          const cleanH = (h.text || '').toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
          if (cleanH === cleanTarget || cleanH.includes(cleanTarget) || cleanTarget.includes(cleanH)) {
            foundPrev = true;
          }
        }

        let endY;
        if (nextDocHeadingPos !== null) {
          endY = nextDocHeadingPos;
        } else {
          const lastPage = pages[totalPages - 1];
          const lastPageTop = lastPage.getBoundingClientRect().top - containerRect.top + container.scrollTop;
          endY = lastPageTop + lastPage.offsetHeight;
        }

        targetY = prevPos + frac * (endY - prevPos);
      } else if (nextPos !== null) {
        const bodyStartLine = (frontmatterEndLine !== undefined && frontmatterEndLine >= 0) ? frontmatterEndLine + 1 : 0;
        const spanLines = Math.max(1, nextHeading.line - bodyStartLine);
        const frac = Math.min(Math.max((line - bodyStartLine) / spanLines, 0), 1);
        const effectiveStartPage = hasToc ? firstBodyPage : 0;
        const firstPage = pages[effectiveStartPage];
        const topY = firstPage.getBoundingClientRect().top - containerRect.top + container.scrollTop;
        targetY = topY + frac * (nextPos - topY);
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

        const pageBox = pages[targetPageIdx];
        const pageBoxTop = pageBox.getBoundingClientRect().top - containerRect.top + container.scrollTop;
        targetY = pageBoxTop;
        if (pageRemainder > 0 && targetPageIdx < totalPages - 1) {
          const nextBox = pages[targetPageIdx + 1];
          const nextBoxTop = nextBox.getBoundingClientRect().top - containerRect.top + container.scrollTop;
          targetY += pageRemainder * (nextBoxTop - pageBoxTop);
        } else {
          targetY += pageRemainder * pageBox.offsetHeight;
        }
      }

      // Centered vertically in viewport!
      const centeredTarget = targetY - halfViewport;
      const clampedTarget = Math.max(0, Math.min(centeredTarget, maxScroll));
      const currentTop = container.scrollTop;
      const distance = Math.abs(currentTop - clampedTarget);

      container.scrollTo({
        top: clampedTarget,
        behavior: distance < 1400 ? 'smooth' : 'auto'
      });
    }

    function renderPages(pages, headings, durationMs) {
      hideError();
      if (durationMs) {
        timingBadge.textContent = durationMs + 'ms';
      }
      if (headings) {
        documentHeadings = headings;
      }
      detectDocumentStructure();

      if (!pages || pages.length === 0) {
        pageInfo.textContent = '0 pages';
        container.innerHTML = '<div style="margin-top: 40px; opacity: 0.6;">No content to display.</div>';
        return;
      }

      const total = pages.length;
      pageInfo.textContent = total + (total === 1 ? ' page' : ' pages');

      const targetWidth = calculatePageWidth();
      const prevScrollTop = container.scrollTop;
      const prevScrollHeight = container.scrollHeight;

      container.innerHTML = '';

      for (let i = 0; i < pages.length; i++) {
        const pageBox = document.createElement('div');
        pageBox.className = 'page-box';
        pageBox.id = 'page-' + (i + 1);
        pageBox.style.width = targetWidth + 'px';

        const vbMatch = pages[i].match(/viewBox=["']([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)["']/);
        if (vbMatch) {
          const vbWidth = parseFloat(vbMatch[3]);
          const vbHeight = parseFloat(vbMatch[4]);
          if (vbWidth > 0 && vbHeight > 0) {
            pageBox.style.aspectRatio = vbWidth + " / " + vbHeight;
          }
        }

        pageBox.innerHTML = pages[i];

        const svgEl = pageBox.querySelector('svg');
        if (svgEl) {
          svgEl.removeAttribute('width');
          svgEl.removeAttribute('height');
          svgEl.style.width = '100%';
          svgEl.style.height = '100%';
          svgEl.style.display = 'block';
          svgEl.style.userSelect = 'none';
          svgEl.style.webkitUserSelect = 'none';
          svgEl.style.pointerEvents = 'none';
        }

        container.appendChild(pageBox);
      }

      // Preserve relative reading position after document recompile
      if (prevScrollHeight > 0 && prevScrollTop > 0) {
        const scrollRatio = prevScrollTop / prevScrollHeight;
        container.scrollTop = scrollRatio * container.scrollHeight;
      }
    }

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
      }
    });

    // Keyboard shortcuts in webview
    window.addEventListener('keydown', (e) => {
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
        renderPages(message.pages, message.headings || [], message.durationMs);
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
    renderPages(initialPages, initialHeadings, ${durationMs || 0});
  </script>
</body>
</html>`;
    }
}
