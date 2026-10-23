// The FAQ's example workflows pin the flags adapter to one release (RELEASING.md, "The flags adapter's version in
// the FAQ"). A bump that misses a line, or touches one language only, would leave readers copying two different
// versions; this keeps every mention in both files on the same one, and the SHA-pinned line commented with it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const read = (name) => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');

test('both FAQ files show one adapter version, and the SHA-pinned line carries it', () => {
    const versions = new Set();
    for (const name of ['FAQ.md', 'FAQ.pl.md']) {
        const text = read(name);
        const tags = [...text.matchAll(/adapters\/flags@(v\d+\.\d+\.\d+)/g)].map((m) => m[1]);
        const pinned = [...text.matchAll(/adapters\/flags@[0-9a-f]{40} # (v\d+\.\d+\.\d+)/g)].map((m) => m[1]);
        const named = [...text.matchAll(/\*\*(v\d+\.\d+\.\d+)\*\*|`@(v\d+\.\d+\.\d+)`|refs\/tags\/(v\d+\.\d+\.\d+)\^\{\}/g)].map((m) => m[1] || m[2] || m[3]);
        assert.ok(tags.length >= 2, `${name}: the example workflows pin the adapter to a tag`);
        assert.equal(pinned.length, 1, `${name}: one SHA-pinned example`);
        for (const v of [...tags, ...pinned, ...named]) versions.add(v);
    }
    assert.deepEqual([...versions], [[...versions][0]], `one version everywhere, found ${[...versions].join(', ')}`);
});
