const crypto = require('crypto');

/**
 * Encryption at rest for third-party credentials (prd.md: "OAuth tokens ... stored encrypted"). AES-256-GCM
 * with a random 96-bit IV per value and an "associated data" string binding each ciphertext to where it belongs
 * (e.g. the tenant id): a value copied into another tenant's row fails to decrypt instead of being used there.
 *
 * Keys rotate (ADR-003 point 5). The key is TOKEN_ENCRYPTION_KEY (lib/config.js); during a rotation the old ones stay
 * readable from TOKEN_ENCRYPTION_KEY_PREVIOUS. Every function here takes either one key (a Buffer) or a key ring
 * `{ current, previous }`: values are always sealed with the current key, opened with whichever key sealed them, and
 * lib/secret-rotation.js re-seals the old ones. Format `v2.<key id>.<iv>.<tag>.<ciphertext>` (base64url parts; the
 * key id is the first 8 bytes of the key's SHA-256, never the key); the older `v1.<iv>.<tag>.<ciphertext>` carries no
 * key id and is tried with every key.
 */

class SecretBoxError extends Error {}

/** @typedef {Buffer|{ current: Buffer, previous: Buffer[] }} Keys */

/**
 * The key ring of a Buffer or a ring.
 *
 * @param {Keys} keys
 * @returns {{ current: Buffer, previous: Buffer[] }}
 */
function keyRing(keys) {
    return Buffer.isBuffer(keys) ? { current: keys, previous: [] } : { current: keys.current, previous: keys.previous || [] };
}

/**
 * The key new values are sealed with.
 *
 * @param {Keys} keys
 * @returns {Buffer}
 */
function currentKey(keys) {
    return keyRing(keys).current;
}

/**
 * A key's public id, as written into a sealed value.
 *
 * @param {Buffer} key
 * @returns {string} base64url of the first 8 bytes of its SHA-256
 */
function keyId(key) {
    return crypto.createHash('sha256').update(key).digest().subarray(0, 8).toString('base64url');
}

/**
 * @param {Keys} keys the current one seals
 * @param {string} plaintext
 * @param {string} associatedData
 * @returns {string}
 */
function seal(keys, plaintext, associatedData) {
    const key = currentKey(keys);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(associatedData, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return ['v2', keyId(key), ...[iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString('base64url'))].join('.');
}

function decrypt(key, [iv, tag, ciphertext], associatedData) {
    try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAAD(Buffer.from(associatedData, 'utf8'));
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch {
        return null;
    }
}

/**
 * @param {Keys} keys any of them may have sealed it
 * @param {string} sealed
 * @param {string} associatedData
 * @returns {string}
 * @throws {SecretBoxError} malformed, tampered with, no key of the ring, or another associated data
 */
function open(keys, sealed, associatedData) {
    const ring = keyRing(keys);
    const all = [ring.current, ...ring.previous];
    const parts = String(sealed).split('.');
    let candidates;
    let body;
    if (parts.length === 5 && parts[0] === 'v2') {
        candidates = all.filter((key) => keyId(key) === parts[1]);
        body = parts.slice(2);
    } else if (parts.length === 4 && parts[0] === 'v1') {
        candidates = all;
        body = parts.slice(1);
    } else {
        throw new SecretBoxError('Unknown secret format');
    }
    const buffers = body.map((part) => Buffer.from(part, 'base64url'));
    for (const key of candidates) {
        const plaintext = decrypt(key, buffers, associatedData);
        if (plaintext !== null) return plaintext;
    }
    throw new SecretBoxError('Secret could not be decrypted');
}

/**
 * Whether a sealed value should be sealed again with the current key (an older format or an older key).
 *
 * @param {Keys} keys
 * @param {string} sealed
 * @returns {boolean}
 */
function needsReseal(keys, sealed) {
    const parts = String(sealed).split('.');
    return !(parts.length === 5 && parts[0] === 'v2' && parts[1] === keyId(currentKey(keys)));
}

module.exports = { seal, open, needsReseal, keyRing, currentKey, keyId, SecretBoxError };
