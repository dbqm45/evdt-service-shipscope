const { test } = require('node:test');
const assert = require('node:assert/strict');
const { MAX_DIFF_PATHS, compileIgnorePattern, parseIgnorePaths, diffTrees } = require('../scripts/lib/tree-diff');

const tree = (entries, extra = {}) => ({ tree: entries.map(([path, sha, type = 'blob']) => ({ path, sha, type })), ...extra });

test('compileIgnorePattern: directory prefix, anchored path, basename at any depth, wildcard, empty', () => {
    const m = p => compileIgnorePattern(p);

    assert.equal(m('.github/')('.github/workflows/x.yml'), true);
    assert.equal(m('.github/')('src/.github/x'), false);
    assert.equal(m('/docs/')('docs/a.md'), true);
    assert.equal(m('a/b.txt')('a/b.txt'), true);
    assert.equal(m('a/b.txt')('x/a/b.txt'), false);
    assert.equal(m('README.md')('README.md'), true);
    assert.equal(m('README.md')('pkg/sub/README.md'), true);
    assert.equal(m('README.md')('README.md.bak'), false);
    assert.equal(m('*.md')('docs/x.md'), true);
    assert.equal(m('src/*.js')('src/a.js'), true);
    assert.equal(m('src/*.js')('src/deep/a.js'), false);
    assert.equal(m('a.b')('axb'), false);
    assert.equal(m('  ')('anything'), false);
});

test('parseIgnorePaths: empty inputs, JSON string, array, trimming and validation', () => {
    assert.deepEqual(parseIgnorePaths(undefined), []);
    assert.deepEqual(parseIgnorePaths(null), []);
    assert.deepEqual(parseIgnorePaths(''), []);
    assert.deepEqual(parseIgnorePaths('[" a ", "", "b/"]'), ['a', 'b/']);
    assert.deepEqual(parseIgnorePaths(['x']), ['x']);
    assert.throws(() => parseIgnorePaths('{"a":1}'), /array of strings/);
    assert.throws(() => parseIgnorePaths([1]), /array of strings/);
    assert.throws(() => parseIgnorePaths('not json'));
});

test('diffTrees: identical trees, modified, added, removed; sub-tree entries are ignored', () => {
    const a = tree([['src', 't1', 'tree'], ['src/a.js', '1'], ['b.js', '2'], ['gone.js', '3']]);
    const b = tree([['src', 't2', 'tree'], ['src/a.js', '9'], ['b.js', '2'], ['new.js', '4']]);

    assert.deepEqual(diffTrees(a, a), { files: 0, paths: [], ignored: 0 });
    assert.deepEqual(diffTrees(a, b), { files: 3, paths: ['gone.js', 'new.js', 'src/a.js'], ignored: 0 });
    assert.deepEqual(diffTrees({}, {}), { files: 0, paths: [], ignored: 0 });
});

test('diffTrees: ignore patterns move paths from files to ignored; a rename counts as two files', () => {
    const a = tree([['.github/ci.yml', '1'], ['README.md', '2'], ['old.js', '3']]);
    const b = tree([['.github/ci.yml', '9'], ['README.md', '8'], ['new.js', '3']]);

    assert.deepEqual(diffTrees(a, b, ['.github/', 'README.md']), { files: 2, paths: ['new.js', 'old.js'], ignored: 2 });
    assert.equal(diffTrees(a, a, ['.github/']).files, 0);
});

test('diffTrees: caps the listed paths but keeps the full count', () => {
    const many = Array.from({ length: MAX_DIFF_PATHS + 5 }, (_, i) => [`f${String(i).padStart(3, '0')}`, 'x']);
    const out = diffTrees(tree([]), tree(many));

    assert.equal(out.files, MAX_DIFF_PATHS + 5);
    assert.equal(out.paths.length, MAX_DIFF_PATHS);
});

test('diffTrees: a missing or truncated listing is unknown (null), never "no difference"', () => {
    const ok = tree([['a', '1']]);

    assert.equal(diffTrees(null, ok), null);
    assert.equal(diffTrees(ok, undefined), null);
    assert.equal(diffTrees(tree([['a', '1']], { truncated: true }), ok), null);
    assert.equal(diffTrees(ok, tree([['a', '1']], { truncated: true })), null);
});
