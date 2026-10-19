// The pages' Content-Security-Policy allows scripts only from the server's own files (server/web.js): every page
// and every piece of markup the scripts build must do without inline <script> and inline event handlers, or the
// browser blocks them. Checked on the sources, since the tests' stub DOM runs no browser.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { buildApp } = require('../web');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const files = (dir, re) => fs.readdirSync(path.join(ROOT, dir)).filter((f) => re.test(f)).map((f) => `${dir}/${f}`);

test('pages have no inline <script> and every <script> has a src', () => {
    for (const page of [...files('docs', /^index\.html$/), ...files('server/ui', /\.html$/)]) {
        for (const tag of read(page).match(/<script\b[^>]*>/g) || []) assert.match(tag, /\bsrc="/, `${page}: ${tag}`);
    }
});

test('no inline event handler attributes in pages or in the markup scripts build', () => {
    for (const file of [...files('docs', /^(index\.html|app-[a-z-]+\.js)$/), ...files('server/ui', /\.(html|js)$/)]) {
        assert.doesNotMatch(read(file), /<[^>]*\son[a-z]+\s*=\s*["']/i, file);
        assert.doesNotMatch(read(file), /\son(click|change|input|submit|load|error)=\\?["']/i, file);
    }
});

test('the header on the pages and their files: scripts and connections only from this server, no framing', async () => {
    const auth = { githubClientId: 'x', githubClientSecret: 'y', publicBaseUrl: 'http://localhost:3000', secureCookies: false };
    const app = buildApp({ pool: { query: async () => ({ rows: [] }) }, auth });
    const res = await app.inject({ method: 'GET', url: '/ui/theme.js' });
    assert.equal(res.statusCode, 200);
    const directives = res.headers['content-security-policy'].split('; ');
    for (const d of ["default-src 'self'", "script-src 'self'", "connect-src 'self'", "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'"]) {
        assert.ok(directives.includes(d), d);
    }
    assert.ok(!directives.some((d) => d.startsWith('script-src') && d.includes('unsafe')), 'no inline or eval scripts');
    await app.close();
});
