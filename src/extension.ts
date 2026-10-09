import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { BotoxPreviewPanel, BotoxPreviewSerializer } from './preview';
import { compileDocument, runInit, setExtensionContext } from './compiler';
import { runSetupWizard, runSetupInTerminal, checkFirstRunSetup, resetSetupState } from './setup';

let debounceTimeout: NodeJS.Timeout | undefined;
export const botoxDiagnostics = vscode.languages.createDiagnosticCollection('botox');
let statusBarItem: vscode.StatusBarItem;

export function updateStatusBar(durationMs?: number, isError?: boolean, errorMsg?: string) {
    if (!statusBarItem) return;
    const config = vscode.workspace.getConfiguration('botox');
    if (!config.get<boolean>('showStatusBarItem', true)) {
        statusBarItem.hide();
        return;
    }

    const editor = vscode.window.activeTextEditor;
    const isMd = editor && (editor.document.languageId === 'markdown' || editor.document.fileName.endsWith('.md'));
    const hasPanels = BotoxPreviewPanel.currentPanels.size > 0;

    if (!isMd && !hasPanels) {
        statusBarItem.hide();
        return;
    }

    if (isError) {
        statusBarItem.text = '$(error) Botox Error';
        statusBarItem.tooltip = errorMsg || 'Botox compilation error';
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    } else if (durationMs !== undefined) {
        statusBarItem.text = `$(book) Botox: ${durationMs}ms`;
        statusBarItem.tooltip = `Last typeset in ${durationMs}ms (Click to open preview)`;
        statusBarItem.backgroundColor = undefined;
    } else {
        statusBarItem.text = '$(book) Botox';
        statusBarItem.tooltip = 'Click to open Botox live preview';
        statusBarItem.backgroundColor = undefined;
    }
    statusBarItem.show();
}

export function reportCompilationSuccess(uri: vscode.Uri, durationMs?: number) {
    botoxDiagnostics.delete(uri);
    updateStatusBar(durationMs, false);
}

export function reportCompilationFailure(uri: vscode.Uri, errorMsg: string) {
    updateStatusBar(undefined, true, errorMsg);

    // Find the open text document if available
    const doc = vscode.workspace.textDocuments.find(
        (d) => d.uri.toString() === uri.toString() || d.uri.fsPath === uri.fsPath
    );

    let foundLine: number | undefined;
    let foundCol: number | undefined;

    // 1. Try parsing explicit location (e.g. "document.md:14:5:", "line 14:5", "line 14 col 5", ":14:5")
    const locMatch =
        errorMsg.match(/(?:[a-zA-Z0-9_\-\.]+\.(?:md|markdown)):(\d+):(\d+)/i) ||
        errorMsg.match(/(?:line|row)\s*(\d+)(?:\s*(?:col|column|:)\s*(\d+))?/i) ||
        errorMsg.match(/:(\d+):(\d+)/);

    if (locMatch) {
        const parsedLine = parseInt(locMatch[1], 10);
        if (!isNaN(parsedLine) && parsedLine > 0) {
            foundLine = parsedLine - 1;
        }
        if (locMatch[2]) {
            const parsedCol = parseInt(locMatch[2], 10);
            if (!isNaN(parsedCol) && parsedCol > 0) {
                foundCol = parsedCol - 1;
            }
        }
    }

    // 2. Try extracting specific token or snippet from the error message
    let token: string | undefined;
    const nearMatch = errorMsg.match(/(?:near|at)\s*'([^']+)'/i);
    if (nearMatch) {
        token = nearMatch[1].trim();
    } else {
        const fileMatch = errorMsg.match(/searched at [^)]*[\/\\]([^\/\s)]+)/i);
        if (fileMatch) {
            token = fileMatch[1].trim();
        } else {
            const varMatch = errorMsg.match(
                /(?:unknown variable|unknown function|cannot find function|cannot find variable|cannot find|not found)[:\s]+'?([a-zA-Z0-9_\-\.]+)'?/i
            );
            if (varMatch) {
                token = varMatch[1].trim();
            }
        }
    }

    // 3. Determine diagnostic range
    let range: vscode.Range | undefined;

    if (doc) {
        const lineCount = doc.lineCount;

        // If we have a target token but no line number, search the document for the token
        if (foundLine === undefined && token && token.length > 0) {
            for (let l = 0; l < lineCount; l++) {
                const text = doc.lineAt(l).text;
                const idx = text.indexOf(token);
                if (idx !== -1) {
                    foundLine = l;
                    foundCol = idx;
                    break;
                }
            }
        }

        if (foundLine !== undefined && foundLine >= 0 && foundLine < lineCount) {
            const lineText = doc.lineAt(foundLine).text;

            if (token && token.length > 0 && lineText.includes(token)) {
                // Exact token match on the line
                const startIdx = lineText.indexOf(token);
                range = new vscode.Range(foundLine, startIdx, foundLine, startIdx + token.length);
            } else if (foundCol !== undefined && foundCol < lineText.length) {
                // Word at column
                const wordRange = doc.getWordRangeAtPosition(new vscode.Position(foundLine, foundCol));
                if (wordRange) {
                    range = wordRange;
                } else {
                    const start = foundCol;
                    const end = Math.min(lineText.length, start + 1);
                    range = new vscode.Range(foundLine, start, foundLine, end);
                }
            } else {
                // Non-empty part of the line
                const firstNonWs = doc.lineAt(foundLine).firstNonWhitespaceCharacterIndex ?? 0;
                const end = Math.max(firstNonWs + 1, lineText.trimEnd().length);
                range = new vscode.Range(foundLine, firstNonWs, foundLine, end);
            }
        }
    } else if (foundLine !== undefined) {
        const col = foundCol ?? 0;
        const len = token ? token.length : 10;
        range = new vscode.Range(foundLine, col, foundLine, col + len);
    }

    // 4. CRITICAL: Only set diagnostic if a valid error location was found.
    // NEVER fall back to redlining line 0 / the first word of the file!
    if (range) {
        const diag = new vscode.Diagnostic(range, errorMsg, vscode.DiagnosticSeverity.Error);
        diag.source = 'Botox';
        botoxDiagnostics.set(uri, [diag]);
    } else {
        // Clear any stale diagnostics so line 0 / first word is NEVER redlined
        botoxDiagnostics.delete(uri);
    }
}

export function activate(context: vscode.ExtensionContext) {
    setExtensionContext(context);

    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'botox.openPreview';
    context.subscriptions.push(statusBarItem);
    context.subscriptions.push(botoxDiagnostics);

    vscode.window.onDidChangeActiveTextEditor((editor) => {
        updateStatusBar();
        if (editor) {
            syncScrollToPreview(editor);
        }
    }, null, context.subscriptions);
    vscode.workspace.onDidCloseTextDocument(doc => {
        botoxDiagnostics.delete(doc.uri);
    }, null, context.subscriptions);
    updateStatusBar();

    // Check first-run setup interaction
    checkFirstRunSetup(context);

    // Register Webview serializer to restore preview panels across reloads and sessions
    context.subscriptions.push(
        vscode.window.registerWebviewPanelSerializer('botoxPreview', new BotoxPreviewSerializer())
    );

    // 1. Open Preview to the Side
    const openPreviewCmd = vscode.commands.registerCommand(
        'botox.openPreview',
        (uri?: vscode.Uri) => {
            const documentUri = uri || vscode.window.activeTextEditor?.document.uri;
            if (!documentUri) {
                vscode.window.showWarningMessage('Botox: No active Markdown document to preview.');
                return;
            }
            if (!documentUri.fsPath.endsWith('.md') && !documentUri.fsPath.endsWith('.markdown')) {
                vscode.window.showWarningMessage('Botox: Active file is not a Markdown document.');
                return;
            }
            BotoxPreviewPanel.createOrShow(documentUri, vscode.ViewColumn.Beside);
        }
    );

    // 2. Compile to PDF directly
    const compilePdfCmd = vscode.commands.registerCommand(
        'botox.compilePdf',
        async (uri?: vscode.Uri, theme?: string) => {
            const documentUri = uri || vscode.window.activeTextEditor?.document.uri;
            if (!documentUri) {
                vscode.window.showWarningMessage('Botox: No active Markdown document to compile.');
                return;
            }

            const inputPath = documentUri.fsPath;
            let fileContent = '';
            try {
                const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === documentUri.toString());
                fileContent = doc ? doc.getText() : fs.readFileSync(inputPath, 'utf8');
            } catch {}

            const isSlides = /^(marp|slides|presentation):\s*true/im.test(fileContent) ||
                /(slides|deck|presentation)\.md$/i.test(inputPath);

            const defaultExt = isSlides ? 'html' : 'pdf';
            const defaultOutputPath = inputPath.replace(/\.(md|markdown)$/i, `.${defaultExt}`);

            const saveUri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file(defaultOutputPath),
                filters: isSlides
                    ? { 'HTML Presentation Slides': ['html', 'htm'], 'PDF Document': ['pdf'] }
                    : { 'PDF Document': ['pdf'], 'HTML Document': ['html', 'htm'] },
                title: isSlides ? 'Export Presentation Slides with Botox' : 'Export PDF with Botox'
            });

            if (!saveUri) {
                return;
            }

            const extraArgs = theme ? ['--theme', theme] : [];
            const result = await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: 'Compiling with Botox...',
                    cancellable: false
                },
                async () => {
                    return await compileDocument(inputPath, saveUri.fsPath, extraArgs);
                }
            );

            if (result.success) {
                reportCompilationSuccess(documentUri, result.durationMs);
                const isHtml = saveUri.fsPath.endsWith('.html') || saveUri.fsPath.endsWith('.htm');
                const openItem = isHtml ? 'Open HTML Slides' : 'Open PDF';
                vscode.window.showInformationMessage(
                    `Botox: Compiled '${path.basename(saveUri.fsPath)}' in ${result.durationMs}ms`,
                    openItem
                ).then(action => {
                    if (action === openItem) {
                        vscode.env.openExternal(saveUri);
                    }
                });
            } else {
                reportCompilationFailure(documentUri, result.error || 'Compilation failed');
                vscode.window.showErrorMessage(`Botox compilation failed: ${result.error}`);
            }
        }
    );

    // 3. Initialize Document (botox init)
    const initDocumentCmd = vscode.commands.registerCommand(
        'botox.initDocument',
        async () => {
            const filename = await vscode.window.showInputBox({
                prompt: 'Enter the new Markdown filename',
                value: 'document.md'
            });
            if (!filename) return;

            const workspaceFolders = vscode.workspace.workspaceFolders;
            const targetDir = workspaceFolders && workspaceFolders.length > 0
                ? workspaceFolders[0].uri.fsPath
                : process.cwd();

            const res = await runInit(targetDir, filename);
            if (res.success) {
                const docPath = path.join(targetDir, filename);
                const doc = await vscode.workspace.openTextDocument(docPath);
                await vscode.window.showTextDocument(doc);
                vscode.commands.executeCommand('botox.openPreview', doc.uri);
            } else {
                vscode.window.showErrorMessage(`Botox init failed: ${res.error}`);
            }
        }
    );

    // 4. Initialize Slides (botox init slides.md)
    const initSlidesCmd = vscode.commands.registerCommand(
        'botox.initSlides',
        async () => {
            const filename = await vscode.window.showInputBox({
                prompt: 'Enter the presentation filename (e.g. slides.md)',
                value: 'slides.md'
            });
            if (!filename) return;

            const workspaceFolders = vscode.workspace.workspaceFolders;
            const targetDir = workspaceFolders && workspaceFolders.length > 0
                ? workspaceFolders[0].uri.fsPath
                : process.cwd();

            const res = await runInit(targetDir, filename);
            if (res.success) {
                const docPath = path.join(targetDir, filename);
                const doc = await vscode.workspace.openTextDocument(docPath);
                await vscode.window.showTextDocument(doc);
                vscode.commands.executeCommand('botox.openPreview', doc.uri);
            } else {
                vscode.window.showErrorMessage(`Botox init failed: ${res.error}`);
            }
        }
    );

    // 5. Toggle Sync Scroll
    const toggleSyncScrollCmd = vscode.commands.registerCommand(
        'botox.toggleSyncScroll',
        () => {
            const config = vscode.workspace.getConfiguration('botox');
            const current = config.get<boolean>('syncScroll', true);
            config.update('syncScroll', !current, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage(
                `Botox: Follow Cursor is now ${!current ? 'Enabled' : 'Disabled'}`
            );
        }
    );

    // 6. Setup Defaults Wizard
    const setupCmd = vscode.commands.registerCommand(
        'botox.setup',
        () => runSetupWizard(context)
    );

    // 7. Setup in Terminal
    const setupTerminalCmd = vscode.commands.registerCommand(
        'botox.setupTerminal',
        () => runSetupInTerminal()
    );

    // 8. Reset Setup Status (Force Setup on Next Run)
    const resetSetupCmd = vscode.commands.registerCommand(
        'botox.resetSetup',
        async () => {
            await resetSetupState(context);
            vscode.window.showInformationMessage('Botox: Setup state has been reset. You will be prompted to set up on next start.');
        }
    );

    // Watch on save
    const onSaveDisposable = vscode.workspace.onDidSaveTextDocument((document) => {
        const config = vscode.workspace.getConfiguration('botox');
        if (!config.get<boolean>('autoCompileOnSave', true)) {
            return;
        }

        const panel = BotoxPreviewPanel.get(document.uri);
        if (panel) {
            panel.update();
        }
    });

    // Watch on change (debounced live editing before save)
    const onChangeDisposable = vscode.workspace.onDidChangeTextDocument((event) => {
        const config = vscode.workspace.getConfiguration('botox');
        if (!config.get<boolean>('autoCompileOnChange', true)) {
            return;
        }

        const panel = BotoxPreviewPanel.get(event.document.uri);
        if (panel) {
            if (debounceTimeout) {
                clearTimeout(debounceTimeout);
            }
            const delay = config.get<number>('debounceDelay', 120);
            debounceTimeout = setTimeout(() => {
                panel.update(event.document.getText());
            }, delay);
        }
    });

function cleanMarkdownLine(line: string): string {
    return line
        .replace(/^#+\s*/, '')                   // strip heading markers
        .replace(/^[-*+]\s+/, '')                // strip bullet markers
        .replace(/^\d+\.\s+/, '')                // strip numbered list markers
        .replace(/^>\s*/, '')                    // strip blockquotes
        .replace(/`([^`]+)`/g, '$1')             // strip inline code
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // strip links [text](url)
        .replace(/[*_~]+/g, '')                  // strip bold/italic/strike
        .replace(/:::[a-z]*/gi, '')              // strip pandoc fenced divs
        .trim();
}

function getSyncContext(document: vscode.TextDocument, line: number) {
    const totalLines = document.lineCount;
    const currentLineRaw = line < totalLines ? document.lineAt(line).text : '';
    const currentLineTrimmed = currentLineRaw.trim();
    const isHeading = currentLineTrimmed.startsWith('#');
    const queryText = cleanMarkdownLine(currentLineTrimmed);

    // Detect YAML frontmatter boundary if present (only check top lines)
    let frontmatterEndLine = -1;
    if (totalLines > 0 && document.lineAt(0).text.trim().startsWith('---')) {
        const searchLimit = Math.min(totalLines, 200);
        for (let i = 1; i < searchLimit; i++) {
            if (document.lineAt(i).text.trim().startsWith('---')) {
                frontmatterEndLine = i;
                break;
            }
        }
    }

    let prevHeading: { text: string; line: number } | null = null;
    let nextHeading: { text: string; line: number } | null = null;

    for (let i = Math.min(line, totalLines - 1); i >= 0; i--) {
        const text = document.lineAt(i).text.trim();
        if (text.startsWith('#')) {
            prevHeading = { text: cleanMarkdownLine(text), line: i };
            break;
        }
    }

    for (let i = line + 1; i < totalLines; i++) {
        const text = document.lineAt(i).text.trim();
        if (text.startsWith('#')) {
            nextHeading = { text: cleanMarkdownLine(text), line: i };
            break;
        }
    }

    const headingText = prevHeading ? prevHeading.text : '';

    return {
        line,
        totalLines,
        frontmatterEndLine,
        queryText,
        headingText,
        isHeading,
        prevHeading,
        nextHeading
    };
}

    // Follow Cursor & Synchronized Scroll
    let lastScrollTime = 0;
    let pendingScrollTimer: NodeJS.Timeout | undefined;
    let lastTargetLine: number | undefined;

    function syncScrollToPreview(editor: vscode.TextEditor, line?: number) {
        const fsPath = editor.document.uri.fsPath;
        if (!fsPath.endsWith('.md') && !fsPath.endsWith('.markdown')) {
            return;
        }

        const panel = BotoxPreviewPanel.get(editor.document.uri);
        if (!panel) return;

        const config = vscode.workspace.getConfiguration('botox');
        if (!config.get<boolean>('syncScroll', true)) {
            return;
        }

        const targetLine = line !== undefined ? line : editor.selection.active.line;
        lastTargetLine = targetLine;

        const now = Date.now();
        const interval = 20; // 50fps smooth tracking

        const fire = () => {
            if (pendingScrollTimer) {
                clearTimeout(pendingScrollTimer);
                pendingScrollTimer = undefined;
            }
            lastScrollTime = Date.now();
            const l = lastTargetLine !== undefined ? lastTargetLine : targetLine;
            const ctx = getSyncContext(editor.document, l);
            panel.scrollToLine(
                ctx.line,
                ctx.totalLines,
                ctx.queryText,
                ctx.headingText,
                ctx.isHeading,
                ctx.frontmatterEndLine,
                ctx.prevHeading,
                ctx.nextHeading
            );
        };

        if (now - lastScrollTime >= interval) {
            fire();
        } else if (!pendingScrollTimer) {
            pendingScrollTimer = setTimeout(fire, interval - (now - lastScrollTime));
        }
    }

    const onSelectionChangeDisposable = vscode.window.onDidChangeTextEditorSelection((event) => {
        if (event.selections.length > 0) {
            syncScrollToPreview(event.textEditor, event.selections[0].active.line);
        }
    });

    const onVisibleRangesChangeDisposable = vscode.window.onDidChangeTextEditorVisibleRanges((event) => {
        if (event.visibleRanges.length > 0) {
            const range = event.visibleRanges[0];
            const totalLines = event.textEditor.document.lineCount;
            let targetLine: number;
            if (range.start.line === 0) {
                targetLine = 0;
            } else if (range.end.line >= totalLines - 1) {
                targetLine = totalLines - 1;
            } else {
                targetLine = Math.floor((range.start.line + range.end.line) / 2);
            }
            syncScrollToPreview(event.textEditor, targetLine);
        }
    });

    const onConfigChangeDisposable = vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('botox.syncScroll')) {
            const enabled = vscode.workspace.getConfiguration('botox').get<boolean>('syncScroll', true);
            BotoxPreviewPanel.currentPanels.forEach(panel => {
                panel.setSyncScrollEnabled(enabled);
            });
        }
    });

    context.subscriptions.push(
        openPreviewCmd,
        compilePdfCmd,
        initDocumentCmd,
        initSlidesCmd,
        toggleSyncScrollCmd,
        setupCmd,
        setupTerminalCmd,
        resetSetupCmd,
        onSaveDisposable,
        onChangeDisposable,
        onSelectionChangeDisposable,
        onVisibleRangesChangeDisposable,
        onConfigChangeDisposable
    );
}

export function deactivate() {
    BotoxPreviewPanel.currentPanels.forEach(panel => panel.dispose());
}
