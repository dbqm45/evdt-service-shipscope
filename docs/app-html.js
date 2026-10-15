// HTML-escaping primitives. Loaded before app-core.js and kept free of any DOM/`location` access so
// test/app-html.test.js can load it in plain Node (it is a classic script in the browser, a CommonJS module
// there — see the `module` guard at the bottom).

/** Escapes free text pulled from Jira/GitHub (issue titles, descriptions, display names, dependency
 *  notes…) before it's interpolated into an HTML template string. Those fields are editable by anyone
 *  with access to the source system (a Jira issue title, a GitHub display name), not by this app, so they
 *  can't be trusted the way a value this code itself computed (an enum, a date, a count) can. */
function escapeHtml(value){
    if (value === null || value === undefined) {
        return '';
    }

    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/** Marker for a string that is already HTML (built by `html`, or a fixed developer-authored constant such as
 *  an `ICONS` entry) and must not be escaped again when interpolated into `html\`…\``. */
class SafeHtml {
    constructor(value){
        this.value = value;
    }

    toString(){
        return this.value;
    }
}

/** Wraps a trusted, developer-authored HTML string. Never pass anything derived from Jira/GitHub data. */
function raw(value){
    return new SafeHtml(String(value));
}

function interpolate(value){
    if (value instanceof SafeHtml) {
        return value.value;
    }
    if (Array.isArray(value)) {
        return value.map(interpolate).join('');
    }

    return escapeHtml(value);
}

/** Tagged template that escapes every interpolated value unless it is a `SafeHtml` (a nested `html\`\``
 *  result or a `raw()` constant) or an array of them — so a forgotten `escapeHtml()` can't happen by
 *  construction. The literal parts of the template are trusted as written. `el.innerHTML = html\`…\``
 *  works as-is (the result stringifies to its markup). */
function html(strings, ...values){
    let out = strings[0];

    values.forEach((value, i) => {
        out += interpolate(value) + strings[i + 1];
    });

    return new SafeHtml(out);
}

if (typeof module !== 'undefined') {
    module.exports = { escapeHtml, SafeHtml, raw, html };
}
