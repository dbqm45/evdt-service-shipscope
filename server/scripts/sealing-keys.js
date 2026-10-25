// Prints a new key pair for sealing customers' endpoint tokens for the worker (lib/sealed-box.js): put
// SECRETS_PUBLIC_KEY on both services and SECRETS_PRIVATE_KEY on the worker only (server/README.md, "Endpoint tokens
// only the worker can read").
const { generateSealingKeys } = require('../lib/sealed-box');

const { publicKey, privateKey } = generateSealingKeys();
process.stdout.write(`SECRETS_PUBLIC_KEY=${publicKey}\nSECRETS_PRIVATE_KEY=${privateKey}\n`);
