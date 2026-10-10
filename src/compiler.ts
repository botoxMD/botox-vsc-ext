import * as vscode from 'vscode';
import * as child_process from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

export interface CompilationResult {
    success: boolean;
    outputPath?: string;
    pdfBytes?: Uint8Array;
    error?: string;
    durationMs?: number;
}

export interface VectorHeadingInfo {
    page_index: number;
    text: string;
    y_ratio: number;
}

export interface VectorCompilationResult {
    success: boolean;
    pages?: string[];
    headings?: VectorHeadingInfo[];
    numPages?: number;
    isSlides?: boolean;
    pauseIndices?: number[];
    error?: string;
    durationMs?: number;
}

let extensionContext: vscode.ExtensionContext | undefined;

export function setExtensionContext(context: vscode.ExtensionContext) {
    extensionContext = context;
}

export function cleanCompilerError(raw: string, fallbackFileName?: string): string {
    let clean = (raw || '').trim();
    clean = clean.replace(/^Error compiling Typst to vector preview:\s*/i, '');
    clean = clean.replace(/^Error compiling to PDF:\s*/i, '');
    clean = clean.replace(/^Error:\s*/i, '');
    if (fallbackFileName) {
        clean = clean.replace(/\bdocument\.md(?=:|\b)/g, fallbackFileName);
    }
    return clean.trim();
}

export function resolveBotoxBinary(): string {
    const isWin = process.platform === 'win32';
    const binName = isWin ? 'botox.exe' : 'botox';

    // 1. User-configured executable path in VS Code settings
    const config = vscode.workspace.getConfiguration('botox');
    const customPath = config.get<string>('executablePath');
    if (customPath && customPath !== 'botox' && fs.existsSync(customPath)) {
        return customPath;
    }

    // 2. Standard user local binary path (~/.local/bin/botox)
    const homeLocalBin = path.join(os.homedir(), '.local', 'bin', binName);
    if (fs.existsSync(homeLocalBin)) {
        return homeLocalBin;
    }

    // 3. System PATH or default binary name
    return binName;
}

export function hasBotoxBinary(): boolean {
    const bin = resolveBotoxBinary();
    if (path.isAbsolute(bin)) {
        return fs.existsSync(bin);
    }
    try {
        const checkCmd = process.platform === 'win32' ? 'where' : 'which';
        const res = child_process.spawnSync(checkCmd, [bin], { encoding: 'utf-8' });
        return res.status === 0 && res.stdout.trim().length > 0;
    } catch {
        return false;
    }
}

export const BOTOX_CLI_REPO_URL = 'https://github.com/botoxMD/botox-cli';

export async function promptInstallBotoxBinary(): Promise<void> {
    const installAction = 'Install Botox (GitHub)';
    const settingsAction = 'Configure Path';
    const choice = await vscode.window.showErrorMessage(
        'Botox compiler binary not found. Please install the Botox CLI to compile documents and view live previews.',
        installAction,
        settingsAction
    );

    if (choice === installAction) {
        vscode.env.openExternal(vscode.Uri.parse(BOTOX_CLI_REPO_URL));
    } else if (choice === settingsAction) {
        vscode.commands.executeCommand('workbench.action.openSettings', 'botox.executablePath');
    }
}

export async function ensureBotoxBinary(): Promise<string> {
    const current = resolveBotoxBinary();
    if (hasBotoxBinary()) {
        return current;
    }

    await promptInstallBotoxBinary();
    throw new Error(`Botox CLI binary is not installed. Please install it from ${BOTOX_CLI_REPO_URL}`);
}

const activePreviewProcs = new Map<string, child_process.ChildProcess>();

export function abortActivePreview(inputPath: string): boolean {
    const existing = activePreviewProcs.get(inputPath);
    if (existing && !existing.killed) {
        try {
            existing.kill('SIGTERM');
        } catch {
            // ignore kill error
        }
        activePreviewProcs.delete(inputPath);
        return true;
    }
    return false;
}

export async function compileForPreview(
    inputPath: string,
    liveContent?: string,
    theme?: string
): Promise<VectorCompilationResult> {
    abortActivePreview(inputPath);

    let binary: string;
    try {
        binary = await ensureBotoxBinary();
    } catch (e: any) {
        return {
            success: false,
            error: `Could not obtain Botox compiler binary: ${e.message}`
        };
    }
    const startTime = Date.now();
    const targetOutput = path.join(
        os.tmpdir(),
        `botox_preview_${Date.now()}_${process.pid}.json`
    );
    const inputDir = path.dirname(inputPath);
    const useStdin = typeof liveContent === 'string';

    const args = useStdin
        ? ['-', '-o', targetOutput, '--resource-dir', inputDir, '--source-file', inputPath]
        : [inputPath, '-o', targetOutput];

    if (theme) {
        args.push('--theme', theme);
    }

    return new Promise((resolve) => {
        const proc = child_process.spawn(binary, args, {
            cwd: inputDir
        });
        activePreviewProcs.set(inputPath, proc);

        let stdout = '';
        let stderr = '';

        proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
        proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

        proc.on('error', (err: Error) => {
            if (activePreviewProcs.get(inputPath) === proc) {
                activePreviewProcs.delete(inputPath);
            }
            resolve({
                success: false,
                error: err.message,
                durationMs: Date.now() - startTime
            });
        });

        proc.on('close', (code: number | null) => {
            if (activePreviewProcs.get(inputPath) === proc) {
                activePreviewProcs.delete(inputPath);
            }
            const durationMs = Date.now() - startTime;

            if (proc.killed) {
                try {
                    if (fs.existsSync(targetOutput)) fs.unlinkSync(targetOutput);
                } catch {
                    // ignore
                }
                resolve({
                    success: false,
                    error: 'Aborted: newer keystroke received',
                    durationMs
                });
                return;
            }

            if (code !== 0) {
                resolve({
                    success: false,
                    error: cleanCompilerError(stderr || stdout || `Process exited with code ${code}`, path.basename(inputPath)),
                    durationMs
                });
                return;
            }

            if (!fs.existsSync(targetOutput)) {
                resolve({
                    success: false,
                    error: `Preview output '${targetOutput}' was not created. ${stderr}`,
                    durationMs
                });
                return;
            }

            try {
                const rawJson = fs.readFileSync(targetOutput, 'utf-8');
                try {
                    fs.unlinkSync(targetOutput);
                } catch {
                    // ignore unlink errors
                }
                const parsed = JSON.parse(rawJson);
                const isSlides = parsed.is_slides !== undefined
                    ? Boolean(parsed.is_slides)
                    : Boolean(parsed.pages && parsed.pages.length > 0 && parsed.pages[0].includes('841.89'));
                resolve({
                    success: true,
                    pages: parsed.pages || [],
                    headings: parsed.headings || [],
                    numPages: parsed.num_pages || parsed.pages?.length || 0,
                    isSlides,
                    pauseIndices: parsed.pause_indices || [],
                    durationMs
                });
            } catch (e: any) {
                resolve({
                    success: false,
                    error: `Failed to parse vector preview: ${e.message}`,
                    durationMs
                });
            }
        });

        if (useStdin && proc.stdin) {
            proc.stdin.write(liveContent);
            proc.stdin.end();
        }
    });
}

export async function compileDocument(
    inputPath: string,
    outputPath?: string,
    extraArgs: string[] = []
): Promise<CompilationResult> {
    let binary: string;
    try {
        binary = await ensureBotoxBinary();
    } catch (e: any) {
        return {
            success: false,
            error: `Could not obtain Botox compiler binary: ${e.message}`
        };
    }
    const startTime = Date.now();

    const targetOutput = outputPath || path.join(os.tmpdir(), `botox_preview_${Date.now()}_${path.basename(inputPath, '.md')}.pdf`);
    const args = [inputPath, '-o', targetOutput, ...extraArgs];

    const inputDir = path.dirname(inputPath);

    return new Promise((resolve) => {
        child_process.execFile(
            binary,
            args,
            { cwd: inputDir, maxBuffer: 10 * 1024 * 1024 },
            (error, stdout, stderr) => {
                const durationMs = Date.now() - startTime;
                if (error) {
                    const message = stderr || stdout || error.message;
                    resolve({
                        success: false,
                        error: cleanCompilerError(message, path.basename(inputPath)),
                        durationMs
                    });
                    return;
                }

                if (!fs.existsSync(targetOutput)) {
                    resolve({
                        success: false,
                        error: `Output file '${targetOutput}' was not created. ${stderr}`,
                        durationMs
                    });
                    return;
                }

                try {
                    const pdfBytes = fs.readFileSync(targetOutput);
                    resolve({
                        success: true,
                        outputPath: targetOutput,
                        pdfBytes: new Uint8Array(pdfBytes),
                        durationMs
                    });
                } catch (e: any) {
                    resolve({
                        success: false,
                        error: `Failed to read compiled PDF: ${e.message}`,
                        durationMs
                    });
                }
            }
        );
    });
}

export async function runInit(
    targetDir: string,
    filename: string
): Promise<{ success: boolean; error?: string }> {
    let binary: string;
    try {
        binary = await ensureBotoxBinary();
    } catch (e: any) {
        return {
            success: false,
            error: `Could not obtain Botox compiler binary: ${e.message}`
        };
    }
    return new Promise((resolve) => {
        child_process.execFile(
            binary,
            ['init', filename],
            { cwd: targetDir },
            (error, stdout, stderr) => {
                if (error) {
                    resolve({ success: false, error: stderr || stdout || error.message });
                } else {
                    resolve({ success: true });
                }
            }
        );
    });
}
