// The request schema of a flag source read from code (`code` on POST/PUT .../flag-sources and the body of
// .../flag-preview). Types only; lib/flags-logic.js checkCodeConfig() checks what the fields mean.
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

module.exports = { CODE_CONFIG };
