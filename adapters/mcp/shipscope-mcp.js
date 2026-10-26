#!/usr/bin/env node
// The ShipScope MCP server for Claude (K-1): newline-delimited JSON-RPC 2.0 on stdin/stdout, answered one message at a
// time in order (lib.js). stdout carries only protocol messages; anything else goes to stderr.
//
//   SHIPSCOPE_URL=https://shipscope.example.com SHIPSCOPE_TOKEN=shps_… node adapters/mcp/shipscope-mcp.js
//
// Setup in Claude Code and Claude Desktop: adapters/mcp/README.md.
const readline = require('readline');
const { createServer } = require('./lib');

const server = createServer({ env: process.env });
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let queue = Promise.resolve();

lines.on('line', (line) => {
    if (!line.trim()) return;
    queue = queue.then(async () => {
        let message;
        try {
            message = JSON.parse(line);
        } catch {
            process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`);
            return;
        }
        const answer = await server.handle(message);
        if (answer) process.stdout.write(`${JSON.stringify(answer)}\n`);
    }).catch((err) => process.stderr.write(`shipscope-mcp: ${err.message}\n`));
});
lines.on('close', () => queue.then(() => process.exit(0)));
