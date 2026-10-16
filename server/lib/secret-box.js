const crypto = require('crypto');

/**
 * Encryption at rest for third-party credentials (prd.md: "OAuth tokens ... stored encrypted"). AES-256-GCM
 * with a random 96-bit IV per value and an "associated data" string binding each ciphertext to where it belongs
 * (e.g. the tenant id): a value copied into another tenant's row fails to decrypt instead of being used there.
 * The key comes from TOKEN_ENCRYPTION_KEY (lib/config.js); format `v1.<iv>.<tag>.<ciphertext>`, base64url parts,
 * so a future key rotation can add `v2`.
 */

class SecretBoxError extends Error {}

/**
 * @param {Buffer} key 32 bytes
 * @param {string} plaintext
 * @param {string} associatedData
 * @returns {string}
 */
function seal(key, plaintext, associatedData) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(associatedData, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return ['v1', iv, cipher.getAuthTag(), ciphertext].map((part) => (typeof part === 'string' ? part : part.toString('base64url'))).join('.');
}

/**
 * @param {Buffer} key 32 bytes
 * @param {string} sealed
 * @param {string} associatedData
 * @returns {string}
 * @throws {SecretBoxError} malformed, tampered with, another key, or another associated data
 */
function open(key, sealed, associatedData) {
    const parts = String(sealed).split('.');
    if (parts.length !== 4 || parts[0] !== 'v1') throw new SecretBoxError('Unknown secret format');
    const [, iv, tag, ciphertext] = parts.map((part) => Buffer.from(part, 'base64url'));
    try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAAD(Buffer.from(associatedData, 'utf8'));
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch {
        throw new SecretBoxError('Secret could not be decrypted');
    }
}

module.exports = { seal, open, SecretBoxError };
