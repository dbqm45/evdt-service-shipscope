// The request schemas of the flag sources ShipScope reads itself: from code (`code` on POST/PUT .../flag-sources and
// the body of .../flag-preview) and from an endpoint (`endpoint` there and on .../flag-endpoint-test). Types only;
// lib/flags-logic.js checkCodeConfig()/checkEndpointConfig() check what the fields mean.
const INGEST_SCHEMA = require('./flags-ingest.v2.schema.json');

const shortText = { type: 'string', minLength: 1, maxLength: 100 };

const CODE_CONFIG = {
    type: 'object',
    required: ['file'],
    additionalProperties: false,
    properties: {
        file: { type: 'string', minLength: 1, maxLength: 200 },
        format: { type: 'string', enum: ['json', 'yaml', 'properties', 'env', 'ts', 'js'] },
        path: shortText, valuePath: shortText, keyField: shortText, rolloutPath: shortText, prefix: shortText,
        keys: { type: 'array', minItems: 1, maxItems: 500, uniqueItems: true, items: INGEST_SCHEMA.definitions.flagKey },
        envNames: { type: 'object', additionalProperties: false, properties: { test: shortText, qa: shortText, prod: shortText } },
    },
};

const url = { type: 'string', minLength: 1, maxLength: 500 };

const ENDPOINT_CONFIG = {
    type: 'object',
    required: ['urls'],
    additionalProperties: false,
    properties: {
        urls: { type: 'object', minProperties: 1, additionalProperties: false, properties: { test: url, qa: url, prod: url } },
        format: { type: 'string', enum: ['json', 'yaml'] },
        path: shortText, valuePath: shortText, keyField: shortText, rolloutPath: shortText, prefix: shortText,
        keys: CODE_CONFIG.properties.keys,
        tokenHeader: { type: 'string', minLength: 1, maxLength: 64 },
    },
};

// The customer's read-only token: write only (never returned); null removes it, left out keeps it.
const ENDPOINT_TOKEN = { anyOf: [{ type: 'null' }, { type: 'string', minLength: 1, maxLength: 4096, pattern: '^[\\x21-\\x7e]+$' }] };

module.exports = { CODE_CONFIG, ENDPOINT_CONFIG, ENDPOINT_TOKEN };
