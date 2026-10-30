// Local mode (design-docs/LOCAL-PDI-PLAN.pl.md): on only for a localhost PUBLIC_BASE_URL outside production, the
// same condition `npm run dev:mock` asks for; decided once at start and passed on explicitly.
const { test } = require('node:test');
const assert = require('node:assert');
const { localModeEnabled } = require('../lib/local-mode');

test('localModeEnabled: http on localhost or 127.0.0.1 (any port), never in production or anywhere else', () => {
    for (const url of ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://localhost', 'http://localhost:3000/']) {
        assert.strictEqual(localModeEnabled({ PUBLIC_BASE_URL: url }), true, url);
    }
    for (const env of [
        {}, { PUBLIC_BASE_URL: '' }, { PUBLIC_BASE_URL: 'not a url' },
        { PUBLIC_BASE_URL: 'https://localhost:3000' }, { PUBLIC_BASE_URL: 'https://shipscope.example.com' },
        { PUBLIC_BASE_URL: 'http://shipscope.example.com' }, { PUBLIC_BASE_URL: 'http://localhost.example.com:3000' },
        { PUBLIC_BASE_URL: 'http://192.168.1.10:3000' }, { PUBLIC_BASE_URL: 'http://[::1]:3000' },
        { PUBLIC_BASE_URL: 'http://localhost:3000', NODE_ENV: 'production' },
    ]) assert.strictEqual(localModeEnabled(env), false, JSON.stringify(env));
});
