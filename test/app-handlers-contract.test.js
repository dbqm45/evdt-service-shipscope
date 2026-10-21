// Contract between the data-* attributes docs/app-components.js writes and the code that reads them. With no inline
// handlers (the pages' Content-Security-Policy), behaviour hangs on these names; renaming one side only would leave
// a link that opens its row, a dialog that never closes or a drift modal without its diff, and no other test would
// notice. Every attribute in the components' source must be listed here with its reader, the reader must still read
// it, and the two delegated handlers and the drift button are exercised for real.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const DOCS = path.join(__dirname, '..', 'docs');
const source = f => fs.readFileSync(path.join(DOCS, `${f}.js`), 'utf8');

/** attribute -> the file that reads it (null: a marker nothing reads, kept for tests/CSS only). */
const READERS = {
    'data-stop-click': 'app-main',
    'data-close-dialog': 'app-main',
    'data-env': 'app-technical-matrix',
    'data-behind': 'app-technical-matrix',
    'data-skipped': 'app-technical-matrix',
    'data-same-version': 'app-technical-matrix',
    'data-diff': 'app-technical-matrix',
    'data-key': 'app-product',
    'data-epic-key': 'app-product',
    'data-group-key': 'app-technical-timeline',
    'data-flag': 'app-technical-flags',
    'data-tile-key': null,
};
// The drift button's attributes reach openDriftModal() through `{ ...infoBtn.dataset }`, not one by one.
const DRIFT_ATTRS = ['data-env', 'data-behind', 'data-skipped', 'data-same-version', 'data-diff'];

const camel = attr => attr.slice('data-'.length).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
const attrsOf = markup => [...markup.matchAll(/\s(data-[a-z-]+)(?:="([^"]*)")?/g)].map(m => ({ name: m[1], value: m[2] ?? '' }));
const unescape = s => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

function load(){
    const stub = () => ({ setAttribute() {}, getAttribute() { return null; }, addEventListener() {}, classList: { toggle() {}, add() {} }, style: {} });
    const listeners = [];
    const ctx = { console, URLSearchParams, location: { search: '' }, localStorage: { setItem() {}, getItem: () => null },
        document: { documentElement: stub(), getElementById: () => stub(), addEventListener: (type, fn, capture) => listeners.push({ type, fn, capture: !!capture }) } };

    vm.createContext(ctx);
    ['app-html', 'app-core', 'app-components'].forEach(f => vm.runInContext(source(f), ctx));
    // app-main.js calls init() when loaded; only its delegated handlers are needed here.
    const handlers = /function initDelegatedHandlers\(\)\{[\s\S]*?\n\}\n/.exec(source('app-main'));
    assert.ok(handlers, 'initDelegatedHandlers() is in app-main.js');
    vm.runInContext(`${handlers[0]}; initDelegatedHandlers();`, ctx);

    return { run: code => String(vm.runInContext(code, ctx)), listeners };
}

/** A stub element carrying the attributes of `markup`'s first tag; closest() matches `[data-x]` on it or `parents`. */
function elementFrom(markup, parents = {}){
    const attrs = new Set(attrsOf(markup.slice(0, markup.indexOf('>') + 1)).map(a => a.name));
    const el = { closest: sel => {
        const m = /^\[(data-[a-z-]+)\]$/.exec(sel);
        return m && attrs.has(m[1]) ? el : (parents[sel] || null);
    } };
    return el;
}

test('every data-* attribute in app-components.js has a listed reader', () => {
    const written = [...new Set([...source('app-components').matchAll(/\b(data-[a-z][a-z-]*)\b/g)].map(m => m[1]))].sort();

    assert.deepEqual(written, Object.keys(READERS).sort(),
        'a data-* attribute was added to or removed from the components: list it in READERS with the file that reads it');
});

test('each listed reader still reads its attribute', () => {
    for (const [attr, file] of Object.entries(READERS)) {
        if (!file || DRIFT_ATTRS.includes(attr)) {
            continue;
        }
        const code = source(file);
        const reads = code.includes(`dataset.${camel(attr)}`) || code.includes(`[${attr}]`) || code.includes(`[${attr}=`);

        assert.ok(reads, `${file}.js reads ${attr} (dataset.${camel(attr)} or [${attr}])`);
    }
});

test('the drift button carries exactly what openDriftModal() takes from its dataset', () => {
    const { run } = load();
    const button = run(`DriftNoteButton({ env: 'qa', behind: '3', skipped: '1', sameVersion: true, diffJson: JSON.stringify({ files: 2, paths: ['a', 'b'] }) })`);
    const dataset = Object.fromEntries(attrsOf(button).map(a => [camel(a.name), unescape(a.value)]));

    assert.deepEqual(Object.keys(dataset).sort(), DRIFT_ATTRS.map(camel).sort());
    assert.deepEqual(JSON.parse(dataset.diff), { files: 2, paths: ['a', 'b'] }, 'the diff survives escaping');

    const matrix = source('app-technical-matrix');
    assert.match(matrix, /openDriftModal\(\{ \.\.\.infoBtn\.dataset, cellEnv: env, component: comp \}\)/, 'the click passes the dataset on');
    const params = /function openDriftModal\(\{([^}]*)\}\)/.exec(matrix)[1].split(',').map(p => p.trim().split(/\s*=/)[0]);
    assert.deepEqual(params.filter(p => !['cellEnv', 'component'].includes(p)).sort(), Object.keys(dataset).sort(),
        'openDriftModal() destructures the same names the button writes');
});

test('data-stop-click on a real link stops the click in the capture phase', () => {
    const { run, listeners } = load();
    const link = run(`ExternalLink({ href: 'https://example.com/x', stopClick: true, children: 'x' })`);
    const capture = listeners.filter(l => l.type === 'click' && l.capture);
    let stopped = 0;
    const click = target => capture.forEach(l => l.fn({ target, stopPropagation: () => { stopped++; } }));

    click(elementFrom(link));
    assert.equal(stopped, 1);
    click(elementFrom(run(`ExternalLink({ href: 'https://example.com/x', children: 'x' })`)));
    assert.equal(stopped, 1, 'a link without stopClick lets the click through');
});

test('data-close-dialog on the drift modal\'s close button closes its dialog', () => {
    const { run, listeners } = load();
    const content = run(`DriftModalContent({ headTitle: 'Diff', sections: [] })`);
    const closeButton = content.slice(content.indexOf('<button'));
    let closed = 0;
    const dialog = { close: () => { closed++; } };
    const button = elementFrom(closeButton, { dialog });

    listeners.filter(l => l.type === 'click' && !l.capture).forEach(l => l.fn({ target: button }));
    assert.equal(closed, 1);
});
