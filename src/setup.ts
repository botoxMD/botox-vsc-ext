import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { hasBotoxBinary, promptInstallBotoxBinary, resolveBotoxBinary } from './compiler';

export function getGlobalConfigPath(): string {
    if (process.platform === 'win32' && process.env.APPDATA) {
        return path.join(process.env.APPDATA, 'botox', 'config.yaml');
    }
    return path.join(os.homedir(), '.config', 'botox', 'config.yaml');
}

interface ParsedExistingConfig {
    author?: string;
    affiliation?: string;
    docTheme?: string;
    slideTheme?: string;
    papersize?: string;
    toc?: boolean;
    bibliography?: boolean;
}

function parseExistingConfig(filePath: string): ParsedExistingConfig {
    const result: ParsedExistingConfig = {};
    if (!fs.existsSync(filePath)) {
        return result;
    }
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const authorMatch = content.match(/author:\s*["']?([^"'\n]+)["']?/);
        if (authorMatch) result.author = authorMatch[1].trim();

        const affMatch = content.match(/affiliation:\s*["']?([^"'\n]+)["']?/);
        if (affMatch) result.affiliation = affMatch[1].trim();

        const themeMatch = content.match(/theme:\s*["']?([^"'\n]+)["']?/);
        if (themeMatch) result.docTheme = themeMatch[1].trim();

        const paperMatch = content.match(/papersize:\s*["']?([^"'\n]+)["']?/);
        if (paperMatch) result.papersize = paperMatch[1].trim();

        const tocMatch = content.match(/toc:\s*(true|false)/);
        if (tocMatch) result.toc = tocMatch[1] === 'true';

        const bibMatch = content.match(/bibliography:\s*(true|false)/);
        if (bibMatch) result.bibliography = bibMatch[1] === 'true';
    } catch {
        // ignore parse error and use defaults
    }
    return result;
}

export function generateConfigYaml(options: {
    author: string;
    affiliation?: string;
    docTheme: string;
    slideTheme: string;
    papersize: string;
    toc: boolean;
    bibliography: boolean;
}): string {
    const affLine = options.affiliation && options.affiliation.trim().length > 0
        ? `  affiliation: "${options.affiliation.trim()}"\n`
        : '';

    return `# Botox Global Configuration
# Default style, author, and formatting for PDF documents and slides.

document:
  author: "${options.author}"
${affLine}  theme: "${options.docTheme}"                    # academic, modern, elegant, technical, compact, minimal
  fontsize: "11pt"
  mainfont: "New Computer Modern"       # True LaTeX font
  mathfont: "New Computer Modern Math"  # True LaTeX math font
  monofont: "DejaVu Sans Mono"          # Monospace font
  papersize: "${options.papersize}"              # a4 or us-letter
  columns: 1                            # 1 or 2 (multi-column)
  margin:
    x: "2.5cm"
    y: "2.5cm"
  section_numbering: true               # Numbered sections: 1, 1.1
  toc: ${options.toc}                           # Enable Table of Contents by default
  bibliography: ${options.bibliography}          # Transform web links into an automatic IEEE bibliography
  lang: "en"

slides:
  theme: "${options.slideTheme}"                # default, academic, nord, dark
  author: "${options.author}"
  paginate: true
  font: "New Computer Modern"
`;
}

export const SETUP_COMPLETED_KEY = 'botox.setupCompletedV1';

export async function runSetupWizard(context: vscode.ExtensionContext, isFirstRun: boolean = false) {
    const globalPath = getGlobalConfigPath();
    const existing = parseExistingConfig(globalPath);

    const defaultAuthor = existing.author || process.env.USER || process.env.USERNAME || 'Minus';
    const defaultAffiliation = existing.affiliation || '';
    const defaultDocTheme = existing.docTheme || 'academic';
    const defaultSlideTheme = existing.slideTheme || 'default';
    const defaultPapersize = existing.papersize || 'a4';
    const defaultToc = existing.toc ?? false;
    const defaultBib = existing.bibliography ?? true;

    const wizardTitlePrefix = isFirstRun ? 'Welcome to Botox! Setup Wizard' : 'Botox Setup';

    // Step 1: Author name
    const author = await vscode.window.showInputBox({
        title: `${wizardTitlePrefix} (1/6): Default Author Name`,
        prompt: 'Enter your name to be pre-filled in new documents and presentations',
        value: defaultAuthor,
        ignoreFocusOut: true,
        validateInput: (val) => val.trim().length === 0 ? 'Author name cannot be empty' : null
    });
    if (author === undefined) {
        if (isFirstRun) {
            vscode.window.showInformationMessage(
                'Botox setup was postponed. You can configure defaults anytime from the Command Palette ("Botox: Configure Defaults").',
                'Open Setup Wizard'
            ).then(c => {
                if (c === 'Open Setup Wizard') {
                    runSetupWizard(context, false);
                }
            });
        }
        return;
    }

    // Step 2: Affiliation / Organization
    const affiliation = await vscode.window.showInputBox({
        title: `${wizardTitlePrefix} (2/6): Affiliation / Organization (Optional)`,
        prompt: 'Enter your university, institute, or organization (or leave blank)',
        value: defaultAffiliation,
        ignoreFocusOut: true
    });
    if (affiliation === undefined) return;

    // Step 3: Document Theme
    const docThemes: vscode.QuickPickItem[] = [
        { label: 'academic', description: 'Standard LaTeX academic style (New Computer Modern, serif)', picked: defaultDocTheme === 'academic' },
        { label: 'modern', description: 'Contemporary sans-serif aesthetic with vibrant blue accents', picked: defaultDocTheme === 'modern' },
        { label: 'elegant', description: 'Refined serif typography with generous, book-grade margins', picked: defaultDocTheme === 'elegant' },
        { label: 'technical', description: 'Dense, structured layout optimized for manuals and specs', picked: defaultDocTheme === 'technical' },
        { label: 'compact', description: 'Multi-column condensed layout for maximum information density', picked: defaultDocTheme === 'compact' },
        { label: 'minimal', description: 'Unadorned, pure typographic layout', picked: defaultDocTheme === 'minimal' }
    ];
    const chosenDocTheme = await vscode.window.showQuickPick(docThemes, {
        title: `${wizardTitlePrefix} (3/6): Default Document Theme`,
        placeHolder: 'Select your preferred default document theme',
        ignoreFocusOut: true
    });
    if (!chosenDocTheme) return;

    // Step 4: Slide Theme
    const slideThemes: vscode.QuickPickItem[] = [
        { label: 'default', description: 'Clean, professional 16:9 presentation layout', picked: defaultSlideTheme === 'default' },
        { label: 'academic', description: 'Formal presentation theme matching LaTeX documents', picked: defaultSlideTheme === 'academic' },
        { label: 'dark', description: 'High-contrast dark mode slides for conferences and screens', picked: defaultSlideTheme === 'dark' },
        { label: 'nord', description: 'Arctic, cool-toned nord palette with pastel accents', picked: defaultSlideTheme === 'nord' }
    ];
    const chosenSlideTheme = await vscode.window.showQuickPick(slideThemes, {
        title: `${wizardTitlePrefix} (4/6): Default Slide Theme`,
        placeHolder: 'Select your preferred presentation slide theme',
        ignoreFocusOut: true
    });
    if (!chosenSlideTheme) return;

    // Step 5: Paper Size
    const paperSizes: vscode.QuickPickItem[] = [
        { label: 'a4', description: 'Standard ISO A4 (210 x 297 mm) - Global Standard', picked: defaultPapersize === 'a4' },
        { label: 'us-letter', description: 'North American Letter (8.5 x 11 in)', picked: defaultPapersize === 'us-letter' }
    ];
    const chosenPaper = await vscode.window.showQuickPick(paperSizes, {
        title: `${wizardTitlePrefix} (5/6): Default Paper Size`,
        placeHolder: 'Select default paper size for PDF documents',
        ignoreFocusOut: true
    });
    if (!chosenPaper) return;

    // Step 6: Automatic Bibliography
    const bibOptions: vscode.QuickPickItem[] = [
        { label: 'Enabled', description: 'Automatically convert web links into an IEEE-standard Bibliography section', picked: defaultBib },
        { label: 'Disabled', description: 'Keep web links inline without creating a bibliography', picked: !defaultBib }
    ];
    const chosenBib = await vscode.window.showQuickPick(bibOptions, {
        title: `${wizardTitlePrefix} (6/6): Automatic Bibliography`,
        placeHolder: 'Enable automatic IEEE-standard bibliography transformation?',
        ignoreFocusOut: true
    });
    if (!chosenBib) return;

    // Target Selection: Global vs Workspace
    let targetPath = globalPath;
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders && workspaceFolders.length > 0) {
        const scopeOptions: vscode.QuickPickItem[] = [
            {
                label: 'Global Configuration',
                description: globalPath,
                detail: 'Applies to all documents and workspaces across your entire machine'
            },
            {
                label: 'Workspace Configuration',
                description: path.join(workspaceFolders[0].uri.fsPath, 'botox.yaml'),
                detail: 'Applies only to this workspace folder'
            }
        ];
        const chosenScope = await vscode.window.showQuickPick(scopeOptions, {
            title: 'Save Configuration Scope',
            placeHolder: 'Where should this configuration be saved?',
            ignoreFocusOut: true
        });
        if (!chosenScope) return;
        if (chosenScope.label.startsWith('Workspace')) {
            targetPath = path.join(workspaceFolders[0].uri.fsPath, 'botox.yaml');
        }
    }

    const yamlContent = generateConfigYaml({
        author: author.trim(),
        affiliation: affiliation.trim(),
        docTheme: chosenDocTheme.label,
        slideTheme: chosenSlideTheme.label,
        papersize: chosenPaper.label,
        toc: defaultToc,
        bibliography: chosenBib.label === 'Enabled'
    });

    try {
        const parentDir = path.dirname(targetPath);
        if (!fs.existsSync(parentDir)) {
            fs.mkdirSync(parentDir, { recursive: true });
        }
        fs.writeFileSync(targetPath, yamlContent, 'utf-8');

        // Mark that setup has been completed
        await context.globalState.update(SETUP_COMPLETED_KEY, true);

        const openItem = 'Open Config File';
        const action = await vscode.window.showInformationMessage(
            `Botox: Defaults successfully saved to '${path.basename(targetPath)}'!`,
            openItem
        );
        if (action === openItem) {
            const doc = await vscode.workspace.openTextDocument(targetPath);
            await vscode.window.showTextDocument(doc);
        }
    } catch (e: any) {
        vscode.window.showErrorMessage(`Failed to save Botox configuration: ${e.message}`);
    }
}

export function runSetupInTerminal() {
    if (!hasBotoxBinary()) {
        promptInstallBotoxBinary();
        return;
    }
    const binary = resolveBotoxBinary();
    const terminal = vscode.window.createTerminal({
        name: 'Botox Setup',
    });
    terminal.show();
    terminal.sendText(`${binary} setup`);
}

export async function resetSetupState(context: vscode.ExtensionContext) {
    await context.globalState.update(SETUP_COMPLETED_KEY, false);
}

export async function checkFirstRunSetup(context: vscode.ExtensionContext) {
    const isCompleted = context.globalState.get<boolean>(SETUP_COMPLETED_KEY, false);

    if (!isCompleted) {
        // Automatically launch the setup wizard so the user configures their defaults
        setTimeout(() => {
            runSetupWizard(context, true);
        }, 800);
    }
}
