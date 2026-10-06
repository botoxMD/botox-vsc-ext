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

export function resolveBotoxBinary(): string {
    const config = vscode.workspace.getConfiguration('botox');
    const customPath = config.get<string>('executablePath');
    if (customPath && customPath !== 'botox' && fs.existsSync(customPath)) {
        return customPath;
    }

    const homeLocalBin = path.join(os.homedir(), '.local', 'bin', 'botox');
    if (fs.existsSync(homeLocalBin)) {
        return homeLocalBin;
    }

    return 'botox';
}

export async function compileDocument(
    inputPath: string,
    outputPath?: string,
    extraArgs: string[] = []
): Promise<CompilationResult> {
    const binary = resolveBotoxBinary();
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
                        error: message.trim(),
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
    const binary = resolveBotoxBinary();
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
