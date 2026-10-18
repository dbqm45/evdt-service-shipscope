/**
 * A YAML reader for configuration files, without dependencies (the adapter has none, so the Action runs straight
 * from the repository). It covers what config files use: block mappings and sequences (also `- key: value` items),
 * flow collections (`{ a: 1 }`, `[a, b]`, also across lines), plain, single- and double-quoted scalars, block
 * scalars (`|`, `>`), comments, anchors, aliases and merge keys (`<<: *base`), tags (ignored) and several documents
 * (`---`; the first one with content is read). Scalars resolve as in YAML 1.2: true/false, null/~, integers
 * (also 0x, 0o) and floats; anything else is a string, so `yes`/`on` stay strings (the adapter reads them as on).
 * Not covered, and reported as an error with the line: complex keys (`? `) and plain scalars over several lines.
 */

class YamlError extends Error {}

/**
 * @param {string} text
 * @param {string} where for error messages
 * @returns {unknown} the first document with content (null for none)
 * @throws {YamlError}
 */
function parseYaml(text, where) {
    const documents = [[]];
    text.replace(/^﻿/, '').split(/\r?\n/).forEach((raw, i) => {
        if (/^(---|\.\.\.)(\s|$)/.test(raw)) {
            documents.push([]);
            const rest = raw.slice(3).trim();
            if (raw.startsWith('---') && rest && !rest.startsWith('#')) documents.at(-1).push({ no: i + 1, raw: ` ${rest}` });
            return;
        }
        if (/^%/.test(raw)) return; // directives
        documents.at(-1).push({ no: i + 1, raw });
    });
    for (const lines of documents) {
        const reader = new Reader(lines, where);
        if (reader.peek() === null) continue;
        const value = reader.block(-1);
        if (reader.peek() !== null) reader.fail(reader.peek(), 'unexpected content (check the indentation)');
        return value;
    }
    return null;
}

/** The line without its comment (`#` at the start or after a space, outside quotes); trailing spaces removed. */
function stripComment(s) {
    let quote = null;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (quote) {
            if (c === quote) {
                if (quote === "'" && s[i + 1] === "'") i += 1;
                else quote = null;
            } else if (c === '\\' && quote === '"') i += 1;
        } else if ((c === '"' || c === "'") && (i === 0 || /[\s[{,:-]/.test(s[i - 1]))) quote = c;
        else if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i).trimEnd();
    }
    return s.trimEnd();
}

/** Index of the `:` that ends a mapping key on this line (followed by a space or the end), or -1. */
function keyColon(s) {
    let quote = null;
    let depth = 0;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (quote) {
            if (c === quote) {
                if (quote === "'" && s[i + 1] === "'") i += 1;
                else quote = null;
            } else if (c === '\\' && quote === '"') i += 1;
        } else if ((c === '"' || c === "'") && (i === 0 || /[\s[{,]/.test(s[i - 1]))) quote = c;
        else if (c === '[' || c === '{') depth += 1;
        else if (c === ']' || c === '}') depth -= 1;
        else if (c === ':' && depth === 0 && (i + 1 === s.length || s[i + 1] === ' ')) return i;
    }
    return -1;
}

/** A plain scalar resolved as YAML 1.2 (core schema). */
function resolvePlain(s) {
    if (/^(?:null|Null|NULL|~|)$/.test(s)) return null;
    if (/^(?:true|True|TRUE)$/.test(s)) return true;
    if (/^(?:false|False|FALSE)$/.test(s)) return false;
    if (/^[-+]?[0-9]+$/.test(s)) return Number(s);
    if (/^0x[0-9a-fA-F]+$/.test(s)) return parseInt(s.slice(2), 16);
    if (/^0o[0-7]+$/.test(s)) return parseInt(s.slice(2), 8);
    if (/^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?$/.test(s)) return Number(s);
    if (/^[-+]?\.(?:inf|Inf|INF)$/.test(s)) return s.startsWith('-') ? -Infinity : Infinity;
    if (/^\.(?:nan|NaN|NAN)$/.test(s)) return NaN;
    return s;
}

const ESCAPES = { n: '\n', t: '\t', r: '\r', '0': '\0', '"': '"', '\\': '\\', '/': '/', ' ': ' ', e: '\x1b', b: '\b' };

class Reader {
    constructor(lines, where) {
        this.lines = lines.map((l) => {
            if (/^\s*\t/.test(l.raw) && l.raw.trim()) throw new YamlError(`${where}:${l.no}: tabs cannot indent YAML`);
            const content = stripComment(l.raw);
            return { no: l.no, raw: l.raw, indent: content.length - content.trimStart().length, text: content.trim() };
        });
        this.i = 0;
        this.where = where;
        this.anchors = {};
    }

    fail(line, message) {
        throw new YamlError(`${this.where}:${line ? line.no : 'end'}: ${message}`);
    }

    /** The next line with content, or null. */
    peek() {
        while (this.i < this.lines.length && !this.lines[this.i].text) this.i += 1;
        return this.i < this.lines.length ? this.lines[this.i] : null;
    }

    /** A node whose lines are indented more than `parent`. */
    block(parent) {
        const line = this.peek();
        if (!line || line.indent <= parent) return null;
        if (line.text === '-' || line.text.startsWith('- ')) return this.sequence(line.indent);
        if (keyColon(line.text) !== -1 || line.text.startsWith('? ')) return this.mapping(line.indent);
        this.i += 1;
        return this.inline(line.text, line, line.indent);
    }

    /** Anchor (&a) and tag (!t) properties at the start of a value; returns the rest and the anchor name. */
    properties(s) {
        let anchor = null;
        let rest = s;
        for (;;) {
            const m = /^(&[^\s,[\]{}]+|![^\s]*)(?:\s+|$)/.exec(rest);
            if (!m) return { rest, anchor };
            if (m[1].startsWith('&')) anchor = m[1].slice(1);
            rest = rest.slice(m[0].length);
        }
    }

    remember(anchor, value) {
        if (anchor) this.anchors[anchor] = value;
        return value;
    }

    mapping(indent) {
        const out = {};
        const merged = [];
        for (;;) {
            const line = this.peek();
            if (!line || line.indent < indent) break;
            if (line.indent > indent) this.fail(line, 'unexpected indentation');
            if (line.text.startsWith('? ')) this.fail(line, 'complex keys (? ) are not supported');
            const colon = keyColon(line.text);
            if (colon === -1) this.fail(line, 'expected "key: value"');
            const key = this.key(line.text.slice(0, colon).trim(), line);
            this.i += 1;
            const value = this.after(line.text.slice(colon + 1).trim(), line, indent);
            if (key === '<<') merged.push(...(Array.isArray(value) ? value : [value]));
            else out[key] = value;
        }
        for (const base of merged) {
            if (base === null || typeof base !== 'object' || Array.isArray(base)) continue;
            for (const [k, v] of Object.entries(base)) if (!Object.hasOwn(out, k)) out[k] = v;
        }
        return out;
    }

    key(s, line) {
        if (s.startsWith('"') || s.startsWith("'")) return String(this.quoted(s, line).value);
        const value = this.properties(s).rest;
        return value;
    }

    sequence(indent) {
        const out = [];
        for (;;) {
            const line = this.peek();
            if (!line || line.indent !== indent || !(line.text === '-' || line.text.startsWith('- '))) {
                if (line && line.indent > indent) this.fail(line, 'unexpected indentation');
                break;
            }
            const rest = line.text.slice(1).trimStart();
            if (!rest) {
                this.i += 1;
                out.push(this.block(indent));
            } else if (keyColon(rest) !== -1 && !/^[[{"']/.test(rest)) {
                // "- key: value": a mapping whose first entry shares the dash's line.
                const offset = line.text.length - rest.length;
                this.lines[this.i] = { ...line, indent: indent + offset, text: rest };
                out.push(this.mapping(indent + offset));
            } else if (rest === '-' || rest.startsWith('- ')) {
                const offset = line.text.length - rest.length;
                this.lines[this.i] = { ...line, indent: indent + offset, text: rest };
                out.push(this.sequence(indent + offset));
            } else {
                this.i += 1;
                out.push(this.after(rest, line, indent));
            }
        }
        return out;
    }

    /** The value after "key:" or "- ": inline, a block scalar, or a nested block on the next lines. */
    after(s, line, indent) {
        const { rest, anchor } = this.properties(s);
        if (!rest) {
            const next = this.peek();
            // A sequence may sit at the key's own indentation ("key:\n- a").
            if (next && next.indent === indent && (next.text === '-' || next.text.startsWith('- ')) && keyColon(line.text) !== -1) {
                return this.remember(anchor, this.sequence(indent));
            }
            return this.remember(anchor, this.block(indent));
        }
        if (/^[|>]/.test(rest)) return this.remember(anchor, this.blockScalar(rest, indent));
        return this.remember(anchor, this.inline(rest, line, indent));
    }

    blockScalar(header, indent) {
        const m = /^([|>])([+-]?)([1-9]?)([+-]?)$/.exec(header);
        if (!m) this.fail(this.lines[this.i - 1], `bad block scalar header "${header}"`);
        const folded = m[1] === '>';
        const chomp = m[2] || m[4];
        const body = [];
        let width = m[3] ? indent + Number(m[3]) : null;
        while (this.i < this.lines.length) {
            const { raw } = this.lines[this.i];
            const lead = raw.length - raw.trimStart().length;
            if (raw.trim() && width === null) width = lead;
            if (raw.trim() && (lead <= indent || lead < width)) break;
            body.push(raw.trim() ? raw.slice(width) : '');
            this.i += 1;
        }
        while (body.length && body.at(-1) === '' && chomp !== '+') body.pop();
        let text = folded ? body.reduce((acc, l, idx) => (idx === 0 ? l : acc + (l === '' || body[idx - 1] === '' ? '\n' : ' ') + l), '') : body.join('\n');
        if (chomp !== '-' && body.length) text += '\n';
        return text;
    }

    /** A value written on one line (or a flow collection continuing on the next lines). */
    inline(s, line, indent) {
        const { rest, anchor } = this.properties(s);
        if (rest.startsWith('*')) {
            const name = rest.slice(1).trim();
            if (!Object.hasOwn(this.anchors, name)) this.fail(line, `unknown alias *${name}`);
            return this.anchors[name];
        }
        if (rest.startsWith('[') || rest.startsWith('{')) {
            let source = rest;
            // A flow collection may go on over the following lines until its brackets close.
            while (!this.balanced(source)) {
                const next = this.lines[this.i];
                if (!next) this.fail(line, 'unclosed flow collection');
                source += ` ${next.text}`;
                this.i += 1;
            }
            const flow = new Flow(source, (message) => this.fail(line, message), this);
            const value = flow.value();
            flow.skip();
            if (flow.pos !== source.length) this.fail(line, `unexpected "${source.slice(flow.pos)}" after a flow collection`);
            return this.remember(anchor, value);
        }
        if (rest.startsWith('"') || rest.startsWith("'")) {
            const { value, end } = this.quoted(rest, line);
            if (rest.slice(end).trim()) this.fail(line, `unexpected "${rest.slice(end).trim()}" after a quoted value`);
            return this.remember(anchor, value);
        }
        const next = this.peek();
        if (next && next.indent > indent && keyColon(next.text) === -1 && !next.text.startsWith('- ')) {
            this.fail(next, 'plain values over several lines are not supported (quote the value or use | or >)');
        }
        return this.remember(anchor, resolvePlain(rest));
    }

    balanced(s) {
        let depth = 0;
        let quote = null;
        for (let i = 0; i < s.length; i++) {
            const c = s[i];
            if (quote) {
                if (c === quote) quote = null;
                else if (c === '\\' && quote === '"') i += 1;
            } else if (c === '"' || c === "'") quote = c;
            else if (c === '[' || c === '{') depth += 1;
            else if (c === ']' || c === '}') depth -= 1;
        }
        return depth <= 0;
    }

    /** A quoted scalar at the start of `s`: its value and where it ends. */
    quoted(s, line) {
        const q = s[0];
        let out = '';
        let i = 1;
        for (; i < s.length; i++) {
            const c = s[i];
            if (q === "'" && c === "'") {
                if (s[i + 1] === "'") { out += "'"; i += 1; continue; }
                return { value: out, end: i + 1 };
            }
            if (q === '"' && c === '"') return { value: out, end: i + 1 };
            if (q === '"' && c === '\\') {
                const e = s[i + 1];
                if (e === 'x' || e === 'u' || e === 'U') {
                    const len = { x: 2, u: 4, U: 8 }[e];
                    out += String.fromCodePoint(parseInt(s.slice(i + 2, i + 2 + len), 16));
                    i += 1 + len;
                } else {
                    out += ESCAPES[e] ?? e;
                    i += 1;
                }
                continue;
            }
            out += c;
        }
        return this.fail(line, 'unterminated quoted value (values over several lines are not supported)');
    }
}

/** Flow collections: `{ a: 1, b: [x, "y"] }`. */
class Flow {
    constructor(s, fail, reader) {
        this.s = s;
        this.pos = 0;
        this.fail = fail;
        this.reader = reader;
    }

    skip() {
        while (this.pos < this.s.length && /\s/.test(this.s[this.pos])) this.pos += 1;
    }

    value() {
        this.skip();
        const c = this.s[this.pos];
        if (c === '{') return this.collection('{', '}');
        if (c === '[') return this.collection('[', ']');
        if (c === '"' || c === "'") {
            const { value, end } = this.reader.quoted(this.s.slice(this.pos), null);
            this.pos += end;
            return value;
        }
        if (c === '*') {
            const m = /^\*([^\s,[\]{}]+)/.exec(this.s.slice(this.pos));
            this.pos += m[0].length;
            if (!Object.hasOwn(this.reader.anchors, m[1])) this.fail(`unknown alias *${m[1]}`);
            return this.reader.anchors[m[1]];
        }
        const m = /^[^,[\]{}]*?(?=\s*(?:[,\]}]|:(?:\s|$))|\s*$)/.exec(this.s.slice(this.pos));
        this.pos += m[0].length;
        return resolvePlain(m[0].trim());
    }

    collection(open, close) {
        this.pos += 1;
        const isMap = open === '{';
        const out = isMap ? {} : [];
        for (;;) {
            this.skip();
            if (this.s[this.pos] === close) { this.pos += 1; return out; }
            if (this.pos >= this.s.length) this.fail(`unclosed "${open}"`);
            const first = this.value();
            this.skip();
            if (this.s[this.pos] === ':') {
                this.pos += 1;
                const v = this.value();
                if (isMap) out[String(first)] = v;
                else out.push({ [String(first)]: v });
            } else if (isMap) out[String(first)] = null;
            else out.push(first);
            this.skip();
            if (this.s[this.pos] === ',') this.pos += 1;
            else if (this.s[this.pos] !== close) this.fail(`expected "," or "${close}"`);
        }
    }
}

module.exports = { parseYaml, YamlError };
