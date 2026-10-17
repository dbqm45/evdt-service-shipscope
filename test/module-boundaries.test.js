const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { findBoundaryViolations } = require('../scripts/lib/module-boundaries');

const DIR = path.join('test', '.tmp-module-boundaries');

test.beforeEach(() => fs.rmSync(DIR, { recursive: true, force: true }));
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));

function write(relPath, content) {
    const full = path.join(DIR, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
}

test('findBoundaryViolations: clean repo-shaped fixture reports nothing', () => {
    write('scripts/sync.js', "const { fail } = require('./lib/cli');\nfail('x');\n");
    write('scripts/lib/cli.js', 'module.exports = {};\n');
    write('server/web.js', "const { withScope } = require('./lib/scope');\n");
    write('server/lib/scope.js', 'module.exports = {};\n');
    write('server/node_modules/fastify/index.js', "require('../../../scripts/lib/cli');\n"); // vendored code is never scanned
    write('docs/app-core.js', 'function escapeHtml(s) { return s; }\n');

    assert.deepEqual(findBoundaryViolations(path.resolve(DIR)), []);
});

test('findBoundaryViolations: scripts/ reaching into server/ is a violation', () => {
    write('scripts/bad.js', "const { db } = require('../server/lib/db');\n");
    write('server/lib/db.js', 'module.exports = {};\n');
    write('docs/app-core.js', '// nothing here\n');

    const violations = findBoundaryViolations(path.resolve(DIR));

    assert.equal(violations.length, 1);
    assert.equal(violations[0].file, path.join('scripts', 'bad.js'));
    assert.equal(violations[0].line, 1);
});

test('findBoundaryViolations: server/ reaching into root scripts/ is a violation, but server/scripts/ is not scripts/', () => {
    write('server/lib/bad.js', "const { fail } = require('../../scripts/lib/cli');\n");
    write('scripts/lib/cli.js', 'module.exports = {};\n');
    // server/scripts/ is server's own subdirectory, not the root scripts/ tree — must not false-positive.
    write('server/scripts/migrate.js', "const { createPool } = require('../lib/db');\n");
    write('server/lib/db.js', 'module.exports = {};\n');
    write('docs/app-core.js', '// nothing here\n');

    const violations = findBoundaryViolations(path.resolve(DIR));

    assert.equal(violations.length, 1);
    assert.equal(violations[0].file, path.join('server', 'lib', 'bad.js'));
});

test('findBoundaryViolations: require() in docs/app-*.js is always a violation, regardless of target', () => {
    write('scripts/lib/cli.js', 'module.exports = {};\n');
    write('server/lib/db.js', 'module.exports = {};\n');
    write('docs/app-main.js', "const path = require('path');\n");
    write('docs/not-an-app-file.js', "const path = require('path');\n"); // only app-*.js is in scope

    const violations = findBoundaryViolations(path.resolve(DIR));

    assert.equal(violations.length, 1);
    assert.equal(violations[0].file, path.join('docs', 'app-main.js'));
});

test('findBoundaryViolations: npm packages and Node builtins are never flagged', () => {
    write('scripts/ok.js', "const fs = require('fs');\nconst { createPool } = require('pg');\n");
    write('server/lib/ok.js', "const Fastify = require('fastify');\n");
    write('docs/app-core.js', '// nothing here\n');

    assert.deepEqual(findBoundaryViolations(path.resolve(DIR)), []);
});

test('findBoundaryViolations: the real repo has zero violations today', () => {
    assert.deepEqual(findBoundaryViolations(path.resolve(__dirname, '..')), []);
});
