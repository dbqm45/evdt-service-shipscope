const { test } = require('node:test');
const assert = require('node:assert/strict');
const { diffTrees } = require('../lib/tree-diff');

const tree = (entries) => ({ tree: entries.map(([path, sha, type = 'blob']) => ({ path, sha, type })) });

test('diffTrees: identical trees, modified, renamed (two paths), added', () => {
    assert.deepEqual(diffTrees(tree([['a.js', '1'], ['b.js', '2']]), tree([['a.js', '1'], ['b.js', '2']])), { files: 0, paths: [], ignored: 0 });
    assert.deepEqual(diffTrees(tree([['a.js', '1']]), tree([['a.js', '2']])), { files: 1, paths: ['a.js'], ignored: 0 });
    assert.deepEqual(diffTrees(tree([['old.js', '1']]), tree([['new.js', '1']])), { files: 2, paths: ['new.js', 'old.js'], ignored: 0 });
    assert.deepEqual(diffTrees(tree([['a.js', '1']]), tree([['a.js', '1'], ['b.js', '2']])), { files: 1, paths: ['b.js'], ignored: 0 });
});

test('diffTrees: ignore patterns — bare name at any depth, dir/ anchored at the root, * within one segment', () => {
    assert.deepEqual(
        diffTrees(tree([['README.md', '1'], ['docs/README.md', '1'], ['src/a.js', '1']]), tree([['README.md', '2'], ['docs/README.md', '2'], ['src/a.js', '1']]), ['README.md']),
        { files: 0, paths: [], ignored: 2 },
    );
    assert.deepEqual(
        diffTrees(tree([['.github/x.yml', '1'], ['a/.github/y', '1']]), tree([['.github/x.yml', '2'], ['a/.github/y', '2']]), ['.github/']),
        { files: 1, paths: ['a/.github/y'], ignored: 1 },
    );
    assert.deepEqual(
        diffTrees(tree([['src/x.test.js', '1'], ['src/a/b.js', '1']]), tree([['src/x.test.js', '2'], ['src/a/b.js', '2']]), ['src/*.test.js']),
        { files: 1, paths: ['src/a/b.js'], ignored: 1 },
    );
});

test('diffTrees: tree entries are skipped; at most 20 paths kept, full count still reported', () => {
    assert.deepEqual(
        diffTrees(tree([['src', 't1', 'tree'], ['src/a.js', '1']]), tree([['src', 't2', 'tree'], ['src/a.js', '9']])),
        { files: 1, paths: ['src/a.js'], ignored: 0 },
    );
    const many = (sha) => tree(Array.from({ length: 25 }, (_, i) => [`f${String(i).padStart(2, '0')}.js`, sha]));
    const result = diffTrees(many('1'), many('2'));
    assert.equal(result.files, 25);
    assert.equal(result.paths.length, 20);
});

test('diffTrees: a missing or truncated listing is unknown (null), never "no difference"', () => {
    assert.equal(diffTrees(null, tree([])), null);
    assert.equal(diffTrees({ truncated: true, tree: [] }, tree([])), null);
});
