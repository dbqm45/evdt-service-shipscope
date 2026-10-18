// The YAML reader of the flags adapter (adapters/flags/yaml.js): what configuration files use, no dependencies.
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseYaml, YamlError } = require('../adapters/flags/yaml');

const y = (text) => parseYaml(text, 'f.yaml');

test('parseYaml: nested mappings, scalars as YAML 1.2, comments, quotes', () => {
    assert.deepEqual(y(`# flags
features:
  newCheckout: true      # on
  darkMode: false
  search: 25
  ratio: 0.5
  label: on              # a string in YAML 1.2
  empty:
  nothing: ~
  hex: 0x1F
  "quoted key": 'it''s'
  url: http://example.com:8080/x
  esc: "a\\tb \\u00e9"
  hash: "#not-a-comment"
`), {
        features: {
            newCheckout: true, darkMode: false, search: 25, ratio: 0.5, label: 'on', empty: null, nothing: null, hex: 31,
            'quoted key': "it's", url: 'http://example.com:8080/x', esc: 'a\tb é', hash: '#not-a-comment',
        },
    });
});

test('parseYaml: sequences of scalars and of mappings, also at the key\'s indentation and nested', () => {
    assert.deepEqual(y(`flags:
  - name: a
    enabled: true
  - name: b
    enabled: false
    tags:
      - x
      - y
names:
- one
- two
-
  - nested
`), {
        flags: [{ name: 'a', enabled: true }, { name: 'b', enabled: false, tags: ['x', 'y'] }],
        names: ['one', 'two', ['nested']],
    });
});

test('parseYaml: flow collections, also over several lines', () => {
    assert.deepEqual(y(`a: { x: 1, y: [true, "two", 'three'], z: }
b: [
  { name: n1, enabled: on },
  { name: n2, enabled: false },
]
c: []
d: {}
`), { a: { x: 1, y: [true, 'two', 'three'], z: null }, b: [{ name: 'n1', enabled: 'on' }, { name: 'n2', enabled: false }], c: [], d: {} });
});

test('parseYaml: anchors, aliases and merge keys; tags ignored', () => {
    assert.deepEqual(y(`base: &base
  a: true
  b: false
prod:
  <<: *base
  b: true
copy: *base
tagged: !!str 12
list: &l [1, 2]
again: *l
`), { base: { a: true, b: false }, prod: { a: true, b: true }, copy: { a: true, b: false }, tagged: 12, list: [1, 2], again: [1, 2] });
});

test('parseYaml: block scalars, documents, an empty file', () => {
    assert.deepEqual(y('a: |\n  line 1\n  line 2\nb: >-\n  folded\n  text\nc: 1\n'), { a: 'line 1\nline 2\n', b: 'folded text', c: 1 });
    assert.deepEqual(y('%YAML 1.2\n---\n# nothing\n---\nflags:\n  a: true\n...\n---\nother: 1\n'), { flags: { a: true } });
    assert.equal(y(''), null);
    assert.equal(y('# only a comment\n'), null);
    assert.deepEqual(y('- a\n- b\n'), ['a', 'b']);
});

test('parseYaml: what it does not read is an error with the line', () => {
    const bad = (text, re) => assert.throws(() => y(text), (err) => err instanceof YamlError && re.test(err.message), text);
    bad('a:\n\tb: 1\n', /f\.yaml:2: tabs cannot indent YAML/);
    bad('? complex\n: key\n', /f\.yaml:1: complex keys/);
    bad('a: one\n  two\n', /f\.yaml:2: plain values over several lines/);
    bad('a: [1, 2\n', /unclosed flow collection/);
    bad('a: *missing\n', /unknown alias \*missing/);
    bad('a: "open\n', /unterminated quoted value/);
    bad('a:\n    b: 1\n  c: 2\n', /f\.yaml:3: unexpected/);
});

test('parseYaml: no hang or unexpected error on truncated input', () => {
    const src = `base: &b\n  a: true\nflags:\n  <<: *b\n  list: [x, { y: 'z' }]\n  items:\n    - name: n\n      enabled: true\n  text: |\n    hi\n`;
    for (let i = 0; i <= src.length; i++) {
        for (const cut of [src.slice(0, i), src.slice(i), `${src.slice(0, i)}]${src.slice(i)}`]) {
            try { y(cut); } catch (err) { assert.ok(err instanceof YamlError, `${JSON.stringify(cut)}: ${err.stack}`); }
        }
    }
});
