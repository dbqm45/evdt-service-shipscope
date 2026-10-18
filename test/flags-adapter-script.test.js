// Reading flags from TypeScript/JavaScript config files without running them (adapters/flags/script-objects.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const { readScriptObjects, ScriptParseError, Unreadable } = require('../adapters/flags/script-objects');

const read = (text) => readScriptObjects(text, 'f.ts');

test('readScriptObjects: exported and local consts, export default, type annotations, as const and satisfies', () => {
    const { objects, exported } = read(`import { Flags } from './types';
const local = { a: true };
export const flags: Record<string, boolean | number> = { b: false, 'c-d': 25, "e": 'on' } as const;
export const typed = { f: 1 } satisfies Flags;
export default { g: true };
`);
    assert.deepEqual(objects, { local: { a: true }, flags: { b: false, 'c-d': 25, e: 'on' }, typed: { f: 1 }, default: { g: true } });
    assert.deepEqual(exported, ['flags', 'typed', 'default']);
});

test('readScriptObjects: comments, trailing commas, nested objects, arrays, numbers and escapes', () => {
    const { objects } = read(`export const flags = {
  // a line comment with { braces }
  a: true, /* block, with "quotes" */
  nested: { deep: { on: 'yes' } },
  list: [1, 'two', false,],
  n: -1.5e2, hex: 0x1F, big: 1_000,
  quoted: 'it\\'s',
  tpl: \`plain\`,
  nil: null, undef: undefined,
};`);
    assert.deepEqual(objects.flags, {
        a: true, nested: { deep: { on: 'yes' } }, list: [1, 'two', false], n: -150, hex: 31, big: 1000, quoted: "it's", tpl: 'plain', nil: null, undef: null,
    });
});

test('readScriptObjects: values it cannot evaluate are Unreadable, with their source', () => {
    const { objects } = read(`export const flags = {
  env: process.env.FLAG === 'on',
  call: isOn('x', { y: 1 }),
  tpl: \`\${prefix}-x\`,
  shorthand,
  ok: true,
};`);
    assert.ok(objects.flags.env instanceof Unreadable);
    assert.equal(objects.flags.env.text, "process.env.FLAG === 'on'");
    assert.equal(objects.flags.call.text, "isOn('x', { y: 1 })");
    assert.ok(objects.flags.tpl instanceof Unreadable);
    assert.equal(objects.flags.shorthand.text, 'shorthand');
    assert.equal(objects.flags.ok, true);
});

test('readScriptObjects: spreads of earlier objects in the file; anything else is an error', () => {
    assert.deepEqual(read('const base = { a: true, b: false };\nexport const prod = { ...base, b: true };').objects.prod, { a: true, b: true });
    assert.throws(() => read("import { base } from './base';\nexport const prod = { ...base };"), (err) => err instanceof ScriptParseError && /f\.ts:2: \.\.\.base is not an object defined earlier/.test(err.message));
    assert.throws(() => read('export const a = { [key]: true };'), /computed keys/);
    assert.throws(() => read('export const a = { on() { return true; } };'), /methods are not flag values/);
});

test('readScriptObjects: only top-level declarations; none is an empty result', () => {
    const { objects } = read(`function build() {
  const inner = { x: true };
  return inner;
}
export const flags = { y: true };
const s = "const fake = { z: true }";
`);
    assert.deepEqual(objects, { flags: { y: true } });
    assert.deepEqual(read('export const n = 1;\nexport function f() {}').objects, {});
});
