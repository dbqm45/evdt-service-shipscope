/**
 * Reads the object literals of a TypeScript or JavaScript config file without running it: each top-level
 * `const NAME = { ... }` (exported or not, with or without a type annotation, `as const` or `satisfies`) and
 * `export default { ... }`. Values must be written out: strings, numbers, true/false/null, nested objects and
 * arrays, and `...NAME` of an object defined earlier in the same file. Anything else (an identifier, a call, an
 * import) is kept as an Unreadable value, which is an error only if it is used as a flag.
 *
 * Running the file instead would need the project's TypeScript setup and would execute code from the scanned
 * repository; a project whose flags are computed can print them as JSON in a step of its own (ONBOARDING.md).
 */

class ScriptParseError extends Error {}

/** A value the reader could not evaluate, with its source text for the error message. */
class Unreadable {
    constructor(text) {
        this.text = text;
    }
}

const IDENT = /[A-Za-z_$][\w$]*/y;
const NUMBER = /-?(?:0[xX][0-9a-fA-F_]+|(?:\d[\d_]*)?\.?\d[\d_]*(?:[eE][+-]?\d+)?)/y;
const DECLARATION = /(?:^|[;\n}])\s*(export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]*)?=\s*(?=\{)|(?:^|[;\n}])\s*(export)\s+default\s+(?=\{)/g;

/**
 * @param {string} text
 * @param {string} where for error messages
 * @returns {{ objects: Record<string, object>, exported: string[] }} every top-level object literal by its name
 *   (`default` for `export default`), and which of them are exported
 * @throws {ScriptParseError}
 */
function readScriptObjects(text, where) {
    const objects = {};
    const exported = [];
    const masked = maskCommentsAndStrings(text);
    for (const match of masked.matchAll(DECLARATION)) {
        const start = match.index + match[0].length;
        // Only declarations at the top level of the file, not inside a function or another object.
        if (depthAt(masked, start) !== 0) continue;
        const name = match[2] || 'default';
        objects[name] = new Parser(text, start, where, objects).object();
        if (match[1] || match[3]) exported.push(name);
    }
    return { objects, exported };
}

/** The text with comments and string contents blanked out (same length), so searches skip them. */
function maskCommentsAndStrings(text) {
    let out = '';
    let i = 0;
    while (i < text.length) {
        const c = text[i];
        if (c === '/' && text[i + 1] === '/') {
            const end = text.indexOf('\n', i);
            const stop = end === -1 ? text.length : end;
            out += ' '.repeat(stop - i);
            i = stop;
        } else if (c === '/' && text[i + 1] === '*') {
            const end = text.indexOf('*/', i + 2);
            const stop = end === -1 ? text.length : end + 2;
            out += text.slice(i, stop).replace(/[^\n]/g, ' ');
            i = stop;
        } else if (c === '"' || c === "'" || c === '`') {
            let j = i + 1;
            while (j < text.length && text[j] !== c) j += text[j] === '\\' ? 2 : 1;
            out += c + text.slice(i + 1, j).replace(/[^\n]/g, ' ') + (j < text.length ? c : '');
            i = j + 1;
        } else {
            out += c;
            i += 1;
        }
    }
    return out;
}

/** How many braces/brackets/parentheses are open at `index` of a masked text. */
function depthAt(masked, index) {
    let depth = 0;
    for (let i = 0; i < index; i++) {
        if ('{[('.includes(masked[i])) depth += 1;
        else if ('}])'.includes(masked[i])) depth -= 1;
    }
    return depth;
}

class Parser {
    constructor(text, pos, where, known) {
        this.text = text;
        this.pos = pos;
        this.where = where;
        this.known = known;
    }

    fail(message) {
        const line = this.text.slice(0, this.pos).split('\n').length;
        throw new ScriptParseError(`${this.where}:${line}: ${message}`);
    }

    skip() {
        for (;;) {
            const rest = this.text.slice(this.pos);
            const ws = /^\s+/.exec(rest);
            if (ws) { this.pos += ws[0].length; continue; }
            if (rest.startsWith('//')) {
                const end = this.text.indexOf('\n', this.pos);
                this.pos = end === -1 ? this.text.length : end;
                continue;
            }
            if (rest.startsWith('/*')) {
                const end = this.text.indexOf('*/', this.pos + 2);
                this.pos = end === -1 ? this.text.length : end + 2;
                continue;
            }
            return;
        }
    }

    peek() {
        this.skip();
        return this.text[this.pos];
    }

    expect(c) {
        if (this.peek() !== c) this.fail(`expected "${c}"`);
        this.pos += 1;
    }

    sticky(re) {
        re.lastIndex = this.pos;
        const m = re.exec(this.text);
        if (!m) return null;
        this.pos += m[0].length;
        return m[0];
    }

    /** A string literal at pos, consumed; null for a template with ${...} in it (consumed too). */
    string() {
        const quote = this.text[this.pos];
        let out = '';
        let interpolated = false;
        let i = this.pos + 1;
        while (i < this.text.length && this.text[i] !== quote) {
            if (this.text[i] === '\\') {
                const next = this.text[i + 1];
                out += { n: '\n', t: '\t', r: '\r' }[next] ?? next;
                i += 2;
            } else if (quote === '`' && this.text[i] === '$' && this.text[i + 1] === '{') {
                interpolated = true;
                let depth = 0;
                for (i += 1; i < this.text.length; i++) {
                    if (this.text[i] === '{') depth += 1;
                    else if (this.text[i] === '}' && --depth === 0) break;
                }
                i += 1;
            } else {
                out += this.text[i];
                i += 1;
            }
        }
        if (i >= this.text.length) this.fail('unterminated string');
        this.pos = i + 1;
        return interpolated ? null : out;
    }

    object() {
        this.expect('{');
        const out = {};
        for (;;) {
            if (this.peek() === '}') { this.pos += 1; return out; }
            if (this.text.startsWith('...', this.pos)) {
                this.pos += 3;
                this.skip();
                const name = this.sticky(IDENT);
                if (!name || !Object.hasOwn(this.known, name)) this.fail(`...${name || ''} is not an object defined earlier in this file`);
                Object.assign(out, this.known[name]);
            } else {
                const key = this.key();
                const next = this.peek();
                if (next === ':') {
                    this.pos += 1;
                    out[key] = this.value();
                } else if (next === ',' || next === '}') {
                    out[key] = new Unreadable(key);
                } else if (next === '(') {
                    this.fail(`${key}: methods are not flag values`);
                } else {
                    this.fail(`expected ":" after ${key}`);
                }
            }
            const sep = this.peek();
            if (sep === ',') { this.pos += 1; continue; }
            if (sep !== '}') this.fail('expected "," or "}"');
        }
    }

    key() {
        const c = this.peek();
        if (c === '"' || c === "'") {
            const s = this.string();
            if (s === null) this.fail('a key cannot be a template');
            return s;
        }
        if (c === '[') this.fail('computed keys ([...]) are not supported');
        const ident = this.sticky(IDENT) ?? this.sticky(NUMBER);
        if (ident === null) this.fail('expected a key');
        return ident;
    }

    array() {
        this.expect('[');
        const out = [];
        for (;;) {
            if (this.peek() === ']') { this.pos += 1; return out; }
            out.push(this.value());
            const sep = this.peek();
            if (sep === ',') { this.pos += 1; continue; }
            if (sep !== ']') this.fail('expected "," or "]"');
        }
    }

    value() {
        const c = this.peek();
        const start = this.pos;
        let value;
        if (c === '{') value = this.object();
        else if (c === '[') value = this.array();
        else if (c === '"' || c === "'" || c === '`') {
            value = this.string();
            if (value === null) value = this.expression(start);
        } else {
            const word = this.sticky(/(?:true|false|null|undefined)(?![\w$])/y);
            if (word !== null) value = { true: true, false: false, null: null, undefined: null }[word];
            else {
                const num = this.sticky(NUMBER);
                value = num !== null && /^\s*(?:[,}\]]|as\b|satisfies\b)/.test(this.text.slice(this.pos)) ? Number(num.replace(/_/g, '')) : this.expression(start);
            }
        }
        // `x as const`, `x satisfies T` and `x!` after a literal: types only.
        this.skip();
        if (!(value instanceof Unreadable) && /^(?:as|satisfies)\b/.test(this.text.slice(this.pos))) value = this.expression(start, value);
        return value;
    }

    /** Skips an expression up to the next "," or closing bracket at its level; Unreadable unless `keep` is given. */
    expression(start, keep) {
        this.pos = start;
        let depth = 0;
        while (this.pos < this.text.length) {
            const c = this.text[this.pos];
            if (c === '"' || c === "'" || c === '`') { this.string(); continue; }
            if (this.text.startsWith('//', this.pos) || this.text.startsWith('/*', this.pos)) { this.skip(); continue; }
            if ('{[('.includes(c)) depth += 1;
            else if ('}])'.includes(c)) {
                if (depth === 0) break;
                depth -= 1;
            } else if (c === ',' && depth === 0) break;
            this.pos += 1;
        }
        return keep !== undefined ? keep : new Unreadable(this.text.slice(start, this.pos).trim());
    }
}

module.exports = { readScriptObjects, ScriptParseError, Unreadable };
