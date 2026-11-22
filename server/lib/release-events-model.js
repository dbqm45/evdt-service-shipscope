// Outgoing release events, the pure rules (G1.5 of the pdi G1/G2 plan; contract 0.14.0 event.schema.json). From the
// Release plan tab's model (releasePlanModel() in docs/app-model.js, run on the server by lib/release-status.js) and
// what was seen last time (event_state, migration 039):
// - release.stage_changed: a flag of a repo plan is in another rollout stage on PROD than last time;
// - feature.released (with `release`): every item of a line is with users on PROD, and was not last time.
// The first look at a change only records it, so a new subscription is not flooded with history. The I/O is
// lib/outgoing-events.js.
const crypto = require('crypto');
const { validate } = require('./json-schema-lite');
const EVENT_SCHEMA = require('../schemas/event.v0.14.0.schema.json');

const CONTRACT_VERSION = '0.14.0';
const EVENT_TYPES = ['release.stage_changed', 'feature.released'];
const CHANGE_KEY = /^[A-Z][A-Z0-9]+-[0-9]+$/;

/** Nothing seen yet. */
function emptyEventState() {
    return { seen: new Set(), released: new Set(), stage: new Map() };
}

/** "2026-11-10T09:00:00Z": the contract's time format, without milliseconds. */
const isoSeconds = (date) => date.toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * One event in the contract's envelope.
 *
 * @param {'release.stage_changed'|'feature.released'} type
 * @param {object} payload
 * @param {Date} now
 * @returns {{ id: string, type: string, occurred_at: string, source: 'shipscope', contract_version: string, payload: object }}
 */
function eventEnvelope(type, payload, now) {
    return { id: crypto.randomUUID(), type, occurred_at: isoSeconds(now), source: 'shipscope', contract_version: CONTRACT_VERSION, payload };
}

/**
 * What breaks the pinned contract schema in an event: the envelope's fields and its type's payload definition.
 *
 * @param {object} event
 * @returns {string[]} empty when valid
 */
function checkEvent(event) {
    const { allOf, $defs, ...envelope } = EVENT_SCHEMA;
    const errors = validate(envelope, event);
    const def = $defs[String(event && event.type).replace('.', '_')];
    if (def && event && event.payload) errors.push(...validate(def, event.payload).map((e) => `payload.${e}`));
    return errors;
}

/**
 * The events since `previous`, and the state to keep.
 *
 * @param {{ groups: Array<{ key: string, lines: Array<{ id: string, released: boolean, items: Array<{ key: string }> }>, flags: Array<{ key: string, hasPlan: boolean, stage: string|null, percent: number|null, release?: string|null }> }>, previous: ReturnType<typeof emptyEventState>, now: Date }} input
 * @returns {{ events: object[], state: ReturnType<typeof emptyEventState> }}
 */
function planReleaseEvents({ groups, previous, now }) {
    const state = { seen: new Set(previous.seen), released: new Set(previous.released), stage: new Map(previous.stage) };
    const events = [];
    for (const g of groups.filter((x) => CHANGE_KEY.test(x.key || ''))) {
        const known = previous.seen.has(g.key);
        state.seen.add(g.key);
        // Flags first: a flag reaching its last stage is what releases a line.
        for (const f of g.flags.filter((x) => x.hasPlan)) {
            const subject = `${g.key}/${f.key}`;
            const stage = f.stage || '';
            const before = previous.stage.get(subject);
            if (known && before !== undefined && stage !== before && stage) {
                const payload = { change: g.key, ...(f.release ? { release: f.release } : {}), flag: f.key, ...(before ? { from_stage: before } : {}), to_stage: stage };
                if (typeof f.percent === 'number') payload.rollout = f.percent;
                events.push(eventEnvelope('release.stage_changed', payload, now));
            }
            state.stage.set(subject, stage);
        }
        for (const line of g.lines) {
            const subject = `${g.key}/${line.id}`;
            if (line.released && !previous.released.has(subject)) {
                if (known) {
                    events.push(eventEnvelope('feature.released', {
                        change: g.key, release: line.id, tasks: line.items.map((i) => i.key), released_at: isoSeconds(now), environment: 'prod',
                    }, now));
                }
                state.released.add(subject);
            } else if (!line.released) {
                state.released.delete(subject);
            }
        }
    }
    return { events, state };
}

module.exports = { CONTRACT_VERSION, EVENT_TYPES, emptyEventState, eventEnvelope, checkEvent, planReleaseEvents };
