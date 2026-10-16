// Tests docs/app-components.js (vm, no DOM needed: components are pure string builders over app-html.js + ICONS).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const stubElement = () => ({ setAttribute() {}, getAttribute() { return null; }, addEventListener() {}, classList: { toggle() {}, add() {} }, style: {} });

function load(){
    const ctx = { console, URLSearchParams, location: { search: '' }, localStorage: { setItem() {}, getItem: () => null },
        document: { documentElement: stubElement(), getElementById: () => stubElement() } };

    vm.createContext(ctx);
    ['app-html', 'app-core', 'app-components'].forEach(f =>
        vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'docs', `${f}.js`), 'utf8'), ctx));

    return code => String(vm.runInContext(code, ctx));
}

const run = load();

test('classNames drops falsy parts', () => {
    assert.equal(run(`classNames('a', '', null, 'b', false)`), 'a b');
});

test('SummaryCard renders the tone modifier only when set, and escapes values', () => {
    assert.match(run(`SummaryCard({ label: 'L', value: '1', note: 'n' })`), /<span class="summary-note">n<\/span>/);
    assert.match(run(`SummaryCard({ label: 'L', value: '1', note: 'n', tone: 'warn' })`), /class="summary-note summary-note-warn"/);
    assert.match(run(`SummaryCard({ label: '<b>', value: '1', note: 'n' })`), /&lt;b&gt;/);
});

test('Tag: plain, titled and icon variants', () => {
    assert.equal(run(`Tag({ text: 'x', cls: 'mono' })`), '<span class="tag mono">x</span>');
    assert.equal(run(`Tag({ text: 'x', title: 'T' })`), '<span class="tag" title="T">x</span>');
    assert.match(run(`Tag({ text: 'x', cls: 'c', icon: ICONS.flag })`), /^<span class="tag tag-flagged c"><svg/);
});

test('EmptyState adds the panel class on request', () => {
    assert.equal(run(`EmptyState({ message: 'm' })`), '<div class="empty">m</div>');
    assert.equal(run(`EmptyState({ message: 'm', panel: true })`), '<div class="empty panel">m</div>');
});

test('ItemCount pluralizes', () => {
    assert.match(run(`ItemCount({ count: 1 })`), /<\/span> item$/);
    assert.match(run(`ItemCount({ count: 2 })`), /<\/span> items$/);
});

test('joinMeta drops falsy parts and separates the rest', () => {
    assert.equal(run(`joinMeta(['a', null, 'b'])`), 'a<span class="deploy-meta-dot"></span>b');
});

test('ExternalLink escapes the href and can stop click propagation', () => {
    const out = run(`ExternalLink({ href: 'x"y', stopClick: true, children: 'go' })`);

    assert.match(out, /href="x&quot;y"/);
    assert.match(out, /onclick="event.stopPropagation\(\)"/);
});

test('ExternalLink without an href is the same text, unlinked', () => {
    assert.equal(run(`ExternalLink({ href: null, cls: 'issue-badge', stopClick: true, children: 'ABC-1' })`), '<span class="issue-badge">ABC-1</span>');
    assert.equal(run(`IssueBadge({ issueKey: '<x>', href: '' })`), '<span class="issue-badge">&lt;x&gt;</span>');
});

test('EpicProgress renders nothing but a placeholder without a rollup', () => {
    assert.equal(run(`EpicProgress({ progress: null })`), '<div class="wi-epic-progress"></div>');
    assert.match(run(`EpicProgress({ progress: { released: 1, code: 0, total: 2 } })`), /wi-epic-partial/);
});

test('BarRow and BarSegment', () => {
    const seg = run(`BarSegment({ cls: 'seg-x', widthPct: 33.333, title: 't' })`);

    assert.match(seg, /style="width:33.3%"/);
    assert.match(run(`BarRow({ label: 'L', valueText: 5, segments: BarSegment({ cls: 'c', widthPct: 10, title: 't' }) })`), /bar-row-count">5</);
});

test('FlagStateText maps kind to label and class', () => {
    assert.match(run(`FlagStateText({ kind: 'on' })`), /flag-on-text">ON</);
    assert.match(run(`FlagStateText({ kind: 'off', cls: 'ff-state', title: 'x' })`), /flag-off-text ff-state" title="x">OFF</);
    assert.match(run(`FlagStateText({ kind: 'missing' })`), /flag-missing-text">—</);
});

test('DeployChips returns nothing without issues or flags', () => {
    assert.equal(run(`DeployChips({ issues: [], flagBadges: {} })`), '');
    assert.match(run(`DeployChips({ issues: [{ key: 'A-1', href: '/A-1' }], flagBadges: { f: true } })`), /issue-badge.*rf-on/s);
});
