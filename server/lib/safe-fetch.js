// Every request ShipScope makes to an address a customer gave it (ADR-003 point 5: a flags endpoint) goes through
// here, so a URL can never make the worker reach something it should not: the cloud's metadata service, the
// database, an internal admin page (SSRF). The rules:
//
// - https only, on port 443, with no user info in the URL;
// - the host name is resolved once and every address it resolves to must be public (forbiddenAddress()); the
//   connection then goes to that checked address, so a DNS answer that changes between the check and the connect
//   (DNS rebinding) cannot point it elsewhere; the certificate is still checked against the host name;
// - no redirects (a 3xx is an error: following one would mean checking a second, unvetted address);
// - a time limit for the whole request and a size limit on the body as read, after decompression (gzip, deflate,
//   br), so a small compressed answer cannot expand into gigabytes;
// - the caller's headers only, never cookies or the service's own credentials.
const dns = require('dns');
const https = require('https');
const net = require('net');
const zlib = require('zlib');

class SafeFetchError extends Error {}

const DEFAULTS = { timeoutMs: 10_000, maxBytes: 1024 * 1024, port: 443 };

// Addresses no customer endpoint may be: private, loopback, link-local (cloud metadata at 169.254.169.254), carrier
// NAT, multicast, reserved and documentation ranges, and the IPv6 forms that translate an IPv4 address. A BlockList
// judges an IPv4-mapped IPv6 address (::ffff:10.0.0.1, ::ffff:a00:1) by the IPv4 rules and an IPv4 address by an
// IPv6 rule over ::ffff:0:0/96, so that range is not listed (it would forbid every IPv4 address).
const FORBIDDEN = new net.BlockList();
for (const [address, prefix] of [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
    ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
    ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) FORBIDDEN.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [
    ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 23],
    ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
]) FORBIDDEN.addSubnet(address, prefix, 'ipv6');

/**
 * Whether an IP address is one a customer endpoint may not resolve to.
 *
 * @param {string} address
 * @returns {boolean} true also for anything that is not an IP address
 */
function forbiddenAddress(address) {
    const family = net.isIP(address);
    if (family === 4) return FORBIDDEN.check(address, 'ipv4');
    if (family === 6) return FORBIDDEN.check(address, 'ipv6');
    return true;
}

/**
 * Checks a URL a customer gave: https, port 443 (or the one allowed), no user info, a host name or a public IP.
 *
 * @param {string} raw
 * @param {{ port?: number }} [options]
 * @returns {URL}
 * @throws {SafeFetchError}
 */
function checkUrl(raw, { port = DEFAULTS.port } = {}) {
    let url;
    try {
        url = new URL(raw);
    } catch {
        throw new SafeFetchError('Not a valid URL');
    }
    if (url.protocol !== 'https:') throw new SafeFetchError('Only https:// addresses are allowed');
    if (url.username || url.password) throw new SafeFetchError('An address may not carry a user name or password; use a token');
    if ((url.port ? Number(url.port) : 443) !== port) throw new SafeFetchError(`Only port ${port} is allowed`);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host) && forbiddenAddress(host)) throw new SafeFetchError('That address is not reachable from ShipScope (a private or reserved network)');
    if (!net.isIP(host) && (!host.includes('.') || /\.(localhost|local|internal|localdomain)$/i.test(host) || host === 'localhost')) {
        throw new SafeFetchError('That host name is not reachable from ShipScope (not a public name)');
    }
    return url;
}

/** Every address a host name resolves to, all of which must be public. */
async function resolvePublic(host, lookup) {
    if (net.isIP(host)) return [{ address: host, family: net.isIP(host) }];
    let addresses;
    try {
        addresses = await new Promise((resolve, reject) => lookup(host, { all: true, verbatim: true }, (err, list) => (err ? reject(err) : resolve(list))));
    } catch {
        throw new SafeFetchError(`Could not resolve ${host}`);
    }
    if (!addresses.length) throw new SafeFetchError(`Could not resolve ${host}`);
    if (addresses.some((a) => forbiddenAddress(a.address))) {
        throw new SafeFetchError(`${host} resolves to a private or reserved address; ShipScope only calls public ones`);
    }
    return addresses;
}

/** The body as read, decompressed when the server compressed it, cut off past `maxBytes`. */
function readBody(res, maxBytes) {
    const encoding = String(res.headers['content-encoding'] || 'identity').toLowerCase().trim();
    const decoders = { gzip: zlib.createGunzip, 'x-gzip': zlib.createGunzip, deflate: zlib.createInflate, br: zlib.createBrotliDecompress };
    let stream = res;
    if (encoding !== 'identity') {
        if (!decoders[encoding]) throw new SafeFetchError(`Unsupported content encoding ${encoding}`);
        stream = res.pipe(decoders[encoding]());
    }
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        stream.on('data', (chunk) => {
            size += chunk.length;
            if (size > maxBytes) {
                res.destroy();
                stream.destroy();
                reject(new SafeFetchError(`The answer is larger than ${Math.round(maxBytes / 1024)} KB`));
                return;
            }
            chunks.push(chunk);
        });
        stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        stream.on('error', () => reject(new SafeFetchError('The answer could not be read (broken compression or connection)')));
    });
}

/**
 * A GET of a customer's https address under the rules above.
 *
 * @param {string} rawUrl
 * @param {{ headers?: Record<string, string>, timeoutMs?: number, maxBytes?: number, port?: number, lookup?: Function, request?: Function, ca?: string }} [options]
 *   `lookup`, `request`, `port` and `ca` exist for tests (a local server); production passes none of them
 * @returns {Promise<{ status: number, headers: object, contentType: string, body: string, address: string }>}
 * @throws {SafeFetchError} with a message fit to show the admin (no response body in it)
 */
async function safeFetch(rawUrl, { headers = {}, timeoutMs = DEFAULTS.timeoutMs, maxBytes = DEFAULTS.maxBytes, port = DEFAULTS.port, lookup = dns.lookup, request = https.request, ca } = {}) {
    const url = checkUrl(rawUrl, { port });
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const deadline = Date.now() + timeoutMs;
    const addresses = await resolvePublic(host, lookup);
    const pinned = addresses[0];
    const remaining = () => Math.max(1, deadline - Date.now());
    return new Promise((resolve, reject) => {
        let settled = false;
        const fail = (err) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            req.destroy();
            reject(err instanceof SafeFetchError ? err : new SafeFetchError(`Could not reach ${host} (${err.code || 'connection failed'})`));
        };
        const req = request({
            method: 'GET',
            host,
            servername: net.isIP(host) ? undefined : host,
            port,
            path: `${url.pathname}${url.search}`,
            headers: { accept: 'application/json, application/yaml, text/plain;q=0.8', 'accept-encoding': 'gzip, deflate, br', 'user-agent': 'ShipScope', ...headers },
            // The connection goes to the address checked above, never to what a second lookup might answer.
            lookup: (hostname, opts, cb) => (opts && opts.all ? cb(null, [pinned]) : cb(null, pinned.address, pinned.family)),
            agent: false,
            ca,
        }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400) {
                res.resume();
                fail(new SafeFetchError(`${host} answered with a redirect (HTTP ${res.statusCode}); give the final address instead`));
                return;
            }
            readBody(res, maxBytes).then((body) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve({ status: res.statusCode, headers: res.headers, contentType: String(res.headers['content-type'] || ''), body, address: pinned.address });
            }, fail);
        });
        const timer = setTimeout(() => fail(new SafeFetchError(`${host} did not answer within ${Math.round(timeoutMs / 1000)} s`)), remaining());
        req.on('error', fail);
        req.end();
    });
}

module.exports = { SafeFetchError, forbiddenAddress, checkUrl, safeFetch, DEFAULTS };
