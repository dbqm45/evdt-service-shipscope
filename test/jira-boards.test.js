const { test, afterEach } = require('node:test');
const assert = require('node:assert');

process.env.JIRA_BASE_URL = 'https://jira.example/api';

const realFetch = global.fetch;
const realWarn = console.warn;
let warns;

function load(strict) {
    for (const k of Object.keys(require.cache)) {
        if (/scripts[\\/]lib[\\/]jira-(boards|config|api)\.js$/.test(k)) {
            delete require.cache[k];
        }
    }
    process.env.JIRA_BOARD_LOOKUP_STRICT = strict ? 'true' : 'false';
    return require('../scripts/lib/jira-boards');
}

function json(body, status = 200) {
    return { ok: status < 300, status, headers: { get: () => null }, json: async () => body };
}

function route(handler) {
    global.fetch = async url => handler(url);
    warns = [];
    console.warn = m => warns.push(m);
}

afterEach(() => {
    global.fetch = realFetch;
    console.warn = realWarn;
});

test('resolveBoardId: exact case-insensitive match', async () => {
    const b = load(false);
    route(url => {
        assert.match(url, /board\?name=Sparks%20Board/);
        return json({ values: [{ id: 1, name: 'Sparks Board 2' }, { id: 2, name: 'sparks board' }] });
    });
    assert.strictEqual(await b.resolveBoardId('Sparks Board', {}), 2);
});

test('resolveBoardId: zero / ambiguous / missing values', async () => {
    const b = load(false);
    route(() => json({ values: [] }));
    assert.strictEqual(await b.resolveBoardId('X', {}), null);
    route(() => json({}));
    assert.strictEqual(await b.resolveBoardId('X', {}), null);
    route(() => json({ values: [{ id: 1, name: 'X' }, { id: 2, name: 'x' }, { id: 3 }] }));
    assert.strictEqual(await b.resolveBoardId('X', {}), null);
    assert.match(warns[0], /ambiguous/);
});

test('resolveBoardId: soft failures (non-2xx incl. 401 hint, exception)', async () => {
    const b = load(false);
    route(() => json({}, 401));
    assert.strictEqual(await b.resolveBoardId('X', {}), null);
    assert.match(warns[0], /scope issue/);
    route(() => json({}, 500));
    assert.strictEqual(await b.resolveBoardId('X', {}), null);
    assert.doesNotMatch(warns[0], /scope issue/);
    route(() => { throw new Error('net'); });
    assert.strictEqual(await b.resolveBoardId('X', {}), null);
    assert.match(warns[0], /net/);
});

test('resolveBoardId: strict mode throws JiraBoardLookupError', async () => {
    const b = load(true);
    route(() => json({}, 403));
    await assert.rejects(() => b.resolveBoardId('X', {}), e => e instanceof b.JiraBoardLookupError && e.status === 403);
    route(() => { throw new Error('net'); });
    await assert.rejects(() => b.resolveBoardId('X', {}), e => e.name === 'JiraBoardLookupError' && e.status === null);
});

test('fetchAllSprintsForBoard: paginates and normalizes dates', async () => {
    const b = load(false);
    const urls = [];
    route(url => {
        urls.push(url);
        if (url.includes('startAt=0')) {
            return json({ values: [{ id: 1, name: 'a', state: 'active', startDate: 's' }], isLast: false });
        }
        if (url.includes('startAt=50')) {
            return json({ values: [{ id: 2, name: 'b', state: 'closed', endDate: 'e' }] });
        }
        return json({ values: [] });
    });
    const out = await b.fetchAllSprintsForBoard(5, {});
    assert.deepStrictEqual(out, [
        { id: 1, name: 'a', state: 'active', startDate: 's', endDate: null },
        { id: 2, name: 'b', state: 'closed', startDate: null, endDate: 'e' },
    ]);
    assert.strictEqual(urls.length, 3);
});

test('fetchAllSprintsForBoard: isLast stops; missing values stops', async () => {
    const b = load(false);
    route(() => json({ values: [{ id: 1, name: 'a', state: 'x' }], isLast: true }));
    assert.strictEqual((await b.fetchAllSprintsForBoard(1, {})).length, 1);
    route(() => json({}));
    assert.deepStrictEqual(await b.fetchAllSprintsForBoard(1, {}), []);
});

test('fetchAllSprintsForBoard: soft failures return []', async () => {
    const b = load(false);
    route(() => json({}, 401));
    assert.deepStrictEqual(await b.fetchAllSprintsForBoard(1, {}), []);
    assert.match(warns[0], /scope issue/);
    route(() => json({}, 502));
    assert.deepStrictEqual(await b.fetchAllSprintsForBoard(1, {}), []);
    route(() => { throw new Error('dns'); });
    assert.deepStrictEqual(await b.fetchAllSprintsForBoard(1, {}), []);
    assert.match(warns[0], /dns/);
});

test('fetchAllSprintsForBoard: strict mode throws', async () => {
    const b = load(true);
    route(() => json({}, 500));
    await assert.rejects(() => b.fetchAllSprintsForBoard(1, {}), e => e.status === 500);
    route(() => { throw new Error('dns'); });
    await assert.rejects(() => b.fetchAllSprintsForBoard(1, {}), /dns/);
});

function boardRouter(sprints, boardName = 'Sparks') {
    return url => {
        if (url.includes('/board?name=')) {
            return json({ values: [{ id: 9, name: boardName }] });
        }
        return json({ values: sprints, isLast: true });
    };
}

test('resolveCurrentPiForSpaces: active sprint collects all sprints of the PI', async () => {
    const b = load(false);
    route(boardRouter([
        { id: 1, name: 'Sparks 27.3.1', state: 'closed' },
        { id: 2, name: 'Sparks 27.3.2', state: 'active' },
        { id: 3, name: 'Sparks 27.4.1', state: 'future', startDate: '2026-01-01' },
        { id: 4, name: 'Weird', state: 'closed' },
    ]));
    const out = await b.resolveCurrentPiForSpaces([
        { name: 'S', projectKey: 'SP', boards: ['Sparks'] },
        { name: 'NoBoards', projectKey: 'NB', boards: [] },
    ], {});
    assert.deepStrictEqual(out, [{ name: 'S', projectKey: 'SP', piNumbers: ['27.3'], sprintIdsByPi: { '27.3': [1, 2] } }]);
});

test('resolveCurrentPiForSpaces: unparseable active sprint name warns and contributes nothing', async () => {
    const b = load(false);
    route(boardRouter([{ id: 1, name: 'Sprint 42', state: 'active' }]));
    assert.deepStrictEqual(await b.resolveCurrentPiForSpaces([{ name: 'S', projectKey: 'SP', boards: ['Sparks'] }], {}), []);
    assert.ok(warns.some(w => /naming convention/.test(w)));
});

test('resolveCurrentPiForSpaces: no active -> nearest future sprint', async () => {
    const b = load(false);
    route(boardRouter([
        { id: 1, name: 'Sparks 27.3.3', state: 'closed', endDate: '2026-01-01' },
        { id: 2, name: 'Sparks 28.1.2', state: 'future', startDate: '2026-03-01' },
        { id: 3, name: 'Sparks 28.1.1', state: 'future', startDate: '2026-02-01' },
    ]));
    const out = await b.resolveCurrentPiForSpaces([{ name: 'S', projectKey: 'SP', boards: ['Sparks'] }], {});
    assert.deepStrictEqual(out[0].piNumbers, ['28.1']);
    assert.deepStrictEqual(out[0].sprintIdsByPi, { '28.1': [2, 3] });
    assert.ok(warns.some(w => /nearest future/.test(w)));
});

test('resolveCurrentPiForSpaces: no active/future -> most recently closed', async () => {
    const b = load(false);
    route(boardRouter([
        { id: 1, name: 'Sparks 27.2.3', state: 'closed', endDate: '2025-12-01' },
        { id: 2, name: 'Sparks 27.3.1', state: 'closed', endDate: '2026-01-01' },
    ]));
    const out = await b.resolveCurrentPiForSpaces([{ name: 'S', projectKey: 'SP', boards: ['Sparks'] }], {});
    assert.deepStrictEqual(out[0].piNumbers, ['27.3']);
    assert.ok(warns.some(w => /recently closed/.test(w)));
});

test('resolveCurrentPiForSpaces: no usable sprints at all; unresolved board skipped', async () => {
    const b = load(false);
    route(boardRouter([{ id: 1, name: 'x', state: 'future' }]));
    assert.deepStrictEqual(await b.resolveCurrentPiForSpaces([{ name: 'S', projectKey: 'SP', boards: ['Sparks'] }], {}), []);
    assert.ok(warns.some(w => /no active, future, or closed/.test(w)));

    route(() => json({ values: [] }));
    assert.deepStrictEqual(await b.resolveCurrentPiForSpaces([{ name: 'S', projectKey: 'SP', boards: ['Nope'] }], {}), []);
});

test('resolveCurrentPiForSpaces: unexpected error swallowed per board; lookup error rethrown in strict', async () => {
    let b = load(false);
    route(() => json({ values: [{ id: 1, name: 'B' }], isLast: true, }));
    // sprint payload with null entry triggers a TypeError inside the loop
    global.fetch = async url => (url.includes('/board?name=')
        ? json({ values: [{ id: 1, name: 'B' }] })
        : json({ values: [null], isLast: true }));
    assert.deepStrictEqual(await b.resolveCurrentPiForSpaces([{ name: 'S', projectKey: 'SP', boards: ['B'] }], {}), []);
    assert.ok(warns.some(w => /unexpected error/.test(w)));

    b = load(true);
    route(() => json({}, 500));
    await assert.rejects(
        () => b.resolveCurrentPiForSpaces([{ name: 'S', projectKey: 'SP', boards: ['B'] }], {}),
        e => e instanceof b.JiraBoardLookupError
    );
});
