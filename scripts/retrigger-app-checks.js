const { githubApiRequest } = require('./lib/github-api');
const { fail } = require('./lib/cli');
const APP_REPO = process.env.APP_REPO;
const APP_REPO_TOKEN = process.env.APP_REPO_RERUN_TOKEN;
const WORKFLOW_FILE = process.env.WORKFLOW_FILE || 'check-flags-trigger.yml';


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
    return githubApiRequest(`https://api.github.com${path}`, token, options);
}

async function main() {
    if (!APP_REPO) {
        fail('Missing APP_REPO (e.g. "myorg/doc_test")');
    }
    if (!APP_REPO_TOKEN) {
        fail('Missing APP_REPO_RERUN_TOKEN');
    }

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
