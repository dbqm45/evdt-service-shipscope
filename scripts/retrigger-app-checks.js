// scripts/retrigger-app-checks.js  (lives in shipscope-test)
//
// After flags-meta.json changes (scaffold, fill-flag-metadata, or a manual
// edit), the app repo's PR check has no way of knowing on its own — its
// trigger is `pull_request: paths: **/*-flags.ts`, which doesn't fire for a
// push to a different repo. This script closes that gap: it finds any
// currently-failed "Check flag metadata" runs attached to OPEN pull requests
// in the app repo, and re-runs them.
//
// Deliberately conservative: only touches runs that (a) failed, (b) belong
// to the specific workflow file, and (c) are attached to a still-open PR
// (not a merged/closed one) — never touches unrelated workflows or history.

const APP_REPO = process.env.APP_REPO; // e.g. "myorg/doc_test"
const APP_REPO_TOKEN = process.env.APP_REPO_RERUN_TOKEN;
const WORKFLOW_FILE = process.env.WORKFLOW_FILE || 'check-flags-trigger.yml';

function fail(message) {
    console.error(`Error: ${message}`);
    process.exit(1);
}

/**
 * Pure filtering logic, kept separate from the network call so it can be
 * unit-tested without hitting the real GitHub API.
 */
function selectRunsToRerun(runs) {
    return runs.filter(run =>
        run.status === 'completed' &&
        run.conclusion === 'failure' &&
        run.event === 'pull_request' &&
        Array.isArray(run.pull_requests) &&
        run.pull_requests.length > 0
    );
}

async function githubApi(path, token, options = {}) {
    const res = await fetch(`https://api.github.com${path}`, {
        ...options,
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            ...(options.headers || {}),
        },
    });
    if (!res.ok) throw new Error(`GitHub API error on ${path}: ${res.status} ${await res.text()}`);
    return res.status === 204 ? null : res.json();
}

async function main() {
    if (!APP_REPO) fail('Missing APP_REPO (e.g. "myorg/doc_test")');
    if (!APP_REPO_TOKEN) fail('Missing APP_REPO_RERUN_TOKEN');

    const runsData = await githubApi(
        `/repos/${APP_REPO}/actions/workflows/${WORKFLOW_FILE}/runs?status=failure&per_page=20`,
        APP_REPO_TOKEN
    );

    const toRerun = selectRunsToRerun(runsData.workflow_runs || []);

    if (!toRerun.length) {
        console.log('No failed, open-PR runs of the flag metadata check found — nothing to re-run.');
        return;
    }

    for (const run of toRerun) {
        const prNumbers = run.pull_requests.map(pr => `#${pr.number}`).join(', ');
        console.log(`Re-running run ${run.id} (${prNumbers}, commit ${run.head_sha.slice(0, 7)})...`);
        await githubApi(`/repos/${APP_REPO}/actions/runs/${run.id}/rerun-failed-jobs`, APP_REPO_TOKEN, {
            method: 'POST',
        });
    }

    console.log(`Re-triggered ${toRerun.length} run(s).`);
}

module.exports = { selectRunsToRerun };

if (require.main === module) {
    main().catch(e => { console.error(e); process.exit(1); });
}