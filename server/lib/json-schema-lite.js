// A JSON Schema check for the pinned copies of the pdi contract's schemas (schemas/release-plan.v0.4.0.schema.json, and
// the envelope and payload definitions of schemas/event.v0.4.0.schema.json, lib/release-events-model.js checkEvent()),
// without a new dependency: exactly the keywords those copies use, enforced. KNOWN_KEYWORDS is the list;
// test/release-plans.test.js walks the pinned schema and fails on any keyword not in it, so a newer schema copied in
// with a keyword this does not enforce stops the tests instead of letting a bad file through.

// Annotations ($schema, $id, title, description, format: the date fields also carry a pattern) are not checks.
const KNOWN_KEYWORDS = ['$schema', '$id', 'title', 'description', 'format', 'type', 'required', 'properties', 'additionalProperties', 'items', 'minItems', 'minLength', 'minimum', 'maximum', 'pattern', 'enum'];

const typeOf = (v) => (Array.isArray(v) ? 'array' : v === null ? 'null' : Number.isInteger(v) ? 'integer' : typeof v);
const TYPE_WORDS = { object: 'an object', array: 'a list', string: 'text', integer: 'a whole number', number: 'a number', boolean: 'true or false' };

/**
 * Every place `value` breaks `schema`, as "path: why" lines (`releases[0].id: does not match ^R[0-9]+$`); empty when
 * it is valid. Messages name paths and rules, never a value (an unknown key is a name the file chose, so it is shown).
 *
 * @param {object} schema
 * @param {unknown} value
 * @returns {string[]}
 */
function validate(schema, value) {
    const errors = [];
    const check = (s, v, at) => {
        const where = at || '(root)';
        if (s.type) {
            const actual = typeOf(v);
            const ok = s.type === actual || (s.type === 'number' && actual === 'integer');
            if (!ok) {
                errors.push(`${where}: is not ${TYPE_WORDS[s.type] || s.type}`);
                return;
            }
        }
        if (typeof v === 'string') {
            if (s.minLength !== undefined && v.length < s.minLength) errors.push(`${where}: shorter than ${s.minLength}`);
            if (s.pattern !== undefined && !new RegExp(s.pattern, 'u').test(v)) errors.push(`${where}: does not match ${s.pattern}`);
        }
        if (s.enum !== undefined && !s.enum.includes(v)) errors.push(`${where}: is not one of ${s.enum.join(', ')}`);
        if (typeof v === 'number' && s.minimum !== undefined && v < s.minimum) errors.push(`${where}: below ${s.minimum}`);
        if (typeof v === 'number' && s.maximum !== undefined && v > s.maximum) errors.push(`${where}: above ${s.maximum}`);
        if (Array.isArray(v)) {
            if (s.minItems !== undefined && v.length < s.minItems) errors.push(`${where}: at least ${s.minItems} item${s.minItems === 1 ? '' : 's'}`);
            if (s.items) v.forEach((item, i) => check(s.items, item, `${at}[${i}]`));
        }
        if (typeOf(v) === 'object') {
            const props = s.properties || {};
            for (const key of s.required || []) if (!Object.prototype.hasOwnProperty.call(v, key)) errors.push(`${at ? `${at}.` : ''}${key}: is required`);
            for (const [key, child] of Object.entries(v)) {
                const path = at ? `${at}.${key}` : key;
                if (Object.prototype.hasOwnProperty.call(props, key)) check(props[key], child, path);
                else if (s.additionalProperties === false) errors.push(`${path}: is not allowed`);
            }
        }
    };
    check(schema, value, '');
    return errors;
}

module.exports = { KNOWN_KEYWORDS, validate };
