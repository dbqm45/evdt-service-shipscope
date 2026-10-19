// Every action a workflow uses is pinned to a full commit SHA with its version in a comment
// (design-docs/SECURITY.md): a tag can be moved to other code, a SHA cannot. Dependabot bumps SHA and comment.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', '.github', 'workflows');

test('workflow actions are pinned to a commit SHA with the version in a comment', () => {
    const files = fs.readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f));
    assert.ok(files.length > 0);
    let uses = 0;
    for (const file of files) {
        for (const [i, line] of fs.readFileSync(path.join(DIR, file), 'utf8').split('\n').entries()) {
            const m = /^\s*-?\s*uses:\s*(\S+)(.*)$/.exec(line);
            if (!m) continue;
            uses++;
            if (m[1].startsWith('./')) continue; // an action in this repository: pinned by the commit itself
            assert.match(m[1], /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/, `${file}:${i + 1}: ${m[1]} is not pinned to a full commit SHA`);
            assert.match(m[2], /^\s+#\s+v\d+(\.\d+)*\s*$/, `${file}:${i + 1}: no "# vX.Y.Z" comment for Dependabot and readers`);
        }
    }
    assert.ok(uses > 0);
});

test('Dependabot updates the workflow actions', () => {
    const config = fs.readFileSync(path.join(__dirname, '..', '.github', 'dependabot.yml'), 'utf8');
    assert.match(config, /package-ecosystem: github-actions/);
});
