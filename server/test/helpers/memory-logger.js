const { createLogger } = require('../../lib/log');

/** A logger (lib/log.js) whose lines are kept, parsed, in `lines`, for asserting on what was logged. */
function memoryLogger({ service = 'test', level = 'debug' } = {}) {
    const lines = [];
    const logger = createLogger({ service, level, write: (line) => lines.push(JSON.parse(line)) });
    return { logger, lines };
}

module.exports = { memoryLogger };
