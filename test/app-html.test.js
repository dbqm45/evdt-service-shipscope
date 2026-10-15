const test = require('node:test');
const assert = require('node:assert/strict');
const { escapeHtml, raw, html } = require('../docs/app-html');

test('html escapes plain interpolated values, including inside attributes', () => {
    const evil = '"><img src=x onerror=alert(1)>';

    assert.equal(
        String(html`<div title="${evil}">${evil}</div>`),
        '<div title="&quot;&gt;&lt;img src=x onerror=alert(1)&gt;">&quot;&gt;&lt;img src=x onerror=alert(1)&gt;</div>'
    );
});

test('html does not double-escape nested html results, raw() constants, or arrays of them', () => {
    const item = name => html`<li>${name}</li>`;
    const out = String(html`<ul>${['a&b', '<c>'].map(item)}</ul>${raw('<svg></svg>')}`);

    assert.equal(out, '<ul><li>a&amp;b</li><li>&lt;c&gt;</li></ul><svg></svg>');
});

test('html treats null/undefined as empty, numbers as text, and escapes arrays of plain strings', () => {
    assert.equal(String(html`${null}|${undefined}|${0}|${['<', '>']}`), '||0|&lt;&gt;');
});

test('a string that merely looks like html is still escaped (only SafeHtml is trusted)', () => {
    assert.equal(String(html`${'<b>x</b>'}`), '&lt;b&gt;x&lt;/b&gt;');
    assert.equal(escapeHtml("it's"), 'it&#39;s');
});

test('el.innerHTML = html`…` coerces to the markup string', () => {
    const el = {};

    el.innerHTML = html`<p>${'<'}</p>`;
    assert.equal(`${el.innerHTML}`, '<p>&lt;</p>');
});
