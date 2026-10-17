// Guards the connascence of execution between docs/index.html's <script> order and what each docs/app-*.js
// file's own top-level (load-time) code may use (design-docs/REPORT_ARCH.md, II.4 item 5): a real bug once
// shipped here (app-main.js's top-level `const FALLBACK = buildFallbackData()` calling a helper from
// app-model.js before it was loaded, only visible on file://, not caught by any test). This file loads every
// docs/app-*.js in the exact order docs/index.html lists them and asserts nothing throws while loading.
//
// Scope: load-time (synchronous) correctness only, same as test/frontend-render.test.js's loadApp(), which
// this reuses almost verbatim but also includes app-main.js (frontend-render.test.js deliberately excludes
// it, since its own job is testing render functions with controlled state, not init()). app-main.js's
// trailing `init()` call is itself async and does real network/DOM work past its first `await`; that part is
// swallowed here (process-wide for this one test file, which already runs in its own process per CLAUDE.md)
// rather than asserted on, since it is already covered by the dedicated DB-free app-*.test.js suite and by
// frontend-render.test.js's own direct calls to the render functions.
process.on('unhandledRejection', () => {});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const FILES_IN_INDEX_HTML_ORDER = fs.readFileSync(path.join(__dirname, '..', 'docs', 'index.html'), 'utf8')
    .match(/<script src="(app-[^"]+\.js)">/g)
    .map((tag) => tag.match(/"([^"]+)"/)[1]);

function stubElement() {
    return new Proxy({ classList: { add() {}, remove() {}, toggle() {} }, style: {}, dataset: {}, addEventListener() {},
        getAttribute() { return null; }, setAttribute() {}, appendChild() {}, getBoundingClientRect: () => ({ height: 70 }),
        querySelector: () => stubElement(), querySelectorAll: () => [] },
    { get: (t, k) => (k in t ? t[k] : undefined), set: (t, k, v) => { t[k] = v; return true; } });
}

test('every docs/app-*.js file loads, in docs/index.html\'s own order, without throwing', () => {
    const boxes = {};
    const ctx = {
        console, URLSearchParams, Date, Math, Map, Set, fetch: () => Promise.reject(new Error('no network in test')),
        location: { search: '?insights=1' }, localStorage: { getItem: () => null, setItem() {} }, matchMedia: () => ({ matches: false, addEventListener() {} }),
        document: { documentElement: stubElement(), body: stubElement(), getElementById: (id) => boxes[id] || (boxes[id] = stubElement()),
            querySelector: () => stubElement(), querySelectorAll: () => [], addEventListener() {},
            createElement: () => stubElement() },
    };

    vm.createContext(ctx);
    assert.doesNotThrow(() => {
        for (const file of FILES_IN_INDEX_HTML_ORDER) {
            vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'docs', file), 'utf8'), ctx, { filename: file });
        }
    }, undefined, `docs/index.html's own <script> order is: ${FILES_IN_INDEX_HTML_ORDER.join(', ')}`);
});
