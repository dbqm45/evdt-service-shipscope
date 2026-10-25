const crypto = require('crypto');

/**
 * Secrets the Web Service may store but never read back (ADR-003 point 5, ROADMAP "Bezpieczeństwo"): a customer's
 * endpoint token is sealed with a public key (SECRETS_PUBLIC_KEY, on both services) and opened only with the matching
 * private key (SECRETS_PRIVATE_KEY, on the worker alone). A leak of the web service's environment then exposes no
 * stored token.
 *
 * X25519 + HKDF-SHA256 + AES-256-GCM (an ECIES "sealed box"): each value gets a fresh ephemeral key pair, the shared
 * secret of the ephemeral private key and the recipient's public key derives the AES key, and the associated data binds
 * the value to its place as in lib/secret-box.js. Format `p1.<key id>.<ephemeral public key>.<iv>.<tag>.<ciphertext>`
 * (base64url parts; the key id is the first 8 bytes of the SHA-256 of the public key, never a key). A rotation adds the
 * old private keys in SECRETS_PRIVATE_KEY_PREVIOUS; lib/secret-rotation.js seals the old values again.
 */

class SealedBoxError extends Error {}

const PREFIX = 'p1';

/** The raw 32 bytes of an X25519 public key. */
function rawPublic(publicKey) {
    return publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
}

/**
 * A public key's id, as written into a sealed value.
 *
 * @param {crypto.KeyObject} publicKey
 * @returns {string}
 */
function sealingKeyId(publicKey) {
    return crypto.createHash('sha256').update(rawPublic(publicKey)).digest().subarray(0, 8).toString('base64url');
}

function aesKey(sharedSecret, ephemeralRaw, recipientRaw) {
    return Buffer.from(crypto.hkdfSync('sha256', sharedSecret, Buffer.concat([ephemeralRaw, recipientRaw]), 'shipscope sealed-box p1', 32));
}

/**
 * Seals a value so only the holder of the private key can open it.
 *
 * @param {crypto.KeyObject} publicKey X25519
 * @param {string} plaintext
 * @param {string} associatedData
 * @returns {string}
 */
function sealFor(publicKey, plaintext, associatedData) {
    const ephemeral = crypto.generateKeyPairSync('x25519');
    const ephemeralRaw = rawPublic(ephemeral.publicKey);
    const key = aesKey(crypto.diffieHellman({ privateKey: ephemeral.privateKey, publicKey }), ephemeralRaw, rawPublic(publicKey));
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(associatedData, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return [PREFIX, sealingKeyId(publicKey), ...[ephemeralRaw, iv, cipher.getAuthTag(), ciphertext].map((p) => p.toString('base64url'))].join('.');
}

/**
 * Whether a stored value is sealed for a public key (this format) rather than with the symmetric secret box.
 *
 * @param {string} sealed
 * @returns {boolean}
 */
function isSealedFor(sealed) {
    return String(sealed).startsWith(`${PREFIX}.`);
}

/**
 * Opens a value sealed for one of the private keys' public keys.
 *
 * @param {crypto.KeyObject[]} privateKeys the current one first, then previous ones
 * @param {string} sealed
 * @param {string} associatedData
 * @returns {string}
 * @throws {SealedBoxError} malformed, tampered with, no matching key, or another associated data
 */
function openWith(privateKeys, sealed, associatedData) {
    const parts = String(sealed).split('.');
    if (parts.length !== 6 || parts[0] !== PREFIX) throw new SealedBoxError('Unknown sealed format');
    const [, kid, ...rest] = parts;
    const [ephemeralRaw, iv, tag, ciphertext] = rest.map((p) => Buffer.from(p, 'base64url'));
    const privateKey = privateKeys.find((k) => sealingKeyId(crypto.createPublicKey(k)) === kid);
    if (!privateKey) throw new SealedBoxError('No private key for this value');
    try {
        const ephemeralPublic = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), ephemeralRaw]), format: 'der', type: 'spki' });
        const key = aesKey(crypto.diffieHellman({ privateKey, publicKey: ephemeralPublic }), ephemeralRaw, rawPublic(crypto.createPublicKey(privateKey)));
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAAD(Buffer.from(associatedData, 'utf8'));
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch {
        throw new SealedBoxError('Sealed value could not be opened');
    }
}

/**
 * A new key pair, as the two environment values (base64 DER: SPKI for the public key, PKCS#8 for the private one).
 *
 * @returns {{ publicKey: string, privateKey: string }}
 */
function generateSealingKeys() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
    return {
        publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
        privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    };
}

module.exports = { sealFor, openWith, isSealedFor, sealingKeyId, generateSealingKeys, SealedBoxError };
