const assert = require('node:assert');

const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

/**
 * Fake Atlassian (auth.atlassian.com + api.atlassian.com).
 * - `codes`: authorization code -> the sites its grant covers ([{ id, url, name, scopes }]).
 * - Refresh tokens rotate: each refresh invalidates the token used and issues a new one.
 * - `jira`: cloudId -> { boards: [{ id, name, type, location }], sprints: { [boardId]: [...] } (a board missing here answers 400, as one without sprints does), fields: [...], issues: [raw] },
 *   served by the Agile board/sprint lists, /rest/api/3/field and /rest/api/3/search/jql (JQL: `sprint in (ids)` or
 *   `key in (keys)`, sprint ids matched against the `customfield_10020` entries; a release `project = "K" AND
 *   fixVersion = id` against `fields.fixVersions`; a flow month by `fields.resolutiondate` and the status category).
 *   `versions`: projectKey -> raw versions, served by /rest/api/3/project/{key}/version. `pageSize` makes every list page short.
 * - Dynamic webhooks (/rest/api/3/webhook): registering returns new ids (a jqlFilter containing BAD is refused),
 *   refresh returns `webhookExpiry`, delete answers 202; each such call is kept in `webhookCalls`.
 * - `scope`: what a token response says was granted.
 * - `fail`: path substring -> HTTP status to answer with.
 */
function fakeAtlassian({ codes = {}, offline = true, jira = {}, pageSize = 50, fail = {}, scope = 'read:jira-work offline_access', webhookExpiry = '2026-12-01T00:00:00.000Z' } = {}) {
    const live = new Map();
    const access = new Map();
    let n = 0;
    const issue = (sites) => {
        n += 1;
        access.set(`access-${n}`, sites);
        live.set(`refresh-${n}`, sites);
        return { access_token: `access-${n}`, expires_in: 3600, token_type: 'Bearer', scope, ...(offline ? { refresh_token: `refresh-${n}` } : {}) };
    };
    const page = (values, url) => {
        const params = new URL(url).searchParams;
        const start = Number(params.get('startAt') || 0);
        const size = Math.min(pageSize, Number(params.get('maxResults') || 50));
        return { startAt: start, values: values.slice(start, start + size), isLast: start + size >= values.length };
    };
    const calls = [];
    const webhookCalls = [];
    let nextWebhookId = 1000;
    const handler = async (url, init = {}) => {
        calls.push(url);
        for (const [needle, status] of Object.entries(fail)) if (url.includes(needle)) return json({ errorMessages: ['boom'] }, status);
        if (url === 'https://auth.atlassian.com/oauth/token') {
            const body = JSON.parse(init.body);
            assert.deepStrictEqual([body.client_id, body.client_secret], ['atl-client', 'atl-secret']);
            if (body.grant_type === 'authorization_code') {
                assert.strictEqual(body.redirect_uri, 'http://localhost:3000/auth/atlassian/callback');
                if (!codes[body.code]) return json({ error: 'invalid_grant' }, 403);
                const sites = codes[body.code];
                delete codes[body.code];
                return json(issue(sites));
            }
            const sites = live.get(body.refresh_token);
            if (!sites) return json({ error: 'invalid_grant' }, 403);
            live.delete(body.refresh_token);
            return json(issue(sites));
        }
        const token = (init.headers?.authorization || '').replace('Bearer ', '');
        if (url === 'https://api.atlassian.com/oauth/token/accessible-resources') return access.has(token) ? json(access.get(token)) : json({}, 401);
        const m = url.match(/^https:\/\/api\.atlassian\.com\/ex\/jira\/([^/]+)(\/[^?]*)/);
        if (!m) throw new Error(`unexpected fetch ${url}`);
        if (!access.has(token) || !access.get(token).some((s) => s.id === m[1])) return json({}, 401);
        const site = jira[m[1]] || {};
        const path = m[2];
        if (path === '/rest/api/3/project/search') {
            const all = [{ id: '1', key: 'ABC', name: 'Alpha' }, { id: '2', key: 'DEF', name: 'Delta' }, { id: '3', key: 'GHI', name: 'Gamma' }];
            return json(page(all, url));
        }
        if (path === '/rest/agile/1.0/board') {
            const type = new URL(url).searchParams.get('type'); // like Atlassian: an optional filter on the board type
            return json(page((site.boards || []).filter((b) => !type || b.type === type), url));
        }
        let sub = path.match(/^\/rest\/agile\/1\.0\/board\/(\d+)\/sprint$/);
        if (sub) {
            // Like Atlassian: a board that doesn't use sprints answers 400.
            const sprints = (site.sprints || {})[sub[1]];
            return sprints ? json(page(sprints, url)) : json({ errorMessages: ['The board does not support sprints'] }, 400);
        }
        if ((sub = path.match(/^\/rest\/api\/3\/project\/([A-Z0-9_]+)\/version$/))) return json(page((site.versions || {})[sub[1]] || [], url));
        if (path === '/rest/api/3/field') return json(site.fields || []);
        if (path === '/rest/api/3/webhook' || path === '/rest/api/3/webhook/refresh') {
            const body = JSON.parse(init.body);
            webhookCalls.push({ cloudId: m[1], method: init.method, path, body });
            if (init.method === 'POST') {
                return json({ webhookRegistrationResult: body.webhooks.map((w) => (w.jqlFilter.includes('BAD') ? { errors: ['Invalid JQL'] } : { createdWebhookId: nextWebhookId++ })) });
            }
            if (init.method === 'PUT') return json({ expirationDate: webhookExpiry });
            if (init.method === 'DELETE') return new Response(null, { status: 202 });
        }
        if (path === '/rest/api/3/search/jql') {
            const params = new URL(url).searchParams;
            const jql = params.get('jql');
            let found;
            if ((sub = jql.match(/^sprint in \(([\d,]+)\) ORDER BY key$/))) {
                const ids = sub[1].split(',').map(Number);
                found = (site.issues || []).filter((i) => (i.fields.customfield_10020 || []).some((s) => ids.includes(s.id)));
            } else if ((sub = jql.match(/^key in \(([A-Z0-9_,-]+)\)$/))) {
                const keys = sub[1].split(',');
                found = (site.issues || []).filter((i) => keys.includes(i.key));
            } else if ((sub = jql.match(/^project = "([A-Z0-9_]+)" AND fixVersion = (\d+) ORDER BY key$/))) {
                const [, key, versionId] = sub;
                found = (site.issues || []).filter((i) => i.fields.project?.key === key && (i.fields.fixVersions || []).some((v) => v.id === versionId));
            } else if ((sub = jql.match(/^project = "([A-Z0-9_]+)" AND \((statusCategory = "In Progress" OR )?resolved >= "([\d-]+)" AND resolved < "([\d-]+)"\) ORDER BY key$/))) {
                const [, key, inProgress, from, to] = sub;
                found = (site.issues || []).filter((i) => i.fields.project?.key === key && (
                    (inProgress && i.fields.status?.statusCategory?.key === 'indeterminate')
                    || (i.fields.resolutiondate && i.fields.resolutiondate.slice(0, 10) >= from && i.fields.resolutiondate.slice(0, 10) < to)));
            } else {
                throw new Error(`unexpected jql ${jql}`);
            }
            const offset = Number(params.get('nextPageToken') || 0);
            const size = Math.min(pageSize, Number(params.get('maxResults')));
            const next = offset + size < found.length ? String(offset + size) : undefined;
            return json({ issues: found.slice(offset, offset + size), ...(next ? { nextPageToken: next } : { isLast: true }) });
        }
        throw new Error(`unexpected fetch ${url}`);
    };
    return { handler, calls, webhookCalls, revokeAll: () => live.clear() };
}

module.exports = { fakeAtlassian };
