import * as vscode from 'vscode';
import * as path from 'path';
import { BotoxPreviewPanel } from './preview';
import { compileDocument, runInit } from './compiler';

let debounceTimeout: NodeJS.Timeout | undefined;

export function activate(context: vscode.ExtensionContext) {
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
        async (uri?: vscode.Uri) => {
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
                    const result = await compileDocument(inputPath, saveUri.fsPath);
                    if (result.success) {
                        const openItem = 'Open PDF';
                        const action = await vscode.window.showInformationMessage(
                            `Botox: Compiled '${path.basename(saveUri.fsPath)}' in ${result.durationMs}ms`,
                            openItem
                        );
                        if (action === openItem) {
                            vscode.env.openExternal(saveUri);
                        }
                    } else {
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

    // Watch on save
    const onSaveDisposable = vscode.workspace.onDidSaveTextDocument((document) => {
        const config = vscode.workspace.getConfiguration('botox');
        if (!config.get<boolean>('autoCompileOnSave', true)) {
            return;
        }

        const panel = BotoxPreviewPanel.currentPanels.get(document.uri.toString());
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

        const panel = BotoxPreviewPanel.currentPanels.get(event.document.uri.toString());
        if (panel) {
            if (debounceTimeout) {
                clearTimeout(debounceTimeout);
            }
            const delay = config.get<number>('debounceDelay', 350);
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

    // Detect YAML frontmatter boundary if present
    let frontmatterEndLine = -1;
    if (totalLines > 0 && document.lineAt(0).text.trim().startsWith('---')) {
        for (let i = 1; i < totalLines; i++) {
            if (document.lineAt(i).text.trim().startsWith('---')) {
                frontmatterEndLine = i;
                break;
            }
        }
    }

    let headingText = '';
    for (let i = Math.min(line, totalLines - 1); i >= 0; i--) {
        const text = document.lineAt(i).text.trim();
        if (text.startsWith('#')) {
            headingText = cleanMarkdownLine(text);
            break;
        }
    }

    return {
        line,
        totalLines,
        frontmatterEndLine,
        queryText,
        headingText,
        isHeading
    };
}

    // Follow Cursor & Synchronized Scroll
    let scrollThrottleTimeout: NodeJS.Timeout | undefined;
    const syncScrollToPreview = (editor: vscode.TextEditor, line: number) => {
        const fsPath = editor.document.uri.fsPath;
        if (!fsPath.endsWith('.md') && !fsPath.endsWith('.markdown')) {
            return;
        }

        const panel = BotoxPreviewPanel.currentPanels.get(editor.document.uri.toString());
        if (!panel) return;

        const config = vscode.workspace.getConfiguration('botox');
        if (!config.get<boolean>('syncScroll', true)) {
            return;
        }

        if (scrollThrottleTimeout) {
            return;
        }

        scrollThrottleTimeout = setTimeout(() => {
            scrollThrottleTimeout = undefined;
            const ctx = getSyncContext(editor.document, line);
            panel.scrollToLine(
                ctx.line,
                ctx.totalLines,
                ctx.queryText,
                ctx.headingText,
                ctx.isHeading,
                ctx.frontmatterEndLine
            );
        }, 40);
    };

    const onSelectionChangeDisposable = vscode.window.onDidChangeTextEditorSelection((event) => {
        if (event.selections.length > 0) {
            syncScrollToPreview(event.textEditor, event.selections[0].active.line);
        }
    });

    const onVisibleRangesChangeDisposable = vscode.window.onDidChangeTextEditorVisibleRanges((event) => {
        if (event.visibleRanges.length > 0) {
            syncScrollToPreview(event.textEditor, event.visibleRanges[0].start.line);
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
