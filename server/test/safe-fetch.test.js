// The outbound requests to customers' addresses (lib/safe-fetch.js, ADR-003 point 5): which addresses are refused,
// which URLs, and what a real TLS connection to a local server does with redirects, sizes, compression and time.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const { forbiddenAddress, checkUrl, safeFetch, SafeFetchError } = require('../lib/safe-fetch');

test('forbiddenAddress: private, loopback, link-local, carrier NAT, reserved, multicast and their IPv6 forms', () => {
    for (const address of [
        '0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.0.0.1', '192.0.2.1',
        '192.168.1.1', '198.18.0.1', '198.51.100.7', '203.0.113.9', '224.0.0.1', '240.0.0.1', '255.255.255.255',
        '::', '::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:a9fe:a9fe', '0:0:0:0:0:ffff:192.168.0.1', '64:ff9b::a00:1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1', '2001:db8::1', '2002:a00:1::',
        'not-an-ip', '',
    ]) assert.strictEqual(forbiddenAddress(address), true, address);
    for (const address of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '100.128.0.1', '2606:4700:4700::1111', '::ffff:93.184.216.34']) {
        assert.strictEqual(forbiddenAddress(address), false, address);
    }
});

test('checkUrl: https on 443, no user info, a public name or address', () => {
    assert.strictEqual(checkUrl('https://flags.acme.io/api/flags?env=prod').hostname, 'flags.acme.io');
    assert.strictEqual(checkUrl('https://flags.acme.io:443/x').port, '');
    for (const [url, why] of [
        ['http://flags.acme.io/x', /Only https/],
        ['https://flags.acme.io:8443/x', /Only port 443/],
        ['https://user:pw@flags.acme.io/x', /user name or password/],
        ['https://169.254.169.254/latest/meta-data', /private or reserved/],
        ['https://[::1]/x', /private or reserved/],
        ['https://localhost/x', /not a public name/],
        ['https://intranet/x', /not a public name/],
        ['https://db.internal/x', /not a public name/],
        ['file:///etc/passwd', /Only https/],
        ['not a url', /Not a valid URL/],
    ]) assert.throws(() => checkUrl(url), (err) => err instanceof SafeFetchError && why.test(err.message), url);
});

test('a name that resolves to any private address is refused before connecting', async () => {
    const lookup = (answers) => (host, opts, cb) => cb(null, answers);
    let connected = false;
    const request = () => { connected = true; throw new Error('must not connect'); };
    await assert.rejects(safeFetch('https://rebind.example.com/x', { lookup: lookup([{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }]), request }),
        /resolves to a private or reserved address/);
    await assert.rejects(safeFetch('https://meta.example.com/x', { lookup: lookup([{ address: '::ffff:169.254.169.254', family: 6 }]), request }), /private or reserved/);
    await assert.rejects(safeFetch('https://none.example.com/x', { lookup: (h, o, cb) => cb(Object.assign(new Error('x'), { code: 'ENOTFOUND' })), request }), /Could not resolve/);
    assert.strictEqual(connected, false);
});

// A local TLS server for flags.example.com, reached through a lookup that names a public address; the test's
// request wrapper then connects that pinned address to 127.0.0.1, so what ShipScope pinned is visible.
const DIR = path.join(os.tmpdir(), `shipscope-safe-fetch-${process.pid}`);
let server;
let port;
let ca;
const routes = {};
before(async () => {
    fs.mkdirSync(DIR, { recursive: true });
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=flags.example.com',
        '-addext', 'subjectAltName=DNS:flags.example.com', '-keyout', path.join(DIR, 'key.pem'), '-out', path.join(DIR, 'cert.pem')], { stdio: 'ignore' });
    ca = fs.readFileSync(path.join(DIR, 'cert.pem'), 'utf8');
    server = https.createServer({ key: fs.readFileSync(path.join(DIR, 'key.pem')), cert: ca }, (req, res) => (routes[req.url] || ((q, r) => { r.statusCode = 404; r.end(); }))(req, res));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
});
after(() => {
    server && server.close();
    fs.rmSync(DIR, { recursive: true, force: true });
});

function local() {
    const pinnedTo = [];
    const lookup = (host, opts, cb) => cb(null, [{ address: '93.184.216.34', family: 4 }]);
    const request = (opts, cb) => {
        opts.lookup('flags.example.com', {}, (err, address) => pinnedTo.push(address));
        return https.request({ ...opts, lookup: (h, o, c) => (o && o.all ? c(null, [{ address: '127.0.0.1', family: 4 }]) : c(null, '127.0.0.1', 4)) }, cb);
    };
    const get = (urlPath, extra = {}) => safeFetch(`https://flags.example.com:${port}${urlPath}`, { lookup, request, port, ca, ...extra });
    return { get, pinnedTo };
}

test('a real TLS request: the answer, the pinned checked address, the caller\'s headers', async () => {
    routes['/flags'] = (req, res) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ auth: req.headers.authorization, ua: req.headers['user-agent'], cookie: req.headers.cookie || null }));
    };
    const { get, pinnedTo } = local();
    const res = await get('/flags', { headers: { authorization: 'Bearer t' } });
    assert.deepStrictEqual([res.status, res.contentType, res.address, JSON.parse(res.body)], [200, 'application/json', '93.184.216.34', { auth: 'Bearer t', ua: 'ShipScope', cookie: null }]);
    assert.deepStrictEqual(pinnedTo, ['93.184.216.34'], 'the connection goes to the address that was checked');
});

test('no redirects; limits on size after decompression and on time; the certificate is checked', async () => {
    routes['/moved'] = (req, res) => { res.statusCode = 302; res.setHeader('location', 'https://169.254.169.254/'); res.end(); };
    routes['/big'] = (req, res) => res.end('x'.repeat(2000));
    routes['/bomb'] = (req, res) => { res.setHeader('content-encoding', 'gzip'); res.end(zlib.gzipSync(Buffer.alloc(5 * 1024 * 1024))); };
    routes['/gzip'] = (req, res) => { res.setHeader('content-encoding', 'gzip'); res.end(zlib.gzipSync('{"a":true}')); };
    routes['/slow'] = () => {};
    const { get } = local();
    await assert.rejects(get('/moved'), /answered with a redirect \(HTTP 302\)/);
    await assert.rejects(get('/big', { maxBytes: 1000 }), /larger than 1 KB/);
    await assert.rejects(get('/bomb', { maxBytes: 64 * 1024 }), /larger than 64 KB/, 'a small gzip that expands is cut off');
    assert.strictEqual((await get('/gzip')).body, '{"a":true}');
    await assert.rejects(get('/slow', { timeoutMs: 300 }), /did not answer within/);
    await assert.rejects(get('/flags', { ca: undefined }), /Could not reach flags.example.com/, 'a certificate nobody vouches for');
});

test('POST (outgoing events): the method, a JSON body with its length, the caller\'s headers; the same address rules', async () => {
    routes['/events'] = (req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => res.end(JSON.stringify({ method: req.method, type: req.headers['content-type'], length: req.headers['content-length'], sig: req.headers['x-shipscope-signature'], body })));
    };
    const { get } = local();
    const res = await get('/events', { method: 'POST', body: '{"type":"feature.released"}', headers: { 'content-type': 'application/json', 'x-shipscope-signature': 'v1=abc' } });
    assert.deepStrictEqual(JSON.parse(res.body), { method: 'POST', type: 'application/json', length: '27', sig: 'v1=abc', body: '{"type":"feature.released"}' });
    await assert.rejects(safeFetch('https://10.0.0.1/events', { method: 'POST', body: '{}' }), /private or reserved/);
    await assert.rejects(get('/events', { method: 'DELETE' }), /GET or POST/);
});
