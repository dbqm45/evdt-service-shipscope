const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { safeRelativePath } = require('../scripts/lib/cli');
const { discoverAllFlags, extractFlagKeys } = require('../scripts/lib/extract-flags');
const { appendFlagHistoryEntries } = require('../scripts/lib/flag-history');

test('safeRelativePath normalizes a relative path', () => {
    assert.equal(safeRelativePath('docs/./data', 'X'), path.normalize('docs/data'));
});

test('safeRelativePath exits on absolute and parent-escaping paths', () => {
    const realExit = process.exit;
    const realError = console.error;
    let code = null;

    process.exit = c => { code = c; throw new Error('exit'); };
    console.error = () => {};

    try {
        assert.throws(() => safeRelativePath('../etc', 'X'), /exit/);
        assert.equal(code, 1);
        code = null;
        assert.throws(() => safeRelativePath(path.resolve('abs'), 'X'), /exit/);
        assert.equal(code, 1);
    } finally {
        process.exit = realExit;
        console.error = realError;
    }
});

test('flag discovery reads key: boolean pairs from *.generated.ts and skips node_modules', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flags-'));

    try {
        fs.mkdirSync(path.join(root, 'src'));
        fs.mkdirSync(path.join(root, 'node_modules'));
        fs.writeFileSync(path.join(root, 'src', 'a.generated.ts'), 'export const FLAGS = { alpha: true, beta: false };');
        fs.writeFileSync(path.join(root, 'node_modules', 'b.generated.ts'), 'export const F = { ignored: true };');

        assert.deepEqual(extractFlagKeys(path.join(root, 'src', 'a.generated.ts')), ['alpha', 'beta']);
        assert.deepEqual(discoverAllFlags(root).map(f => f.key), ['alpha', 'beta']);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('appendFlagHistoryEntries appends and is a no-op for an empty list', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-'));
    const file = path.join(dir, 'h.json');

    try {
        appendFlagHistoryEntries(file, []);
        assert.equal(fs.existsSync(file), false);
        appendFlagHistoryEntries(file, [{ key: 'a' }]);
        appendFlagHistoryEntries(file, [{ key: 'b' }]);
        assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).map(e => e.key), ['a', 'b']);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
