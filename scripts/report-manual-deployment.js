// scripts/report-manual-deployment.js
//
// Appends a deployment record based on manual input (workflow_dispatch form),
// for cases where the deploy itself was done by hand (e.g. manually uploading
// a build artifact to PROD), so no automatic commit-message extraction applies.

const fs = require('fs');

const DATA_PATH = process.env.DATA_PATH || 'docs/data/deployments.json';
const { COMPONENT, ENVIRONMENT, VERSION, RELATED_ISSUES, DEPLOYED_BY } = process.env;

function fail(message) {
    console.error(`Error: ${message}`);
    process.exit(1);
}

if (!COMPONENT) fail('Missing COMPONENT');
if (!ENVIRONMENT) fail('Missing ENVIRONMENT');
if (!VERSION) fail('Missing VERSION');

const relatedIssues = (RELATED_ISSUES || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

const deployments = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));

const record = {
    id: `manual-${Date.now()}`,
    component: COMPONENT,
    environment: ENVIRONMENT,
    version: VERSION,
    deployedAt: new Date().toISOString(),
    deployedBy: DEPLOYED_BY || 'unknown (manual)',
    status: 'success',
    relatedIssues,
    manual: true, // marks this record as manually reported, not CI-derived
};

deployments.push(record);
fs.writeFileSync(DATA_PATH, JSON.stringify(deployments, null, 2));
console.log(`Recorded manual deployment: ${COMPONENT} -> ${ENVIRONMENT} (${VERSION}), issues: [${relatedIssues.join(', ')}]`);