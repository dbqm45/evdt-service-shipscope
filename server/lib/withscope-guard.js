const fs = require('fs');
const path = require('path');

/** Index of the `)` matching the `(` at `openIndex`, by simple depth counting (no string/comment awareness --
 *  good enough here since real SQL and real JS both keep their own parens balanced). -1 if never closed. */
function matchingClose(text, openIndex) {
    let depth = 0;
    for (let i = openIndex; i < text.length; i++) {
        if (text[i] === '(') depth += 1;
        else if (text[i] === ')') {
            depth -= 1;
            if (depth === 0) return i;
        }
    }
    return -1;
}

/** Every `pool.query(...)` call in `text` -- never `client.query(...)`, which is assumed already scoped by
 *  whoever obtained that `client` (withScope's own callback, or a caller passing one down) -- with its full
 *  argument text and the line it starts on. */
function poolQueryCalls(text) {
    const calls = [];
    const re = /\bpool\.query\s*\(/g;
    let m;
    while ((m = re.exec(text))) {
        const openIndex = m.index + m[0].length - 1;
        const closeIndex = matchingClose(text, openIndex);
        if (closeIndex === -1) continue;
        calls.push({ start: m.index, line: text.slice(0, m.index).split('\n').length, args: text.slice(openIndex + 1, closeIndex) });
    }
    return calls;
}

/**
 * Finds `pool.query(...)` calls in `server/lib/*.js` that mention one of `tables` by name -- the mistake
 * withScope() exists to prevent: a query against an RLS table that runs outside the transaction withScope()
 * opens (and so outside the RLS scope it sets), because it was called straight on `pool` instead of on the
 * `client` a withScope() callback receives. This never flags `client.query(...)`, and it is not fooled by a
 * `pool.query(...)` call that merely sits textually inside a withScope(...) block -- querying `pool` there is
 * exactly as unscoped as anywhere else, since withScope's own transaction lives on its `client`, not on `pool`.
 *
 * @param {string} libDir absolute path to a directory of `.js` files (server/lib in real use)
 * @param {string[]} tables RLS table names to look for (server/lib/scope.js's RLS_TABLES in real use)
 * @returns {Array<{ file: string, line: number, table: string }>}
 */
function findMissingScopeQueries(libDir, tables) {
    const violations = [];
    for (const name of fs.readdirSync(libDir).filter((f) => f.endsWith('.js'))) {
        const text = fs.readFileSync(path.join(libDir, name), 'utf8');
        for (const call of poolQueryCalls(text)) {
            const table = tables.find((t) => new RegExp(`\\b${t}\\b`, 'i').test(call.args));
            if (table) violations.push({ file: name, line: call.line, table });
        }
    }
    return violations;
}

module.exports = { findMissingScopeQueries };
