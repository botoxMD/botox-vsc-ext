import * as assert from 'assert';
import { test, describe } from 'node:test';
import { detectPlatformInfo, compareSemver, DEFAULT_BOTOX_VERSION } from '../backend';

describe('BackendManager unit tests', () => {
    test('detectPlatformInfo returns valid target for current host', () => {
        const info = detectPlatformInfo();
        assert.ok(['linux', 'darwin', 'win32'].includes(info.os));
        assert.ok(['x86_64', 'aarch64'].includes(info.arch));
        assert.ok(info.target.length > 0);
        assert.ok(['tar.gz', 'zip'].includes(info.archiveExt));
        assert.ok(['botox', 'botox.exe'].includes(info.binName));

        if (info.os === 'linux') {
            assert.ok(info.target.includes('linux'));
            assert.strictEqual(info.archiveExt, 'tar.gz');
            assert.strictEqual(info.binName, 'botox');
        } else if (info.os === 'darwin') {
            assert.ok(info.target.includes('apple-darwin'));
            assert.strictEqual(info.archiveExt, 'tar.gz');
            assert.strictEqual(info.binName, 'botox');
        } else if (info.os === 'win32') {
            assert.ok(info.target.includes('windows'));
            assert.strictEqual(info.archiveExt, 'zip');
            assert.strictEqual(info.binName, 'botox.exe');
        }
    });

    test('compareSemver accurately sorts versions', () => {
        assert.strictEqual(compareSemver('0.3.0', '0.2.0') > 0, true);
        assert.strictEqual(compareSemver('0.2.0', '0.3.0') < 0, true);
        assert.strictEqual(compareSemver('0.3.0', '0.3.0'), 0);
        assert.strictEqual(compareSemver('v0.3.0', '0.3.0'), 0);
        assert.strictEqual(compareSemver('0.14.9', '0.14.8') > 0, true);
        assert.strictEqual(compareSemver('0.15.0', '0.14.9') > 0, true);
        assert.strictEqual(compareSemver('0.2.0', '0.14.0') < 0, true);
    });

    test('DEFAULT_BOTOX_VERSION is valid semver', () => {
        assert.match(DEFAULT_BOTOX_VERSION, /^[0-9]+\.[0-9]+\.[0-9]+$/);
    });

    test('semver comparison handles patch and minor bumps properly', () => {
        assert.ok(compareSemver('0.3.1', '0.3.0') > 0);
        assert.ok(compareSemver('0.4.0', '0.3.9') > 0);
        assert.ok(compareSemver('1.0.0', '0.9.9') > 0);
        assert.ok(compareSemver('0.3.0', '0.3.1') < 0);
    });
});
