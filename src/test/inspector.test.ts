import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test, describe } from 'node:test';
import {
    BOTOX_TEMPLATES,
    BotoxLayoutCodeActionProvider,
    formatLayoutStatusText,
    runBotoxInspect,
    runBotoxProbeAtPoint,
    runBotoxTemplate,
    InspectReport
} from '../inspector';

describe('Inspector & Layout Tools unit tests', () => {
    test('BOTOX_TEMPLATES exposes all 9 curated presets', () => {
        const names = BOTOX_TEMPLATES.map((t) => t.name);
        assert.deepStrictEqual(names, [
            'cheatsheet',
            'paper',
            'report',
            'notes',
            'cv',
            'essay',
            'memo',
            'landscape',
            'slides'
        ]);
    });

    test('formatLayoutStatusText formats clean, warning, and spillover reports', () => {
        const clean: InspectReport = {
            file: 'doc.md',
            page_count: 2,
            last_page_fill_pct: 94.2,
            pages: [],
            issue_counts: { error: 0, warn: 0, hint: 0, total: 0 },
            issues: []
        };
        const cleanFmt = formatLayoutStatusText(clean);
        assert.strictEqual(cleanFmt.text, '$(book) Botox: 2p (94%) · ✓');
        assert.strictEqual(cleanFmt.isWarning, false);

        const spill: InspectReport = {
            file: 'doc.md',
            page_count: 3,
            last_page_fill_pct: 11.4,
            pages: [],
            issue_counts: { error: 0, warn: 2, hint: 1, total: 3 },
            issues: [
                {
                    code: 'PAGE_SPILLOVER',
                    severity: 'warn',
                    page: 3,
                    col: 1,
                    bbox_pt: [0, 0, 100, 20],
                    text_excerpt: 'tail',
                    suggestion: 'Trim 15pt'
                }
            ]
        };
        const spillFmt = formatLayoutStatusText(spill);
        assert.strictEqual(spillFmt.text, '$(warning) Botox: 3p (11% spill) · 2w');
        assert.strictEqual(spillFmt.isWarning, true);
    });

    test('BotoxLayoutCodeActionProvider offers Quick Fixes for ORPHAN_HEADING and SPLIT_CODE_BLOCK', () => {
        const provider = new BotoxLayoutCodeActionProvider();
        const lines = ['# Title', '', '## Orphan Heading', '```rust', 'fn main() {}', '```'];
        const fakeDoc: any = {
            uri: { toString: () => 'file:///tmp/test.md' },
            lineCount: lines.length,
            lineAt: (idx: number) => ({ text: lines[idx] })
        };

        const orphanActions = provider.provideCodeActions(fakeDoc, {} as any, {
            diagnostics: [
                {
                    source: 'Botox Layout',
                    code: 'ORPHAN_HEADING',
                    range: { start: { line: 2, character: 0 }, end: { line: 2, character: 10 } }
                }
            ]
        } as any);
        assert.strictEqual(orphanActions.length, 2);
        assert.ok(orphanActions.some((a) => a.title.includes('\\columnbreak')));
        assert.ok(orphanActions.some((a) => a.title.includes('\\newpage')));

        const splitCodeActions = provider.provideCodeActions(fakeDoc, {} as any, {
            diagnostics: [
                {
                    source: 'Botox Layout',
                    code: 'SPLIT_CODE_BLOCK',
                    range: { start: { line: 3, character: 0 }, end: { line: 3, character: 7 } }
                }
            ]
        } as any);
        assert.strictEqual(splitCodeActions.length, 3);
        assert.ok(splitCodeActions.some((a) => a.title.includes('size=7pt')));
    });

    test('CLI integration: runBotoxInspect, runBotoxProbeAtPoint, and runBotoxTemplate work with local botox CLI', async () => {
        const header = await runBotoxTemplate('cheatsheet', false);
        assert.ok(header.includes('code-fontsize:'), 'cheatsheet template should include code-fontsize');

        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'botox-vsc-test-'));
        const mdPath = path.join(tmpDir, 'sample.md');
        const mdContent = [
            '---',
            'title: Test Doc',
            'theme: compact',
            '---',
            '',
            '# Section One',
            '',
            'Hello world from Botox inspector integration test.'
        ].join('\n');
        fs.writeFileSync(mdPath, mdContent, 'utf8');

        try {
            const report = await runBotoxInspect(mdPath);
            assert.ok(report, 'runBotoxInspect should return a report');
            assert.strictEqual(report!.page_count, 1);
            assert.ok(report!.pages.length === 1);
            assert.ok(report!.last_page_fill_pct > 0);

            // Probe near the bottom of the content bbox of page 1 (bbox_pt is [x, y, w, h])
            const [bx, by, bw, bh] = report!.pages[0].content_bbox_pt;
            const probeLine = await runBotoxProbeAtPoint(mdPath, 1, bx + Math.min(20, bw / 2), by + bh - 4);
            assert.strictEqual(probeLine, 8, `Expected paragraph at md line 8, got ${probeLine}`);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});
