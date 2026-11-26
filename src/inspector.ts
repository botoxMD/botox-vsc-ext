import * as vscode from 'vscode';
import * as child_process from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { resolveBotoxBinary } from './compiler';

export interface ColumnStats {
    col: number;
    x_min_pt: number;
    x_max_pt: number;
    content_bottom_y: number;
    fill_pct: number;
    bottom_dead_space_pt: number;
    block_count: number;
}

export interface PageSummary {
    page: number;
    width_pt: number;
    height_pt: number;
    content_bbox_pt: [number, number, number, number];
    fill_pct: number;
    bottom_dead_space_pt: number;
    columns: ColumnStats[];
    block_count: number;
    line_count: number;
}

export interface LayoutIssue {
    code: string;
    severity: 'error' | 'warn' | 'hint' | string;
    page: number;
    col: number;
    bbox_pt: [number, number, number, number];
    src_line?: number | null;
    text_excerpt: string;
    reclaimable_pt?: number | null;
    metrics?: Record<string, any>;
    suggestion: string;
}

export interface ReclaimPlan {
    target_pages: number;
    current_pages: number;
    overflow_pt: number;
    total_reclaimable_pt: number;
    achievable: boolean;
    steps: LayoutIssue[];
}

export interface InspectReport {
    file: string;
    page_count: number;
    last_page_fill_pct: number;
    pages: PageSummary[];
    issue_counts: {
        error: number;
        warn: number;
        hint: number;
        total: number;
    };
    issues: LayoutIssue[];
    reclaim_plan?: ReclaimPlan | null;
}

export interface ProbeMatch {
    kind: string;
    page: number;
    col: number;
    bbox_pt: [number, number, number, number];
    src_line?: number | null;
    text: string;
}

export interface ProbeReport {
    file: string;
    query: string;
    page?: number | null;
    matches: ProbeMatch[];
    blocks: Array<{
        id: number;
        kind: string;
        page: number;
        col: number;
        src_line?: number | null;
        text_preview: string;
    }>;
}

export interface BotoxTemplatePreset {
    name: string;
    label: string;
    description: string;
    detail: string;
    isSlides?: boolean;
}

export const BOTOX_TEMPLATES: BotoxTemplatePreset[] = [
    {
        name: 'cheatsheet',
        label: '$(list-flat) cheatsheet',
        description: 'A4 2-col | margin 0.35cm | 8.1pt / 7pt code | compact',
        detail: 'Ultra-dense 2-column A4 reference sheet with minimal margins & compact code'
    },
    {
        name: 'paper',
        label: '$(mortar-board) paper',
        description: 'A4 2-col | margin 1.7x2cm | 10pt / 8pt code | academic',
        detail: 'Formal 2-column academic research paper (IEEE/arXiv) with abstract & bibliography'
    },
    {
        name: 'report',
        label: '$(file-code) report',
        description: 'A4 1-col | margin 2cm | 10pt / 8.5pt code | technical',
        detail: 'Engineering design doc / RFC with TOC, numbered sections & Kroki diagrams'
    },
    {
        name: 'notes',
        label: '$(notebook) notes',
        description: 'A4 1-col | margin 2.2x2cm | 10.5pt / 8.5pt code | modern',
        detail: 'Structured study guide or lecture notes with callouts & scannable TOC'
    },
    {
        name: 'cv',
        label: '$(account) cv',
        description: 'A4 1-col | margin 1.4x1.2cm | 9.5pt / 8pt code | minimal',
        detail: 'Crisp single-page resume / CV with tight margins & Swiss typography'
    },
    {
        name: 'essay',
        label: '$(book) essay',
        description: 'A4 1-col | margin 3x2.8cm | 11pt / 9pt code | elegant',
        detail: 'Long-form essay or manuscript with classic book margins & serif leading'
    },
    {
        name: 'memo',
        label: '$(mail) memo',
        description: 'A4 1-col | margin 2.5x2.2cm | 10.5pt / 8.5pt code | minimal',
        detail: 'Concise executive memo or brief with distraction-free hierarchy'
    },
    {
        name: 'landscape',
        label: '$(split-horizontal) landscape',
        description: 'A4-L 3-col | margin 1x0.9cm | 8.5pt / 7.5pt code | compact',
        detail: 'Wide 3-column horizontal A4 layout for comparison matrices & system maps'
    },
    {
        name: 'slides',
        label: '$(vm) slides',
        description: '16:9 deck | 20pt / 15pt code | paginated',
        detail: 'Interactive 16:9 presentation slide deck (supports --theme overrides)',
        isSlides: true
    }
];

export const layoutDiagnostics = vscode.languages.createDiagnosticCollection('botox-layout');
const latestReports = new Map<string, InspectReport>();

export function getLatestInspectReport(uri: vscode.Uri): InspectReport | undefined {
    return latestReports.get(uri.toString());
}

function getInspectEnv(): NodeJS.ProcessEnv {
    const config = vscode.workspace.getConfiguration('botox');
    const krokiUrl = config.get<string>('krokiUrl')?.trim();
    return {
        ...process.env,
        ...(krokiUrl ? { KROKI_ENDPOINT: krokiUrl } : {})
    };
}

function execBotox(args: string[], cwd?: string, timeoutMs = 15000): Promise<string> {
    const binary = resolveBotoxBinary();
    return new Promise((resolve, reject) => {
        child_process.execFile(
            binary,
            args,
            {
                cwd,
                env: getInspectEnv(),
                maxBuffer: 16 * 1024 * 1024,
                timeout: timeoutMs
            },
            (err, stdout, stderr) => {
                if (err) {
                    reject(new Error((stderr || err.message || String(err)).trim()));
                } else {
                    resolve(stdout);
                }
            }
        );
    });
}

async function withLiveFile<T>(
    filePath: string,
    liveContent: string | undefined,
    fn: (effectivePath: string) => Promise<T>
): Promise<T> {
    if (liveContent === undefined) {
        return fn(filePath);
    }
    const dir = path.dirname(filePath);
    const tmpName = `.botox-inspect-${process.pid}-${crypto.randomBytes(4).toString('hex')}.md`;
    const tmpPath = path.join(dir, tmpName);
    try {
        fs.writeFileSync(tmpPath, liveContent, 'utf8');
        return await fn(tmpPath);
    } finally {
        try {
            if (fs.existsSync(tmpPath)) {
                fs.unlinkSync(tmpPath);
            }
        } catch {
            // ignore cleanup errors
        }
    }
}

export function formatLayoutStatusText(report: InspectReport): {
    text: string;
    tooltip: string;
    isWarning: boolean;
} {
    const pages = report.page_count;
    const lastFill = Math.round(report.last_page_fill_pct);
    const { error, warn, hint } = report.issue_counts;
    const hasSpill = report.issues.some((i) => i.code === 'PAGE_SPILLOVER');

    const parts: string[] = [];
    if (error > 0) parts.push(`${error}e`);
    if (warn > 0) parts.push(`${warn}w`);
    if (error === 0 && warn === 0 && hint > 0) parts.push(`${hint}h`);

    const statusBadge = parts.length > 0 ? parts.join(' ') : '✓';
    const fillLabel = hasSpill ? `${lastFill}% spill` : `${lastFill}%`;
    const icon = error > 0 || warn > 0 || hasSpill ? '$(warning)' : '$(book)';
    const text = `${icon} Botox: ${pages}p (${fillLabel}) · ${statusBadge}`;

    const tooltipLines = [
        `Botox Layout Health: ${pages} page(s), last page ${report.last_page_fill_pct.toFixed(1)}% full`,
        `Issues: ${error} error(s), ${warn} warning(s), ${hint} hint(s)`,
        'Click for Botox Layout & Templates menu'
    ];

    return {
        text,
        tooltip: tooltipLines.join('\n'),
        isWarning: error > 0 || warn > 0 || hasSpill
    };
}

export async function runBotoxInspect(
    filePath: string,
    options?: { targetPages?: number; theme?: string; liveContent?: string }
): Promise<InspectReport | null> {
    return withLiveFile(filePath, options?.liveContent, async (effectivePath) => {
        const args = ['inspect', effectivePath, '--json'];
        if (options?.targetPages && options.targetPages > 0) {
            args.push('--target-pages', String(options.targetPages));
        }
        if (options?.theme) {
            args.push('--theme', options.theme);
        }
        try {
            const stdout = await execBotox(args, path.dirname(filePath));
            return JSON.parse(stdout) as InspectReport;
        } catch {
            return null;
        }
    });
}

export async function runBotoxProbeAtPoint(
    filePath: string,
    page: number,
    xPt: number,
    yPt: number,
    theme?: string,
    liveContent?: string
): Promise<number | null> {
    return withLiveFile(filePath, liveContent, async (effectivePath) => {
        const rx = Math.max(0, xPt - 6).toFixed(1);
        const ry = Math.max(0, yPt - 6).toFixed(1);
        const args = ['probe', effectivePath, '--page', String(page), '--region', `${rx},${ry},12,12`, '--json'];
        if (theme) {
            args.push('--theme', theme);
        }
        try {
            const stdout = await execBotox(args, path.dirname(filePath), 10000);
            const report = JSON.parse(stdout) as ProbeReport;
            for (const m of report.matches) {
                if (typeof m.src_line === 'number' && m.src_line > 0) {
                    return m.src_line;
                }
            }
            for (const b of report.blocks) {
                if (typeof b.src_line === 'number' && b.src_line > 0) {
                    return b.src_line;
                }
            }
            return null;
        } catch {
            return null;
        }
    });
}

export async function runBotoxTemplate(templateName: string, full = false): Promise<string> {
    const args = ['template', templateName];
    if (full) {
        args.push('--full');
    }
    return execBotox(args);
}

export async function runBotoxInitTemplate(targetPath: string, templateName: string): Promise<void> {
    await execBotox(['init', targetPath, '--template', templateName, '--force'], path.dirname(targetPath));
}

export function applyLayoutDiagnostics(uri: vscode.Uri, report: InspectReport | null): void {
    if (!report) {
        layoutDiagnostics.delete(uri);
        latestReports.delete(uri.toString());
        return;
    }
    latestReports.set(uri.toString(), report);

    const config = vscode.workspace.getConfiguration('botox');
    if (!config.get<boolean>('layoutDiagnostics', true)) {
        layoutDiagnostics.delete(uri);
        return;
    }

    const doc = vscode.workspace.textDocuments.find(
        (d) => d.uri.toString() === uri.toString() || d.uri.fsPath === uri.fsPath
    );
    const diags: vscode.Diagnostic[] = [];

    for (const issue of report.issues) {
        let lineIdx = 0;
        if (typeof issue.src_line === 'number' && issue.src_line > 0) {
            lineIdx = issue.src_line - 1;
        } else if (issue.code === 'PAGE_SPILLOVER' && doc) {
            lineIdx = Math.max(0, doc.lineCount - 1);
        }

        let range: vscode.Range;
        if (doc && lineIdx >= 0 && lineIdx < doc.lineCount) {
            const lineObj = doc.lineAt(lineIdx);
            range = new vscode.Range(
                lineIdx,
                lineObj.firstNonWhitespaceCharacterIndex,
                lineIdx,
                lineObj.text.length
            );
        } else {
            range = new vscode.Range(Math.max(0, lineIdx), 0, Math.max(0, lineIdx), 80);
        }

        const sev =
            issue.severity === 'error'
                ? vscode.DiagnosticSeverity.Error
                : issue.severity === 'warn'
                    ? vscode.DiagnosticSeverity.Warning
                    : vscode.DiagnosticSeverity.Hint;

        const reclaimNote =
            typeof issue.reclaimable_pt === 'number' && issue.reclaimable_pt > 0
                ? ` [reclaim ~${issue.reclaimable_pt.toFixed(1)}pt]`
                : '';
        const diag = new vscode.Diagnostic(
            range,
            `[${issue.code}] ${issue.suggestion}${reclaimNote}`,
            sev
        );
        diag.source = 'Botox Layout';
        diag.code = issue.code;
        diags.push(diag);
    }

    layoutDiagnostics.set(uri, diags);
}

export async function jumpToEditorLine(uri: vscode.Uri, oneBasedLine: number): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(uri);
    const lineIdx = Math.max(0, Math.min(doc.lineCount - 1, oneBasedLine - 1));
    const existingEditor = vscode.window.visibleTextEditors.find(
        (e) => e.document.uri.toString() === uri.toString() || e.document.uri.fsPath === uri.fsPath
    );
    const editor = existingEditor
        ? await vscode.window.showTextDocument(doc, { viewColumn: existingEditor.viewColumn, preserveFocus: false })
        : await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preserveFocus: false });

    const pos = new vscode.Position(lineIdx, 0);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
}

/**
 * Provides one-click Quick Fixes for Botox layout diagnostics (ORPHAN_HEADING, SPLIT_CODE_BLOCK, GUTTER_INTRUSION).
 */
export class BotoxLayoutCodeActionProvider implements vscode.CodeActionProvider {
    public static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];

    provideCodeActions(
        document: vscode.TextDocument,
        _range: vscode.Range,
        context: vscode.CodeActionContext
    ): vscode.CodeAction[] {
        const actions: vscode.CodeAction[] = [];

        for (const diag of context.diagnostics) {
            if (diag.source !== 'Botox Layout') {
                continue;
            }
            const code = typeof diag.code === 'string' ? diag.code : '';
            const lineIdx = diag.range.start.line;
            if (lineIdx < 0 || lineIdx >= document.lineCount) {
                continue;
            }

            if (code === 'ORPHAN_HEADING' || code === 'SPLIT_CODE_BLOCK') {
                const colBreak = new vscode.CodeAction(
                    'Botox: Insert \\columnbreak above',
                    vscode.CodeActionKind.QuickFix
                );
                const edit1 = new vscode.WorkspaceEdit();
                edit1.insert(document.uri, new vscode.Position(lineIdx, 0), '\\columnbreak\n\n');
                colBreak.edit = edit1;
                colBreak.diagnostics = [diag];
                colBreak.isPreferred = true;
                actions.push(colBreak);

                const pageBreak = new vscode.CodeAction(
                    'Botox: Insert \\newpage above',
                    vscode.CodeActionKind.QuickFix
                );
                const edit2 = new vscode.WorkspaceEdit();
                edit2.insert(document.uri, new vscode.Position(lineIdx, 0), '\\newpage\n\n');
                pageBreak.edit = edit2;
                pageBreak.diagnostics = [diag];
                actions.push(pageBreak);
            }

            if (code === 'SPLIT_CODE_BLOCK' || code === 'GUTTER_INTRUSION') {
                const lineText = document.lineAt(lineIdx).text;
                if (/^\s*```/.test(lineText) && !/\b(?:size|fontsize|code-fontsize)=/i.test(lineText)) {
                    const shrink = new vscode.CodeAction(
                        'Botox: Shrink this code block (size=7pt)',
                        vscode.CodeActionKind.QuickFix
                    );
                    const edit = new vscode.WorkspaceEdit();
                    edit.insert(
                        document.uri,
                        new vscode.Position(lineIdx, lineText.length),
                        ' size=7pt'
                    );
                    shrink.edit = edit;
                    shrink.diagnostics = [diag];
                    actions.push(shrink);
                }
            }
        }

        return actions;
    }
}

export async function runNewFromTemplateCommand(): Promise<void> {
    const picked = await vscode.window.showQuickPick(BOTOX_TEMPLATES, {
        title: 'Botox: Choose a Header & Layout Template',
        placeHolder: 'Select a layout preset (cheatsheet, paper, report, notes, cv, essay, memo, landscape, slides)...',
        matchOnDescription: true,
        matchOnDetail: true
    });
    if (!picked) return;

    const defaultName = `${picked.name}.md`;
    const filename = await vscode.window.showInputBox({
        prompt: `Enter filename for new '${picked.name}' document`,
        value: defaultName
    });
    if (!filename) return;

    const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!wsFolder) {
        vscode.window.showErrorMessage('Please open a folder or workspace first.');
        return;
    }

    const fullPath = path.join(wsFolder, filename);
    try {
        await runBotoxInitTemplate(fullPath, picked.name);
        const doc = await vscode.workspace.openTextDocument(fullPath);
        await vscode.window.showTextDocument(doc);
        vscode.window.showInformationMessage(`Initialized '${picked.name}' template → ${filename}`);
    } catch (e: any) {
        vscode.window.showErrorMessage(`Failed to initialize template: ${e.message || e}`);
    }
}

export async function runInsertHeaderTemplateCommand(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage('Open a Markdown document first to insert a header template.');
        return;
    }

    const picked = await vscode.window.showQuickPick(BOTOX_TEMPLATES, {
        title: 'Botox: Insert YAML Header Template',
        placeHolder: 'Choose a layout header preset to insert at the top of this file...',
        matchOnDescription: true,
        matchOnDetail: true
    });
    if (!picked) return;

    try {
        const header = await runBotoxTemplate(picked.name, false);
        const text = editor.document.getText();
        const fmMatch = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);

        const edit = new vscode.WorkspaceEdit();
        if (fmMatch) {
            const choice = await vscode.window.showWarningMessage(
                'This document already has YAML frontmatter. Replace it with the selected template header?',
                'Replace Frontmatter',
                'Cancel'
            );
            if (choice !== 'Replace Frontmatter') return;
            const endPos = editor.document.positionAt(fmMatch[0].length);
            edit.replace(editor.document.uri, new vscode.Range(new vscode.Position(0, 0), endPos), `${header}\n`);
        } else {
            edit.insert(editor.document.uri, new vscode.Position(0, 0), `${header}\n`);
        }

        await vscode.workspace.applyEdit(edit);
        vscode.window.showInformationMessage(`Applied '${picked.name}' header template.`);
    } catch (e: any) {
        vscode.window.showErrorMessage(`Failed to load template header: ${e.message || e}`);
    }
}
