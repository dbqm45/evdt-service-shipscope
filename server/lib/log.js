// Structured logs for both services: one JSON object per line on stdout, which Render keeps and searches. Every
// line has `time`, `level`, `service` and `msg`; context goes in fields (`tenantId`, `repo`, `requestId`,
// `durationMs`, `err`), so a problem can be followed by tenant or request. The web service gets the same shape from
// Fastify's own logger (pino), configured by loggerOptions() below.
//
// Secrets never reach a log line: a field whose name looks like a credential is replaced, and anything that looks
// like an ingest token, a bearer token or a GitHub/Atlassian token inside a message is masked (redact()).

const LEVELS = { debug: 20, info: 30, warn: 40, error: 50 };
const SECRET_FIELD = /(token|secret|password|authorization|cookie|private.?key|refresh|^code$|^state$)/i;
const SECRET_TEXT = [
    /shpi_[A-Za-z0-9_-]{10,}/g, // ingest tokens
    /\b(gh[pousr]_[A-Za-z0-9]{20,})/g, // GitHub tokens
    /(Bearer)\s+[A-Za-z0-9._~+/=-]{12,}/gi,
    /([?&](code|state|token|access_token|refresh_token)=)[^&\s"]+/gi,
];

/** LOG_LEVEL: debug, info (default), warn or error. */
function logLevel(env) {
    const value = (env.LOG_LEVEL || 'info').toLowerCase();
    if (!LEVELS[value]) throw new Error('LOG_LEVEL must be debug, info, warn or error');
    return value;
}

/**
 * Masks anything credential-like in a string (see SECRET_TEXT).
 *
 * @param {string} text
 * @returns {string}
 */
function redact(text) {
    let out = String(text);
    out = out.replace(SECRET_TEXT[0], 'shpi_[redacted]').replace(SECRET_TEXT[1], '[redacted]');
    out = out.replace(SECRET_TEXT[2], '$1 [redacted]').replace(SECRET_TEXT[3], '$1[redacted]');
    return out;
}

/** An error as fields: what happened and where, never the request or response objects it may hold. */
function serializeError(err) {
    if (!(err instanceof Error)) return { message: redact(String(err)) };
    const out = { type: err.constructor.name, message: redact(err.message) };
    if (err.code) out.code = String(err.code);
    if (err.status) out.status = err.status;
    if (err.stack) out.stack = redact(err.stack);
    return out;
}

function cleanFields(fields, depth = 0) {
    const out = {};
    for (const [key, value] of Object.entries(fields || {})) {
        if (value === undefined) continue;
        if (SECRET_FIELD.test(key)) out[key] = '[redacted]';
        else if (value instanceof Error) out[key] = serializeError(value);
        else if (value instanceof Date) out[key] = value.toISOString();
        else if (typeof value === 'string') out[key] = redact(value);
        else if (value && typeof value === 'object' && !Array.isArray(value) && depth < 3) out[key] = cleanFields(value, depth + 1);
        else out[key] = value;
    }
    return out;
}

/**
 * A logger writing JSON lines. `child(fields)` returns one that adds those fields to every line.
 *
 * @param {{ service: string, level?: string, write?: (line: string) => void, now?: () => Date, base?: object }} options
 * @returns {{ debug: Function, info: Function, warn: Function, error: Function, child: (fields: object) => object, level: string }}
 *   each method takes `(msg, fields?)`
 */
function createLogger({ service, level = 'info', write = (line) => process.stdout.write(`${line}\n`), now = () => new Date(), base = {} }) {
    const threshold = LEVELS[level];
    const emit = (lvl) => (msg, fields = {}) => {
        if (LEVELS[lvl] < threshold) return;
        const line = { time: now().toISOString(), level: lvl, service, msg: redact(msg), ...cleanFields(base), ...cleanFields(fields) };
        try {
            write(JSON.stringify(line));
        } catch {
            // A log line that can't be serialized must never take the service down.
        }
    };
    return {
        level,
        debug: emit('debug'),
        info: emit('info'),
        warn: emit('warn'),
        error: emit('error'),
        child: (fields) => createLogger({ service, level, write, now, base: { ...base, ...fields } }),
    };
}

/**
 * Fastify's logger options for the web service: the same level, `service`/`version` on every line, credential
 * fields and URLs masked, the request id on every line of a request.
 *
 * @param {{ level: string, version: string }} input
 * @returns {object}
 */
function loggerOptions({ level, version }) {
    return {
        level,
        base: { service: 'web', version },
        messageKey: 'msg',
        timestamp: () => `,"time":"${new Date().toISOString()}"`,
        formatters: { level: (label) => ({ level: label }) },
        redact: { paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'], censor: '[redacted]' },
    };
}

/**
 * Logs what would otherwise kill a process silently (an unhandled rejection, an uncaught exception) before it goes.
 *
 * @param {ReturnType<typeof createLogger>} logger
 * @param {NodeJS.Process} [proc]
 */
function logProcessFailures(logger, proc = process) {
    proc.on('unhandledRejection', (err) => logger.error('unhandled promise rejection', { err }));
    proc.on('uncaughtException', (err) => {
        logger.error('uncaught exception, exiting', { err });
        proc.exit(1);
    });
}

module.exports = { LEVELS, logLevel, redact, serializeError, createLogger, loggerOptions, logProcessFailures };
