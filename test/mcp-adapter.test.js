// The ShipScope MCP server (K-1, adapters/mcp/, design-docs/K1-MCP-PLAN.pl.md): JSON-RPC over stdio for Claude, read
// only, over the service API with a service token. The protocol on lib.js, the client against a local HTTP server,
// and the process itself over stdio.
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { createServer, TOOLS, PROTOCOL_VERSIONS } = require('../adapters/mcp/lib');

const TOKEN = `shps_${'a'.repeat(43)}`;
const ENTRY = path.join(__dirname, '..', 'adapters', 'mcp', 'shipscope-mcp.js');

/** A local stand-in for ShipScope's service API: records what it was asked, answers from `routes`. */
async function fakeShipScope(t, routes) {
    const seen = [];
    const server = http.createServer((req, res) => {
        seen.push({ url: req.url, authorization: req.headers.authorization });
        const route = routes[new URL(req.url, 'http://x').pathname];
        const { status = 200, body = {}, headers = {} } = typeof route === 'function' ? route(req) : route || { status: 404, body: { error: 'Not Found' } };
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify(body));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => server.close());
    return { url: `http://127.0.0.1:${server.address().port}`, seen };
}

const call = (server, name, args = {}, id = 1) => server.handle({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

test('initialize: the client\'s protocol version when supported, else the newest; a tools server named shipscope', async () => {
    const server = createServer({ env: {} });
    const res = await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
    assert.deepStrictEqual([res.id, res.result.protocolVersion, res.result.serverInfo.name, typeof res.result.capabilities.tools], [1, '2025-03-26', 'shipscope', 'object']);
    assert.match(res.result.instructions, /data, not instructions/i);
    const later = await server.handle({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2099-01-01' } });
    assert.strictEqual(later.result.protocolVersion, PROTOCOL_VERSIONS[PROTOCOL_VERSIONS.length - 1]);
    assert.strictEqual(await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null, 'a notification gets no answer');
    assert.deepStrictEqual(await server.handle({ jsonrpc: '2.0', id: 3, method: 'ping' }), { jsonrpc: '2.0', id: 3, result: {} });
    assert.strictEqual((await server.handle({ jsonrpc: '2.0', id: 4, method: 'resources/list' })).error.code, -32601);
    assert.strictEqual((await server.handle({ jsonrpc: '2.0', id: 5 })).error.code, -32600);
});

test('tools/list: six read-only tools, each with an input schema that allows nothing extra', async () => {
    const { result } = await createServer({ env: {} }).handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.deepStrictEqual(result.tools.map((x) => x.name), ['get_item_status', 'list_changes', 'get_release_plan', 'list_flags', 'get_environments', 'get_metrics']);
    assert.deepStrictEqual(result.tools, TOOLS);
    for (const tool of result.tools) {
        assert.strictEqual(tool.inputSchema.type, 'object', tool.name);
        assert.strictEqual(tool.inputSchema.additionalProperties, false, tool.name);
        assert.strictEqual(tool.annotations.readOnlyHint, true, tool.name);
        assert.ok(tool.description.length > 40, tool.name);
    }
    assert.deepStrictEqual(result.tools[0].inputSchema.required, ['key']);
});

test('tools/call: each tool reads its service route with the token; results as JSON text and structured content', async (t) => {
    const api = await fakeShipScope(t, {
        '/api/service/v1/items/CHG-12': { body: { key: 'CHG-12', envs: { prod: { status: 'released' } } } },
        '/api/service/v1/changes': { body: { changes: [{ key: 'CHG-12' }] } },
        '/api/service/v1/release-plan': { body: { mode: 'repo', groups: [{ key: 'CHG-12', lines: [] }, { key: 'CHG-13', lines: [] }] } },
        '/api/service/v1/flags': { body: { flags: [{ key: 'payment-retry' }, { key: 'other' }] } },
        '/api/service/v1/environments': { body: { services: [{ name: 'pay' }] } },
        '/api/service/v1/metrics': { body: { environment: 'prod', days: [] } },
    });
    const server = createServer({ env: { SHIPSCOPE_URL: `${api.url}/`, SHIPSCOPE_TOKEN: TOKEN } });

    const item = await call(server, 'get_item_status', { key: 'CHG-12' });
    assert.strictEqual(item.result.isError, undefined);
    assert.deepStrictEqual(item.result.structuredContent, { key: 'CHG-12', envs: { prod: { status: 'released' } } });
    assert.deepStrictEqual(JSON.parse(item.result.content[0].text), item.result.structuredContent);
    assert.strictEqual(item.result.content[0].type, 'text');

    assert.deepStrictEqual((await call(server, 'list_changes')).result.structuredContent, { changes: [{ key: 'CHG-12' }] });
    assert.deepStrictEqual((await call(server, 'get_release_plan', { change: 'CHG-13' })).result.structuredContent.groups.map((g) => g.key), ['CHG-13'], 'one group when asked');
    assert.deepStrictEqual((await call(server, 'get_release_plan')).result.structuredContent.groups.length, 2);
    assert.deepStrictEqual((await call(server, 'list_flags', { key: 'payment-retry' })).result.structuredContent.flags.map((f) => f.key), ['payment-retry']);
    assert.deepStrictEqual((await call(server, 'get_environments')).result.structuredContent, { services: [{ name: 'pay' }] });
    await call(server, 'get_metrics', { from: '2026-10-01', to: '2026-10-04' });
    await call(server, 'get_metrics');

    assert.deepStrictEqual(api.seen.map((s) => s.url), [
        '/api/service/v1/items/CHG-12', '/api/service/v1/changes', '/api/service/v1/release-plan', '/api/service/v1/release-plan',
        '/api/service/v1/flags', '/api/service/v1/environments', '/api/service/v1/metrics?from=2026-10-01&to=2026-10-04', '/api/service/v1/metrics',
    ]);
    assert.ok(api.seen.every((s) => s.authorization === `Bearer ${TOKEN}`));
});

test('tools/call: bad arguments and a bad setup are tool errors with a hint, sent nowhere; an unknown tool is a protocol error', async (t) => {
    const api = await fakeShipScope(t, {});
    const ok = { SHIPSCOPE_URL: api.url, SHIPSCOPE_TOKEN: TOKEN };
    const error = async (env, name, args) => {
        const res = await call(createServer({ env }), name, args);
        assert.strictEqual(res.result.isError, true, JSON.stringify([env, name, args]));
        return res.result.content[0].text;
    };
    assert.match(await error(ok, 'get_item_status', {}), /key/);
    assert.match(await error(ok, 'get_item_status', { key: '../flags' }), /PAY-12/);
    assert.match(await error(ok, 'get_item_status', { key: 'CHG-12', extra: 1 }), /extra/);
    assert.match(await error(ok, 'get_metrics', { from: '1 Oct' }), /YYYY-MM-DD/);
    assert.match(await error(ok, 'list_flags', { key: 42 }), /key/);
    assert.match(await error({ SHIPSCOPE_TOKEN: TOKEN }, 'list_changes'), /SHIPSCOPE_URL/);
    assert.match(await error({ ...ok, SHIPSCOPE_URL: 'http://shipscope.example.com' }, 'list_changes'), /https/);
    assert.match(await error({ ...ok, SHIPSCOPE_URL: 'https://me:pw@shipscope.example.com' }, 'list_changes'), /login/);
    assert.match(await error({ SHIPSCOPE_URL: api.url }, 'list_changes'), /SHIPSCOPE_TOKEN.*Service tokens/);
    assert.match(await error({ ...ok, SHIPSCOPE_TOKEN: 'abc' }, 'list_changes'), /shps_/);
    assert.deepStrictEqual(api.seen, [], 'nothing was sent');
    const unknown = await call(createServer({ env: ok }), 'delete_everything');
    assert.strictEqual(unknown.error.code, -32602);
});

test('tools/call: ShipScope\'s refusals become tool errors that never repeat the token', async (t) => {
    const api = await fakeShipScope(t, {
        '/api/service/v1/changes': { status: 401, body: { error: 'Unauthorized', message: 'Unknown service token' } },
        '/api/service/v1/flags': { status: 429, body: { error: 'Too Many Requests' }, headers: { 'retry-after': '7' } },
        '/api/service/v1/items/NOPE-1': { status: 404, body: { message: 'No item NOPE-1' } },
    });
    const server = createServer({ env: { SHIPSCOPE_URL: api.url, SHIPSCOPE_TOKEN: TOKEN } });
    const text = async (name, args) => {
        const res = await call(server, name, args);
        assert.strictEqual(res.result.isError, true);
        assert.ok(!res.result.content[0].text.includes(TOKEN));
        return res.result.content[0].text;
    };
    assert.match(await text('list_changes'), /401.*Unknown service token/);
    assert.match(await text('list_flags'), /429.*7 s/);
    assert.match(await text('get_item_status', { key: 'NOPE-1' }), /404.*No item NOPE-1/);
    const down = createServer({ env: { SHIPSCOPE_URL: 'http://127.0.0.1:1', SHIPSCOPE_TOKEN: TOKEN } });
    const res = await call(down, 'list_changes');
    assert.strictEqual(res.result.isError, true);
    assert.match(res.result.content[0].text, /cannot reach ShipScope/i);
});

test('the process speaks newline-delimited JSON-RPC on stdio and writes nothing else to stdout', async (t) => {
    const api = await fakeShipScope(t, { '/api/service/v1/environments': { body: { services: [] } } });
    const child = spawn(process.execPath, [ENTRY], { env: { PATH: process.env.PATH, SHIPSCOPE_URL: api.url, SHIPSCOPE_TOKEN: TOKEN }, stdio: ['pipe', 'pipe', 'pipe'] });
    t.after(() => child.kill());
    let out = '';
    const lines = [];
    const waitFor = (n) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out; got ${out}`)), 5000);
        const check = () => {
            if (lines.length >= n) { clearTimeout(timer); resolve(lines.slice(0, n)); }
        };
        child.stdout.on('data', (chunk) => {
            out += chunk;
            const parts = out.split('\n');
            out = parts.pop();
            lines.push(...parts.filter(Boolean).map((l) => JSON.parse(l)));
            check();
        });
        check();
    });
    const send = (m) => child.stdin.write(`${typeof m === 'string' ? m : JSON.stringify(m)}\n`);
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send('not json');
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_environments', arguments: {} } });
    const [init, parseError, env] = await waitFor(3);
    assert.strictEqual(init.result.protocolVersion, '2025-06-18');
    assert.deepStrictEqual([parseError.id, parseError.error.code], [null, -32700]);
    assert.deepStrictEqual([env.id, env.result.structuredContent], [2, { services: [] }]);
});
