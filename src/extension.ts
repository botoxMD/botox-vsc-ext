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

    // Watch on change (debounced live editing)
    const onChangeDisposable = vscode.workspace.onDidChangeTextDocument((event) => {
        const config = vscode.workspace.getConfiguration('botox');
        if (!config.get<boolean>('autoCompileOnChange', false)) {
            return;
        }

        const panel = BotoxPreviewPanel.currentPanels.get(event.document.uri.toString());
        if (panel) {
            if (debounceTimeout) {
                clearTimeout(debounceTimeout);
            }
            debounceTimeout = setTimeout(() => {
                panel.update();
            }, 400);
        }
    });

    context.subscriptions.push(
        openPreviewCmd,
        compilePdfCmd,
        initDocumentCmd,
        initSlidesCmd,
        onSaveDisposable,
        onChangeDisposable
    );
}

export function deactivate() {
    BotoxPreviewPanel.currentPanels.forEach(panel => panel.dispose());
}
