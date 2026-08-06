// scripts/extract-release-scope.js
//
// Given a previous and current version tag, returns the Jira keys and PR
// numbers referenced anywhere in the commit subjects between them —
// matching the same commit range logic as evtools-global-workflow-publish-release-notes,
// so ShipScope and the Slack release notes always agree on "what's in this release".
//
// Broadened from earlier versions: Jira keys are matched anywhere in the
// subject (not just inside the conventional-commit scope parens), since
// different teams reference tickets differently:
//   feat(SCRUM-123): message          <- key in scope
//   feat(auth): message (REIM-1234)   <- key trailing

const { execSync } = require('child_process');

const { PREVIOUS_VERSION, CURRENT_VERSION } = process.env;

function fail(message) {
    console.error(`Error: ${message}`);
    process.exit(1);
}

if (!CURRENT_VERSION) fail('Missing CURRENT_VERSION');

function autoDetectPreviousVersion() {
    try {
        // Latest semver tag reachable from CURRENT_VERSION, excluding CURRENT_VERSION itself
        return execSync(`git describe --tags --abbrev=0 "${CURRENT_VERSION}^"`, { encoding: 'utf8' }).trim();
    } catch (e) {
        return null; // first-ever release — no previous tag to diff against
    }
}

function main() {
    const previousVersion = PREVIOUS_VERSION || autoDetectPreviousVersion();

    const range = previousVersion ? `${previousVersion}..${CURRENT_VERSION}` : CURRENT_VERSION;
    const subjects = execSync(`git log --pretty=format:"%s" ${range}`, { encoding: 'utf8' })
        .split('\n')
        .filter(Boolean);

    const jiraKeys = new Set();
    const prNumbers = new Set();

    for (const subject of subjects) {
        const jiraMatches = subject.match(/[A-Z]{2,}-[0-9]+/g) || [];
        jiraMatches.forEach(k => jiraKeys.add(k));

        const prMatches = subject.match(/#([0-9]+)/g) || [];
        prMatches.forEach(p => prNumbers.add(p.replace('#', '')));
    }

    const result = {
        previousVersion: previousVersion || null,
        currentVersion: CURRENT_VERSION,
        commitCount: subjects.length,
        relatedIssues: [...jiraKeys],
        relatedPRs: [...prNumbers],
    };

    console.log(JSON.stringify(result));
}

main();