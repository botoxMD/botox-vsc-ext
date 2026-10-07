import * as vscode from 'vscode';
import * as child_process from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as https from 'https';

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
    error?: string;
    durationMs?: number;
}

let extensionContext: vscode.ExtensionContext | undefined;

export function setExtensionContext(context: vscode.ExtensionContext) {
    extensionContext = context;
}

export function cleanCompilerError(raw: string): string {
    let clean = (raw || '').trim();
    clean = clean.replace(/^Error compiling Typst to vector preview:\s*/i, '');
    clean = clean.replace(/^Error compiling to PDF:\s*/i, '');
    clean = clean.replace(/^Error:\s*/i, '');
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

    if (extensionContext) {
        // 3. Bundled binary inside the extension's `bin/` directory
        const directBundled = path.join(extensionContext.extensionPath, 'bin', binName);
        if (fs.existsSync(directBundled)) {
            return directBundled;
        }

        // 4. Platform/arch-specific bundled directory (e.g. `bin/linux-x64/botox`)
        const platformArch = `${process.platform}-${process.arch}`;
        const archBundled = path.join(extensionContext.extensionPath, 'bin', platformArch, binName);
        if (fs.existsSync(archBundled)) {
            return archBundled;
        }

        // 5. Downloaded/cached binary in VS Code global storage
        const storageBin = path.join(extensionContext.globalStorageUri.fsPath, 'bin', binName);
        if (fs.existsSync(storageBin)) {
            return storageBin;
        }
    }

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

function downloadFile(url: string, dest: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const follow = (curUrl: string, maxRedirects: number = 6) => {
            if (maxRedirects <= 0) {
                return reject(new Error('Too many redirects while downloading Botox binary'));
            }
            https.get(curUrl, { headers: { 'User-Agent': 'vscode-botox' } }, (res) => {
                if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    return follow(res.headers.location, maxRedirects - 1);
                }
                if (res.statusCode !== 200) {
                    return reject(new Error(`Download failed with HTTP ${res.statusCode}: ${res.statusMessage}`));
                }
                const fileStream = fs.createWriteStream(dest);
                res.pipe(fileStream);
                fileStream.on('finish', () => {
                    fileStream.close();
                    resolve();
                });
                fileStream.on('error', (err) => {
                    try { fs.unlinkSync(dest); } catch {}
                    reject(err);
                });
            }).on('error', (err) => {
                try { fs.unlinkSync(dest); } catch {}
                reject(err);
            });
        };
        follow(url);
    });
}

function fetchReleaseAssetUrl(target: string, ext: string): Promise<string> {
    const fallback = `https://github.com/botoxMD/botox-cli/releases/latest/download/botox-v0.1.1-${target}.${ext}`;
    return new Promise((resolve) => {
        https.get('https://api.github.com/repos/botoxMD/botox-cli/releases/latest', {
            headers: { 'User-Agent': 'vscode-botox' }
        }, (res) => {
            if (res.statusCode !== 200) {
                return resolve(fallback);
            }
            let body = '';
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => {
                try {
                    const data = JSON.parse(body);
                    const targetSuffix = `-${target}.${ext}`;
                    const asset = data.assets?.find((a: any) =>
                        typeof a.name === 'string' && (a.name.endsWith(targetSuffix) || a.name === `botox-${target}.${ext}`)
                    );
                    if (asset && asset.browser_download_url) {
                        return resolve(asset.browser_download_url);
                    }
                } catch {}
                resolve(fallback);
            });
        }).on('error', () => resolve(fallback));
    });
}

export async function ensureBotoxBinary(): Promise<string> {
    const current = resolveBotoxBinary();
    if (hasBotoxBinary()) {
        return current;
    }

    if (!extensionContext) {
        return current;
    }

    const platform = process.platform;
    const arch = process.arch;
    let target = '';

    if (platform === 'linux') {
        target = arch === 'x64' ? 'x86_64-unknown-linux-musl' : (arch === 'arm64' ? 'aarch64-unknown-linux-gnu' : '');
    } else if (platform === 'darwin') {
        target = arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
    } else if (platform === 'win32' && arch === 'x64') {
        target = 'x86_64-pc-windows-msvc';
    }

    if (!target) {
        return current;
    }

    const isWin = platform === 'win32';
    const ext = isWin ? 'zip' : 'tar.gz';
    const archiveName = `botox-${target}.${ext}`;
    const downloadUrl = await fetchReleaseAssetUrl(target, ext);

    const destDir = path.join(extensionContext.globalStorageUri.fsPath, 'bin');
    fs.mkdirSync(destDir, { recursive: true });
    const destBinary = path.join(destDir, isWin ? 'botox.exe' : 'botox');

    return vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: `Botox: Downloading standalone compiler for ${platform}-${arch}...`,
            cancellable: false
        },
        async (progress) => {
            const tempArchive = path.join(destDir, archiveName);
            progress.report({ message: 'Downloading prebuilt release from GitHub...' });
            await downloadFile(downloadUrl, tempArchive);

            progress.report({ message: 'Extracting...' });
            child_process.execSync(`tar -xf "${tempArchive}" -C "${destDir}"`);
            try { fs.unlinkSync(tempArchive); } catch {}

            if (!isWin && fs.existsSync(destBinary)) {
                fs.chmodSync(destBinary, 0o755);
            }

            return destBinary;
        }
    );
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
        ? ['-', '-o', targetOutput, '--resource-dir', inputDir]
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
                    error: cleanCompilerError(stderr || stdout || `Process exited with code ${code}`),
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
                resolve({
                    success: true,
                    pages: parsed.pages || [],
                    headings: parsed.headings || [],
                    numPages: parsed.num_pages || parsed.pages?.length || 0,
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
                        error: cleanCompilerError(message),
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
