// A workspace connected with pdi, for tests of the pdi layer (design-docs/PDI-GATE-PLAN.pl.md): `proven` gives a
// connected one (a token pdi has used and a ping that reached it), so people see the layer; without it the connection
// is pending, enough for the service API and the outgoing events.
const crypto = require('crypto');
const { withScope } = require('../../lib/scope');

/**
 * @param {import('pg').Pool} pool
 * @param {string} tenantId
 * @param {{ proven?: boolean }} [options]
 * @returns {Promise<void>}
 */
async function connectPdiForTest(pool, tenantId, { proven = true } = {}) {
    await withScope(pool, { tenantId }, async (client) => {
        let tokenId = null;
        if (proven) {
            const { rows: [token] } = await client.query(
                "INSERT INTO service_tokens (tenant_id, name, token_hash, last_used_at) VALUES ($1, 'pdi (test)', $2, now()) RETURNING id",
                [tenantId, crypto.randomBytes(16).toString('hex')]
            );
            tokenId = token.id;
        }
        await client.query(
            "INSERT INTO pdi_connections (tenant_id, receiver_url, service_token_id, last_ping_ok_at) VALUES ($1, 'https://pdi.example.com', $2, $3)",
            [tenantId, tokenId, proven ? new Date() : null]
        );
    });
}

module.exports = { connectPdiForTest };
