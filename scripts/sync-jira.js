// scripts/sync-jira.js
const fs = require('fs');

const { JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN } = process.env;
const JQL = 'project = SCRUM ORDER BY updated DESC';
const auth = Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString('base64');

async function main() {

    const res = await fetch(`${JIRA_BASE_URL}/rest/api/3/search/jql?jql=${encodeURIComponent(JQL)}&maxResults=100&fields=summary,issuetype,labels,issuelinks,status`, {
        headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' }
    });
    if (!res.ok) throw new Error(`Jira API error: ${res.status} ${await res.text()}`);
    const data = await res.json();

    console.log('Raw issues from Jira:', data.issues.map(i => ({ key: i.key, type: i.fields.issuetype.name, labels: i.fields.labels })));
    const TYPE_MAP = {
        'Epik': 'Epic', 'Epic': 'Epic',
        'Zadanie': 'Task', 'Task': 'Task',
        'Story': 'Story',
    };

    const issues = data.issues
        .map(issue => {
            const rawType = issue.fields.issuetype.name;
            const type = TYPE_MAP[rawType];
            if (!type) return null; // skip unrecognized types (e.g. Bug, Sub-task)
            const labels = issue.fields.labels || [];
            const pi = labels.find(l => /^PI\d+\.\d+$/i.test(l)) || null;
            const blockers = (issue.fields.issuelinks || []).filter(link =>
                link.type?.inward === 'is blocked by' && link.inwardIssue &&
                link.inwardIssue.fields.status.statusCategory.key !== 'done'
            );
            return {
                key: issue.key,
                type,
                title: issue.fields.summary,
                pi,
                dependencyBlocked: blockers.length > 0,
                ...(blockers.length > 0 ? { dependencyNote: `Blocked by ${blockers[0].inwardIssue.key}: ${blockers[0].inwardIssue.fields.summary}` } : {})
            };
        })
        .filter(i => i && i.pi);

    const outputPath = process.env.OUTPUT_PATH || 'docs/data/jira-issues.json';
    fs.writeFileSync(outputPath, JSON.stringify(issues, null, 2));
    console.log(`Wrote ${issues.length} issues`);
}

main().catch(e => { console.error(e); process.exit(1); });