import * as vscode from 'vscode';
import * as child_process from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as https from 'https';
import * as http from 'http';

/**
 * Pinned target version of the Botox compiler backend.
 * Synchronized with the accompanying CLI release.
 */
export const DEFAULT_BOTOX_VERSION = '0.3.3';

export const BOTOX_CLI_REPO = 'botoxMD/botox-cli';
export const BOTOX_CLI_REPO_URL = `https://github.com/${BOTOX_CLI_REPO}`;

export interface PlatformTargetInfo {
    os: 'linux' | 'darwin' | 'win32';
    arch: 'x86_64' | 'aarch64';
    libc?: 'gnu' | 'musl';
    target: string;
    archiveExt: 'tar.gz' | 'zip';
    binName: 'botox' | 'botox.exe';
}

/**
 * Detects the host operating system, architecture, and C runtime
 * to determine the matching pre-built release target.
 */
export function detectPlatformInfo(): PlatformTargetInfo {
    const platform = process.platform;
    const arch = process.arch;

    if (platform === 'win32') {
        if (arch !== 'x64') {
            throw new Error(`Unsupported Windows architecture: ${arch}. Botox pre-built binaries are available for x86_64.`);
        }
        return {
            os: 'win32',
            arch: 'x86_64',
            target: 'x86_64-pc-windows-msvc',
            archiveExt: 'zip',
            binName: 'botox.exe'
        };
    }

    if (platform === 'darwin') {
        const darwinArch = arch === 'arm64' ? 'aarch64' : 'x86_64';
        return {
            os: 'darwin',
            arch: darwinArch,
            target: `${darwinArch}-apple-darwin`,
            archiveExt: 'tar.gz',
            binName: 'botox'
        };
    }

    if (platform === 'linux') {
        const linuxArch = arch === 'arm64' ? 'aarch64' : 'x86_64';
        let libc: 'gnu' | 'musl' = 'gnu';

        // Check for musl libc signatures
        try {
            if (fs.existsSync('/lib/ld-musl-x86_64.so.1') || fs.existsSync('/lib/ld-musl-aarch64.so.1')) {
                libc = 'musl';
            } else {
                const lddRes = child_process.spawnSync('ldd', ['--version'], { encoding: 'utf-8' });
                const out = (lddRes.stdout || '') + (lddRes.stderr || '');
                if (/musl/i.test(out)) {
                    libc = 'musl';
                }
            }
        } catch {
            libc = 'gnu';
        }

        const target = (libc === 'musl' && linuxArch === 'x86_64')
            ? 'x86_64-unknown-linux-musl'
            : `${linuxArch}-unknown-linux-gnu`;

        return {
            os: 'linux',
            arch: linuxArch,
            libc,
            target,
            archiveExt: 'tar.gz',
            binName: 'botox'
        };
    }

    throw new Error(`Unsupported operating system: ${platform}. Botox provides pre-built binaries for Linux, macOS, and Windows.`);
}

/**
 * Returns the extension-managed binary storage directory path.
 */
export function getManagedBinaryDir(context: vscode.ExtensionContext): string {
    return path.join(context.globalStorageUri.fsPath, 'bin');
}

/**
 * Returns the expected extension-managed binary path.
 */
export function getManagedBinaryPath(context: vscode.ExtensionContext): string {
    const info = detectPlatformInfo();
    return path.join(getManagedBinaryDir(context), info.binName);
}

/**
 * Resolves the path to the Botox compiler executable.
 * Searches across:
 * 1. User setting `botox.executablePath`
 * 2. Extension-managed global storage (`<globalStorageUri>/bin/botox`)
 * 3. User local install (`~/.local/bin/botox`)
 * 4. Cargo binary path (`~/.cargo/bin/botox`)
 * 5. System PATH
 */
export function resolveBotoxBinary(context?: vscode.ExtensionContext): string {
    const isWin = process.platform === 'win32';
    const binName = isWin ? 'botox.exe' : 'botox';

    // 1. User-configured executable path in VS Code settings
    const config = vscode.workspace.getConfiguration('botox');
    const customPath = config.get<string>('executablePath');
    if (customPath && customPath !== 'botox' && fs.existsSync(customPath)) {
        return customPath;
    }

    // 2. Extension-managed binary in global storage (preferred over stale system installs if available)
    if (context) {
        try {
            const managedPath = getManagedBinaryPath(context);
            if (fs.existsSync(managedPath)) {
                return managedPath;
            }
        } catch {}
    }

    // 3. Standard user local binary path (~/.local/bin/botox)
    const homeLocalBin = path.join(os.homedir(), '.local', 'bin', binName);
    if (fs.existsSync(homeLocalBin)) {
        return homeLocalBin;
    }

    // 4. Cargo binary path (~/.cargo/bin/botox)
    const cargoBin = path.join(os.homedir(), '.cargo', 'bin', binName);
    if (fs.existsSync(cargoBin)) {
        return cargoBin;
    }

    // 5. System PATH default binary name
    return binName;
}

/**
 * Checks whether a functional Botox executable exists on the machine.
 */
export function hasBotoxBinary(context?: vscode.ExtensionContext): boolean {
    const bin = resolveBotoxBinary(context);
    if (path.isAbsolute(bin)) {
        return fs.existsSync(bin);
    }
    try {
        const checkCmd = process.platform === 'win32' ? 'where' : 'which';
        const res = child_process.spawnSync(checkCmd, [bin], { encoding: 'utf-8' });
        return res.status === 0 && (res.stdout || '').trim().length > 0;
    } catch {
        return false;
    }
}

/**
 * Reads the semver version from a binary executable by calling `--version`.
 */
export function getBinaryVersion(binaryPath: string): string | null {
    try {
        const res = child_process.spawnSync(binaryPath, ['--version'], { encoding: 'utf-8', timeout: 3000 });
        if (res.status !== 0) return null;
        const out = (res.stdout || res.stderr || '').trim();
        const match = out.match(/botox\s+v?([0-9]+\.[0-9]+\.[0-9]+)/i);
        return match ? match[1] : null;
    } catch {
        return null;
    }
}

/**
 * Compares two semver strings (returns > 0 if a > b, < 0 if a < b, 0 if equal).
 */
export function compareSemver(a: string, b: string): number {
    const pa = a.replace(/^v/i, '').split('.').map(x => parseInt(x, 10) || 0);
    const pb = b.replace(/^v/i, '').split('.').map(x => parseInt(x, 10) || 0);
    for (let i = 0; i < 3; i++) {
        const diff = (pa[i] || 0) - (pb[i] || 0);
        if (diff !== 0) return diff;
    }
    return 0;
}

/**
 * Streams an HTTP/HTTPS resource to disk, following redirects up to maxRedirects.
 */
function downloadFile(
    url: string,
    destPath: string,
    progressCallback?: (downloaded: number, total?: number) => void,
    maxRedirects = 5
): Promise<void> {
    return new Promise((resolve, reject) => {
        if (maxRedirects <= 0) {
            return reject(new Error('Too many HTTP redirects while downloading Botox binary.'));
        }

        const client = url.startsWith('http://') ? http : https;
        const req = client.get(
            url,
            {
                headers: {
                    'User-Agent': 'Botox-VSCode-Extension',
                    'Accept': 'application/octet-stream'
                }
            },
            (res) => {
                // Follow 3xx redirects
                if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    let nextUrl = res.headers.location;
                    if (!nextUrl.startsWith('http')) {
                        const parsed = new URL(url);
                        nextUrl = `${parsed.protocol}//${parsed.host}${nextUrl}`;
                    }
                    res.resume(); // Consume stream to avoid leaking sockets
                    return downloadFile(nextUrl, destPath, progressCallback, maxRedirects - 1)
                        .then(resolve)
                        .catch(reject);
                }

                if (res.statusCode !== 200) {
                    res.resume();
                    return reject(new Error(`Failed to download binary from GitHub (HTTP ${res.statusCode}: ${res.statusMessage})`));
                }

                const totalBytes = res.headers['content-length']
                    ? parseInt(res.headers['content-length'], 10)
                    : undefined;
                let downloadedBytes = 0;

                const fileStream = fs.createWriteStream(destPath);

                res.on('data', (chunk) => {
                    downloadedBytes += chunk.length;
                    if (progressCallback) {
                        progressCallback(downloadedBytes, totalBytes);
                    }
                });

                res.pipe(fileStream);

                fileStream.on('finish', () => {
                    fileStream.close((err) => {
                        if (err) reject(err);
                        else resolve();
                    });
                });

                fileStream.on('error', (err) => {
                    try { fs.unlinkSync(destPath); } catch {}
                    reject(err);
                });
            }
        );

        req.on('error', (err) => {
            try { fs.unlinkSync(destPath); } catch {}
            reject(err);
        });
    });
}

/**
 * Extracts a tar.gz or zip archive to target directory using native OS utilities.
 */
function extractArchive(archivePath: string, targetDir: string, archiveExt: 'tar.gz' | 'zip'): Promise<void> {
    return new Promise((resolve, reject) => {
        if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
        }

        if (archiveExt === 'tar.gz') {
            // tar -xzf <archivePath> -C <targetDir>
            child_process.execFile('tar', ['-xzf', archivePath, '-C', targetDir], (error, stdout, stderr) => {
                if (error) {
                    reject(new Error(`Extraction failed: ${stderr || stdout || error.message}`));
                } else {
                    resolve();
                }
            });
        } else {
            // Windows zip extraction: try tar.exe first (native in Windows 10+), fallback to PowerShell
            child_process.execFile('tar', ['-xf', archivePath, '-C', targetDir], (error) => {
                if (!error) {
                    return resolve();
                }
                const psCmd = `Expand-Archive -Path '${archivePath}' -DestinationPath '${targetDir}' -Force`;
                child_process.execFile('powershell', ['-NoProfile', '-Command', psCmd], (psError, stdout, stderr) => {
                    if (psError) {
                        reject(new Error(`Extraction failed: ${stderr || stdout || psError.message}`));
                    } else {
                        resolve();
                    }
                });
            });
        }
    });
}

/**
 * Downloads, verifies, and installs the pre-built Botox binary into the extension global storage.
 */
export async function downloadAndInstallBackend(
    context: vscode.ExtensionContext,
    targetVersion: string = DEFAULT_BOTOX_VERSION
): Promise<string> {
    const platformInfo = detectPlatformInfo();
    const tag = targetVersion.startsWith('v') ? targetVersion : `v${targetVersion}`;
    const archiveName = `botox-${tag}-${platformInfo.target}.${platformInfo.archiveExt}`;
    const downloadUrl = `https://github.com/${BOTOX_CLI_REPO}/releases/download/${tag}/${archiveName}`;

    const managedDir = getManagedBinaryDir(context);
    const managedBinPath = getManagedBinaryPath(context);

    const tmpArchive = path.join(os.tmpdir(), `botox-${Date.now()}.${platformInfo.archiveExt}`);

    return await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: `Botox: Installing compiler backend (${tag})`,
            cancellable: false
        },
        async (progress) => {
            progress.report({ message: 'Connecting to GitHub Releases...' });

            try {
                let lastPct = 0;
                await downloadFile(downloadUrl, tmpArchive, (downloaded, total) => {
                    if (total && total > 0) {
                        const pct = Math.floor((downloaded / total) * 100);
                        if (pct > lastPct) {
                            progress.report({
                                message: `Downloading... ${pct}% (${(downloaded / (1024 * 1024)).toFixed(1)} MB / ${(total / (1024 * 1024)).toFixed(1)} MB)`,
                                increment: pct - lastPct
                            });
                            lastPct = pct;
                        }
                    } else {
                        progress.report({ message: `Downloading... (${(downloaded / (1024 * 1024)).toFixed(1)} MB)` });
                    }
                });

                progress.report({ message: 'Extracting and verifying binary...' });

                await extractArchive(tmpArchive, managedDir, platformInfo.archiveExt);

                if (!fs.existsSync(managedBinPath)) {
                    throw new Error(`Extracted archive did not contain expected binary at '${managedBinPath}'`);
                }

                // Ensure executable permissions on Unix platforms
                if (platformInfo.os !== 'win32') {
                    try {
                        fs.chmodSync(managedBinPath, 0o755);
                    } catch {}
                }

                // Verify the binary executes cleanly
                const verifiedVersion = getBinaryVersion(managedBinPath);
                if (!verifiedVersion) {
                    throw new Error(`Installed binary at '${managedBinPath}' failed execution smoke-test.`);
                }

                vscode.window.showInformationMessage(
                    `Botox compiler backend v${verifiedVersion} is ready to use!`
                );

                return managedBinPath;
            } finally {
                try {
                    if (fs.existsSync(tmpArchive)) {
                        fs.unlinkSync(tmpArchive);
                    }
                } catch {}
            }
        }
    );
}

/**
 * Deep module interface for acquiring a valid Botox compiler binary.
 * If missing, automatically downloads and configures the pre-built backend.
 */
export async function ensureBotoxBinary(
    context?: vscode.ExtensionContext,
    options?: { forceDownload?: boolean }
): Promise<string> {
    if (!options?.forceDownload && hasBotoxBinary(context)) {
        return resolveBotoxBinary(context);
    }

    if (!context) {
        throw new Error('Extension context is required to automatically install the Botox backend.');
    }

    const config = vscode.workspace.getConfiguration('botox');
    const autoDownload = config.get<boolean>('autoDownloadBackend', true);

    if (autoDownload || options?.forceDownload) {
        return await downloadAndInstallBackend(context, DEFAULT_BOTOX_VERSION);
    }

    // Fallback prompt if user disabled auto-download
    const installAction = 'Download Backend';
    const settingsAction = 'Configure Path';
    const choice = await vscode.window.showErrorMessage(
        'Botox compiler binary not found. Would you like to automatically download it now?',
        installAction,
        settingsAction
    );

    if (choice === installAction) {
        return await downloadAndInstallBackend(context, DEFAULT_BOTOX_VERSION);
    } else if (choice === settingsAction) {
        vscode.commands.executeCommand('workbench.action.openSettings', 'botox.executablePath');
    }

    throw new Error('Botox compiler binary is not available.');
}

/**
 * Checks if the existing managed binary is older than DEFAULT_BOTOX_VERSION,
 * and seamlessly updates it if auto-download is enabled.
 */
export async function checkAndPromptBackendUpdate(context: vscode.ExtensionContext): Promise<void> {
    try {
        const managedBinPath = getManagedBinaryPath(context);
        if (!fs.existsSync(managedBinPath)) {
            // No managed binary yet; ensureBotoxBinary will handle on first preview or setup
            return;
        }

        const currentVersion = getBinaryVersion(managedBinPath);
        if (!currentVersion) return;

        if (compareSemver(DEFAULT_BOTOX_VERSION, currentVersion) > 0) {
            const config = vscode.workspace.getConfiguration('botox');
            const autoDownload = config.get<boolean>('autoDownloadBackend', true);

            if (autoDownload) {
                // Silently upgrade or notify
                downloadAndInstallBackend(context, DEFAULT_BOTOX_VERSION).catch(() => {});
            } else {
                const updateAction = 'Update Now';
                const choice = await vscode.window.showInformationMessage(
                    `A newer Botox compiler backend (v${DEFAULT_BOTOX_VERSION}) is available (current: v${currentVersion}).`,
                    updateAction
                );
                if (choice === updateAction) {
                    await downloadAndInstallBackend(context, DEFAULT_BOTOX_VERSION);
                }
            }
        }
    } catch {
        // Ignore background check errors
    }
}
