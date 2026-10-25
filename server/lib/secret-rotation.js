// Rotating TOKEN_ENCRYPTION_KEY and the worker's sealing key pair (ADR-003 point 5, server/README.md): with the new key in TOKEN_ENCRYPTION_KEY and the
// old one in TOKEN_ENCRYPTION_KEY_PREVIOUS, every stored secret stays readable, and this pass (the worker's `secrets`
// job, at start and daily) seals each one sealed with an older key or format again with the current key. Once a pass
// reports nothing left (`stale: 0`), the old key can be removed.
//
// It also stores the signing secret of every workspace that reads an endpoint (lib/endpoint-flags.js), so a secret
// still derived from the key is fixed before the key changes.
//
// Tenant by tenant, under the tenant's scope; a Jira refresh token under the same row lock as its use, since Atlassian
// rotates it. A value no key opens is counted (`unreadable`) and left as it is.
const { withScope } = require('./scope');
const { open, seal, needsReseal, SecretBoxError } = require('./secret-box');
const { sealFor, openWith, isSealedFor, sealingKeyId, SealedBoxError } = require('./sealed-box');
const { endpointTokenAad } = require('./flags');
const { tenantSigningSecret, signingSecretAad } = require('./endpoint-flags');

/** Seals one value again with the current key; true when it changed, null when no key opens it. */
function reseal(keys, sealed, aad) {
    if (!needsReseal(keys, sealed)) return false;
    try {
        return seal(keys, open(keys, sealed, aad), aad);
    } catch (err) {
        if (err instanceof SecretBoxError) return null;
        throw err;
    }
}

/**
 * Seals an endpoint token again for where it belongs now: for the worker's current public key when a sealing key pair is
 * configured (moving tokens sealed with TOKEN_ENCRYPTION_KEY there too), else with the current symmetric key.
 */
function resealEndpointToken(keys, sealingKeys, sealed, aad) {
    if (!sealingKeys || !sealingKeys.publicKey) return isSealedFor(sealed) ? false : reseal(keys, sealed, aad);
    if (isSealedFor(sealed) && sealed.split('.')[1] === sealingKeyId(sealingKeys.publicKey)) return false;
    try {
        const plaintext = isSealedFor(sealed) ? openWith(sealingKeys.privateKeys, sealed, aad) : open(keys, sealed, aad);
        return sealFor(sealingKeys.publicKey, plaintext, aad);
    } catch (err) {
        if (err instanceof SecretBoxError || err instanceof SealedBoxError) return null;
        throw err;
    }
}

/**
 * Seals every stored secret of every tenant with the current key.
 *
 * @param {{ pool: import('pg').Pool, encryptionKey: Buffer|{ current: Buffer, previous: Buffer[] }, sealingKeys?: { publicKey: object, privateKeys: object[] }|null, log?: Function }} input
 *   `sealingKeys`: the worker's key pair; endpoint tokens are moved to it (lib/sealed-box.js)
 * @returns {Promise<{ tenants: number, resealed: number, unreadable: number, stale: number }>} `stale`: values still
 *   sealed with an older key after the pass (the unreadable ones)
 */
async function resealSecrets({ pool, encryptionKey, sealingKeys = null, log = () => {} }) {
    const { rows: tenants } = await pool.query('SELECT id FROM tenants ORDER BY created_at');
    const totals = { tenants: tenants.length, resealed: 0, unreadable: 0, stale: 0 };
    const count = (tenantId, what, result) => {
        if (result === null) {
            totals.unreadable += 1;
            totals.stale += 1;
            log(`a stored ${what} cannot be opened with any key`, { level: 'warn', tenantId, what });
        } else if (result) {
            totals.resealed += 1;
        }
    };
    for (const { id: tenantId } of tenants) {
        await withScope(pool, { tenantId }, async (client) => {
            const { rows: [jira] } = await client.query('SELECT refresh_token_enc FROM jira_connections WHERE tenant_id = $1 FOR UPDATE', [tenantId]);
            if (jira) {
                const next = reseal(encryptionKey, jira.refresh_token_enc, tenantId);
                if (next) await client.query('UPDATE jira_connections SET refresh_token_enc = $2 WHERE tenant_id = $1', [tenantId, next]);
                count(tenantId, 'Jira token', next);
            }
            const { rows: sources } = await client.query(
                "SELECT id, endpoint_token_enc FROM flag_sources WHERE tenant_id = $1 AND origin = 'endpoint' FOR UPDATE",
                [tenantId]
            );
            for (const source of sources.filter((s) => s.endpoint_token_enc)) {
                const next = resealEndpointToken(encryptionKey, sealingKeys, source.endpoint_token_enc, endpointTokenAad(tenantId, source.id));
                if (next) await client.query('UPDATE flag_sources SET endpoint_token_enc = $3 WHERE tenant_id = $1 AND id = $2', [tenantId, source.id, next]);
                count(tenantId, 'endpoint token', next);
            }
            const { rows: [tenant] } = await client.query('SELECT endpoint_signing_secret_enc FROM tenants WHERE id = $1 FOR UPDATE', [tenantId]);
            if (tenant && tenant.endpoint_signing_secret_enc) {
                const next = reseal(encryptionKey, tenant.endpoint_signing_secret_enc, signingSecretAad(tenantId));
                if (next) await client.query('UPDATE tenants SET endpoint_signing_secret_enc = $2 WHERE id = $1', [tenantId, next]);
                count(tenantId, 'signing secret', next);
            } else if (tenant && sources.length) {
                // Stored now, while it still derives from the key the customer's endpoint was set up with.
                await tenantSigningSecret(client, { tenantId, encryptionKey });
            }
        });
    }
    return totals;
}

module.exports = { resealSecrets };
