const http = require('http');
const { createPool, checkConnection } = require('./lib/db');

/** Walking-skeleton Web Service: liveness only, plus a DB-connectivity check. No PRD features yet. */
function createServer(pool) {
    return http.createServer(async (req, res) => {
        if (req.method === 'GET' && req.url === '/health') {
            res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'ok' }));
            return;
        }

        if (req.method === 'GET' && req.url === '/health/db') {
            try {
                const result = await checkConnection(pool);
                res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
            } catch (err) {
                res.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: err.message }));
            }
            return;
        }

        res.writeHead(404).end();
    });
}

if (require.main === module) {
    const pool = createPool();
    const server = createServer(pool);
    const port = process.env.PORT || 3000;
    server.listen(port, () => console.log(`shipscope-web listening on ${port}`));

    process.on('SIGTERM', () => {
        server.close(() => pool.end(() => process.exit(0)));
    });
}

module.exports = { createServer };
