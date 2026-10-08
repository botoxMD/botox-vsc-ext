import * as vscode from 'vscode';
import * as path from 'path';
import { BotoxPreviewPanel } from './preview';
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

    let line = 0;
    const match = errorMsg.match(/(?:line|row)\s*(\d+)/i) || errorMsg.match(/:(\d+):(\d+)/);
    if (match) {
        const parsed = parseInt(match[1], 10);
        if (!isNaN(parsed) && parsed > 0) {
            line = parsed - 1;
        }
    }
    const range = new vscode.Range(line, 0, line, 100);
    const diag = new vscode.Diagnostic(range, errorMsg, vscode.DiagnosticSeverity.Error);
    diag.source = 'Botox';
    botoxDiagnostics.set(uri, [diag]);
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
            const defaultOutputPath = inputPath.replace(/\.(md|markdown)$/i, '.pdf');

            const saveUri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file(defaultOutputPath),
                filters: { 'PDF Document': ['pdf'] },
                title: 'Export PDF with Botox'
            });

            if (!saveUri) {
                return;
            }

            vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: 'Compiling with Botox...',
                    cancellable: false
                },
                async () => {
                    const extraArgs = theme ? ['--theme', theme] : [];
                    const result = await compileDocument(inputPath, saveUri.fsPath, extraArgs);
                    if (result.success) {
                        reportCompilationSuccess(documentUri, result.durationMs);
                        const openItem = 'Open PDF';
                        const action = await vscode.window.showInformationMessage(
                            `Botox: Compiled '${path.basename(saveUri.fsPath)}' in ${result.durationMs}ms`,
                            openItem
                        );
                        if (action === openItem) {
                            vscode.env.openExternal(saveUri);
                        }
                    } else {
                        reportCompilationFailure(documentUri, result.error || 'Compilation failed');
                        vscode.window.showErrorMessage(`Botox compilation failed: ${result.error}`);
                    }
                }
            );
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
