/* ---------- Data loading: real files first, embedded fallback for standalone preview ----------
 * Opening docs/index.html directly (double-click, or drag into a browser — no server, no deploy)
 * makes every `fetch()` below fail (browsers block fetching relative files over file://), so
 * loadData()'s catch block returns this FALLBACK object instead. That's the built-in "preview
 * without a file server" path CLAUDE.md already documents — this dataset just exists to exercise
 * it: every visual state currently in the app (grouped consecutive deploys, a manual-partial group,
 * drift-behind warnings, a rollback, a build/runtime-be diverging flag, a brand-new flag, a
 * dependency-blocked issue, an epic that's fully released vs. one that's partial vs. one that's
 * empty, an ungrouped issue, deployed_code_only vs. flag-hidden statuses) shows up somewhere,
 * without needing real synced data or a deploy to check a styling change.
 */
/** Mock `driftBehind.diff` for the preview: a random handful of plausible changed paths (the real value comes
 *  from the tree comparison in sync-github-deployments.js). `more` extra files are counted but not listed. */
function mockDiff(count, more = 0){
    const pool = ['src/app/app.component.ts', 'src/app/app.routes.ts', 'src/app/shared/utils/date.ts', 'src/app/charging/charger-list.component.html',
        'src/app/charging/charger-list.component.ts', 'src/app/charging/charger.service.ts', 'src/assets/i18n/en.json', 'src/assets/i18n/pl.json',
        'src/environments/environment.prod.ts', 'package.json', 'package-lock.json', 'angular.json', 'src/styles.scss',
        'src/app/auth/token.interceptor.ts', 'src/app/auth/auth.guard.ts', 'src/app/settings/settings.component.ts'];
    const paths = pool.map(p => [Math.random(), p]).sort((a, b) => a[0] - b[0]).slice(0, count).map(x => x[1]).sort();

    return { files: count + more, paths, ignored: Math.floor(Math.random() * 4) };
}

function buildFallbackData(){
    const now = Date.now();
    const HOUR = 3600000, DAY = 86400000;
    const hrsAgo = h => new Date(now - h * HOUR).toISOString();
    const daysAgo = d => new Date(now - d * DAY).toISOString();
    const buildState = (enabled, changedAt, changedBy) => ({ build: { enabled, changedAt, changedBy } });
    const beState = (enabled, changedAt, changedBy) => ({ 'runtime-be': { enabled, changedAt, changedBy } });

    const FE = 'evapl-service-frontend';
    const CH = 'evnm-service-charger-infrastructure';
    const BO = 'evboweb-service-frontend';
    const BF = 'evboweb-service-bff';
    const SI = 'evsim-service-sim-adapter';
    const HO = 'evam-service-host';
    const ALL = [FE, CH, BO, BF, SI, HO];

    // Promotion order is test -> qa -> prod: an issue present on an environment is present on every environment
    // to its left too (released on prod => released on TEST and QA; code deployed on prod => at least code
    // deployed on TEST and QA). Only environments further right may be "not deployed".
    const deployments = [
        // TEST
        { id: 'd1', component: FE, environment: ENVIRONMENT.TEST, version: 'v0.13.0', deployedAt: hrsAgo(4), deployedBy: 'Maciej Piasecki', status: 'success', durationMs: 95000, workflowRunUrl: '#', relatedIssues: ['EBO-16964'], resolvedFlags: { assetNuvoloIntegrationEnabled: true } },
        { id: 'd2', component: CH, environment: ENVIRONMENT.TEST, version: 'v1.4.6', deployedAt: hrsAgo(2), deployedBy: 'Maciej Piasecki', status: 'success', durationMs: 72000, workflowRunUrl: '#', relatedIssues: ['EBO-16955', 'EBO-16702', 'EBO-17001', 'EBO-16970', 'EBO-17101', 'EBO-17102', 'EBO-17103', 'EBO-17105'], resolvedFlags: { triggerMessageManualEnabled: true, ocppDeviationBadgeEnabled: true, triggerRetryEnabled: true, retryQueueViewerEnabled: true, retryQueueExportEnabled: true } },
        { id: 'd3', component: BO, environment: ENVIRONMENT.TEST, version: 'v0.0.699', deployedAt: daysAgo(14), deployedBy: 'ci-bot', status: 'success', relatedIssues: [] },
        { id: 'd4', component: BF, environment: ENVIRONMENT.TEST, version: 'v1.1.41', deployedAt: daysAgo(1), deployedBy: 'Kacper Jóźwiak', status: 'success', relatedIssues: ['EBO-16702', 'EBO-16955'], resolvedFlags: { ocppDeviationBadgeBffEnabled: true, triggerMessageManualEnabled: true } },
        { id: 'd5', component: SI, environment: ENVIRONMENT.TEST, version: 'v1.0.19', deployedAt: daysAgo(2), deployedBy: 'ci-bot', status: 'success', relatedIssues: ['EBO-16981', 'EBO-16820'] },
        { id: 'd6', component: HO, environment: ENVIRONMENT.TEST, version: 'v1.0.25', deployedAt: daysAgo(2), deployedBy: 'ci-bot', status: 'success', relatedIssues: ['EBO-99001'], resolvedFlags: { legacyMigrationEnabled: true } },
        // QA — d7/d8/d9 are consecutive same-version deploys of the same service, so they collapse
        // into one grouped card ("3 deploys", manual count 2 of 3); d10 stays a normal single card.
        { id: 'd7', component: BF, environment: ENVIRONMENT.QA, version: 'v1.1.41', deployedAt: hrsAgo(3), deployedBy: 'Maciej Piasecki', status: 'success', manual: true, durationMs: 132000, workflowRunUrl: '#' },
        { id: 'd8', component: BF, environment: ENVIRONMENT.QA, version: 'v1.1.41', deployedAt: hrsAgo(2.4), deployedBy: 'Maciej Piasecki', status: 'success', manual: true, durationMs: 111000, workflowRunUrl: '#' },
        { id: 'd9', component: BF, environment: ENVIRONMENT.QA, version: 'v1.1.41', deployedAt: hrsAgo(1.7), deployedBy: 'Maciej Piasecki', status: 'success', relatedIssues: ['EBO-16955'], resolvedFlags: { triggerMessageManualEnabled: true }, durationMs: 125000, workflowRunUrl: '#' },
        { id: 'd10', component: CH, environment: ENVIRONMENT.QA, version: 'v1.4.6', deployedAt: hrsAgo(1), deployedBy: 'Maciej Piasecki', status: 'success', manual: true, durationMs: 72000, workflowRunUrl: '#', relatedIssues: ['EBO-16955', 'EBO-16702', 'EBO-17001', 'EBO-16970', 'EBO-17101', 'EBO-17102', 'EBO-17103', 'EBO-17105'], resolvedFlags: { triggerMessageManualEnabled: true, ocppDeviationBadgeEnabled: true, triggerRetryEnabled: true, retryQueueViewerEnabled: true, retryQueueExportEnabled: false } },
        { id: 'd11', component: FE, environment: ENVIRONMENT.QA, version: 'v0.8.2', deployedAt: daysAgo(8), deployedBy: 'ci-bot', status: 'success', driftBehind: { behindEnv: ENVIRONMENT.TEST, commitCount: 8, diff: mockDiff(6) }, relatedIssues: ['EBO-16964'], resolvedFlags: { assetNuvoloIntegrationEnabled: false } },
        { id: 'd12', component: BO, environment: ENVIRONMENT.QA, version: 'v0.0.699', deployedAt: hrsAgo(5), deployedBy: 'ci-bot', status: 'success' },
        { id: 'd13', component: SI, environment: ENVIRONMENT.QA, version: 'v1.0.14', deployedAt: daysAgo(44), deployedBy: 'ci-bot', status: 'success', driftBehind: { behindEnv: ENVIRONMENT.TEST, commitCount: 6, diff: mockDiff(9) }, relatedIssues: ['EBO-16820'] },
        { id: 'd14', component: HO, environment: ENVIRONMENT.QA, version: 'v1.0.21', deployedAt: daysAgo(44), deployedBy: 'ci-bot', status: 'success', driftBehind: { behindEnv: ENVIRONMENT.TEST, commitCount: 5, diff: { unknown: true } }, relatedIssues: ['EBO-99001'], resolvedFlags: { legacyMigrationEnabled: true } },
        // PROD
        { id: 'd15', component: FE, environment: ENVIRONMENT.PROD, version: 'v0.8.0', deployedAt: daysAgo(11), deployedBy: 'ci-bot', status: 'success', driftBehind: { behindEnv: ENVIRONMENT.QA, commitCount: 2, diff: mockDiff(3) }, relatedIssues: ['EBO-16964'], resolvedFlags: { assetNuvoloIntegrationEnabled: false } },
        { id: 'd16', component: CH, environment: ENVIRONMENT.PROD, version: 'v1.3.302', deployedAt: daysAgo(8), deployedBy: 'ci-bot', status: 'success', driftBehind: { behindEnv: ENVIRONMENT.QA, commitCount: 13, diff: mockDiff(16, 24) }, relatedIssues: ['EBO-16970', 'EBO-17001', 'EBO-16955'], resolvedFlags: { triggerRetryEnabled: true, triggerMessageManualEnabled: true } },
        { id: 'd17', component: BO, environment: ENVIRONMENT.PROD, version: 'v0.0.694', deployedAt: daysAgo(24), deployedBy: 'ci-bot', status: 'success', driftBehind: { behindEnv: ENVIRONMENT.QA, commitCount: 5, untestedIn: ENVIRONMENT.QA, untestedCommitCount: 3, diff: mockDiff(12) } },
        { id: 'd18', component: BF, environment: ENVIRONMENT.PROD, version: 'v1.1.39', deployedAt: daysAgo(2), deployedBy: 'ci-bot', status: 'success', driftBehind: { behindEnv: ENVIRONMENT.QA, commitCount: 2, diff: mockDiff(2) }, rollback: { toRef: 'v1.1.39' } },
        { id: 'd19', component: SI, environment: ENVIRONMENT.PROD, version: 'v1.0.14', deployedAt: daysAgo(44), deployedBy: 'ci-bot', status: 'success', driftBehind: { untestedIn: ENVIRONMENT.QA, untestedCommitCount: 4 }, relatedIssues: ['EBO-16820'] },
        // Same v1.0.21 label as HO/qa (d14) but a different commit: exercises the combined
        // "same version, different build" drift note instead of "behind" + "skipped".
        { id: 'd20', component: HO, environment: ENVIRONMENT.PROD, version: 'v1.0.21', deployedAt: daysAgo(44), deployedBy: 'ci-bot', status: 'success', driftBehind: { behindEnv: ENVIRONMENT.QA, commitCount: 417, untestedIn: ENVIRONMENT.QA, untestedCommitCount: 325, sameVersion: true, diff: mockDiff(14, 6) } },
        // Deliberately older than d20 above, so it never outranks it as HO/prod's "current version" —
        // exists purely to exercise Gap A's ghostFlagAge() in the fallback preview: shipped to prod 50
        // days ago, flag still off, well past GHOST_FLAG_DAYS (30).
        { id: 'd21', component: HO, environment: ENVIRONMENT.PROD, version: 'v1.0.18', deployedAt: daysAgo(50), deployedBy: 'ci-bot', status: 'success', relatedIssues: ['EBO-99001'] },
        // Older than d16 (CH/prod's current record), so it never outranks it. Ships the work items of epic
        // EVP-5600 below to prod: two with their flag ON (released), two with the flag OFF or no flag at all
        // (code deployed), one never deployed — exercises the layered Epic progress bar (green released
        // over blue code-deployed over the empty track).
        { id: 'd22', component: CH, environment: ENVIRONMENT.PROD, version: 'v1.3.280', deployedAt: daysAgo(20), deployedBy: 'ci-bot', status: 'success', relatedIssues: ['EBO-17101', 'EBO-17102', 'EBO-17103', 'EBO-17105'], resolvedFlags: { retryQueueViewerEnabled: true, retryQueueExportEnabled: false } },
    ];

    // EBO-16955 is linked to a flag on two components (CH and BF): both are deployed on TEST/QA, but on PROD only
    // CH shipped it so far -> its PROD status is PARTIAL (one part live, the other not deployed yet).
    const flagsMeta = {
        allowEvseNameEdit: { description: 'Allow inline EVSE name editing', source: 'build', jiraKeys: [], components: ALL, createdAt: daysAgo(90) },
        // Diverges in prod on purpose: build default is ON, but the runtime-be override turned it OFF —
        // shows the "≠ PROD diverges from build default" note and counts toward "Flags diverging".
        assetNuvoloIntegrationEnabled: { description: 'Nuvolo integration for asset visibility', source: 'build', jiraKeys: ['EBO-16964'], components: [FE], createdAt: daysAgo(70) },
        availabilityActionsEnabled: { description: 'Bulk availability actions', source: 'build', jiraKeys: [], components: ALL, createdAt: daysAgo(80) },
        b2cCustomersEnabled: { description: 'B2C customers module', source: 'build', jiraKeys: [], components: [BO, BF], createdAt: daysAgo(75) },
        changeCpmsAllowed: { description: 'Ability to change CPMS — controlled by BE', source: 'runtime-be', jiraKeys: [], components: [CH], createdAt: daysAgo(85) },
        chargerBaseEditEnabled: { description: 'Charger base data editing', source: 'build', jiraKeys: [], components: [CH], createdAt: daysAgo(85) },
        triggerMessageManualEnabled: { description: 'Manual trigger message from connector level', source: 'build', jiraKeys: ['EBO-16955'], components: [CH, BF], createdAt: daysAgo(30) },
        ocppDeviationBadgeEnabled: { description: 'Deviation badge in the OCPP templates list (charger side)', source: 'build', jiraKeys: ['EBO-16702'], components: [CH], createdAt: daysAgo(15) },
        ocppDeviationBadgeBffEnabled: { description: 'Deviation badge in the OCPP templates list (BFF side)', source: 'build', jiraKeys: ['EBO-16702'], components: [BF], createdAt: daysAgo(15) },
        triggerRetryEnabled: { description: 'Automatic retry for failed trigger messages', source: 'build', jiraKeys: ['EBO-16970'], components: [CH], createdAt: daysAgo(10) },
        retryQueueViewerEnabled: { description: 'Retry queue viewer and its filters', source: 'build', jiraKeys: ['EBO-17101', 'EBO-17102'], components: [CH], createdAt: daysAgo(22) },
        retryQueueExportEnabled: { description: 'CSV export of the retry queue', source: 'build', jiraKeys: ['EBO-17105'], components: [CH], createdAt: daysAgo(22) },
        legacyMigrationEnabled: { description: 'Legacy host data migration', source: 'build', jiraKeys: ['EBO-99001'], components: [HO], createdAt: daysAgo(95) },
        // No flagStates entry below — a flag this fresh (created a few hours ago) hasn't had its state
        // resolved anywhere yet, which is exactly what makes it show up as a "New flag" timeline card.
        transactionB2CPaymentDetailsEnabled: { description: 'Show B2C payment details on the transaction', source: 'build', jiraKeys: [], components: [FE], createdAt: hrsAgo(3.2) },
    };

    const flagStates = {
        allowEvseNameEdit: { test: buildState(true, daysAgo(90), 'ci-bot'), qa: buildState(true, daysAgo(90), 'ci-bot'), prod: buildState(true, daysAgo(90), 'ci-bot') },
        assetNuvoloIntegrationEnabled: {
            test: buildState(true, daysAgo(60), 'a.kowalska'),
            qa: buildState(false, daysAgo(60), 'a.kowalska'),
            prod: { build: { enabled: true, changedAt: daysAgo(60), changedBy: 'a.kowalska' }, 'runtime-be': { enabled: false, changedAt: hrsAgo(20), changedBy: 'm.nowak (BE)' } },
        },
        availabilityActionsEnabled: { test: buildState(true, daysAgo(80), 'ci-bot'), qa: buildState(true, daysAgo(80), 'ci-bot'), prod: buildState(true, daysAgo(80), 'ci-bot') },
        b2cCustomersEnabled: { test: buildState(true, daysAgo(75), 'ci-bot'), qa: buildState(false, daysAgo(75), 'ci-bot'), prod: buildState(false, daysAgo(75), 'ci-bot') },
        changeCpmsAllowed: { test: beState(true, daysAgo(85), 'm.nowak (BE)'), qa: beState(true, daysAgo(85), 'm.nowak (BE)'), prod: beState(true, daysAgo(85), 'm.nowak (BE)') },
        chargerBaseEditEnabled: { test: buildState(true, daysAgo(85), 'ci-bot'), qa: buildState(true, daysAgo(85), 'ci-bot'), prod: buildState(true, daysAgo(85), 'ci-bot') },
        triggerMessageManualEnabled: { test: buildState(true, daysAgo(30), 'ci-bot'), qa: buildState(true, daysAgo(30), 'ci-bot'), prod: buildState(true, daysAgo(30), 'ci-bot') },
        ocppDeviationBadgeEnabled: { test: buildState(true, hrsAgo(1), 'Maciej Piasecki'), qa: buildState(true, hrsAgo(1), 'Maciej Piasecki'), prod: buildState(false, daysAgo(15), 'ci-bot') },
        ocppDeviationBadgeBffEnabled: { test: buildState(true, daysAgo(1), 'Kacper Jóźwiak'), qa: buildState(false, daysAgo(15), 'ci-bot'), prod: buildState(false, daysAgo(15), 'ci-bot') },
        triggerRetryEnabled: { test: buildState(true, daysAgo(10), 'ci-bot'), qa: buildState(true, daysAgo(10), 'ci-bot'), prod: buildState(true, daysAgo(10), 'ci-bot') },
        retryQueueViewerEnabled: { test: buildState(true, daysAgo(20), 'ci-bot'), qa: buildState(true, daysAgo(20), 'ci-bot'), prod: buildState(true, daysAgo(19), 'ci-bot') },
        retryQueueExportEnabled: { test: buildState(true, daysAgo(20), 'ci-bot'), qa: buildState(false, daysAgo(20), 'ci-bot'), prod: buildState(false, daysAgo(20), 'ci-bot') },
        legacyMigrationEnabled: { test: buildState(true, daysAgo(95), 'ci-bot'), qa: buildState(true, daysAgo(95), 'ci-bot'), prod: buildState(false, daysAgo(95), 'ci-bot') },
    };

    const flagStateHistory = [
        { key: 'triggerMessageManualEnabled', env: ENVIRONMENT.QA, source: 'build', enabled: true, changedAt: hrsAgo(1), changedBy: 'Maciej Piasecki' },
        { key: 'ocppDeviationBadgeEnabled', env: ENVIRONMENT.QA, source: 'build', enabled: true, changedAt: hrsAgo(1), changedBy: 'Maciej Piasecki' },
        { key: 'assetNuvoloIntegrationEnabled', env: ENVIRONMENT.PROD, source: 'runtime-be', enabled: false, changedAt: hrsAgo(20), changedBy: 'm.nowak (BE)' },
    ];

    const jiraIssues = [
        { key: 'EVP-4288', type: ISSUE_TYPE.EPIC, title: 'OCPP admin trigger message support', pi: 'PI-27.3', sprint: 'Sparks 27.3.1', projectName: 'eMobility Sparks', dependencyBlocked: false, status: 'In Development' },
        { key: 'EBO-16955', type: ISSUE_TYPE.STORY, title: 'FE + BE: trigger message from connector level', epicKey: 'EVP-4288', epicTitle: 'OCPP admin trigger message support', pi: 'PI-27.3', sprint: 'Sparks 27.3.1', projectName: 'eMobility Sparks', dependencyBlocked: false, status: 'Done', statusCategory: 'done', subtasks: { done: 3, total: 3 }, priority: 'High', resolvedAt: daysAgo(13) },
        { key: 'EBO-16964', type: ISSUE_TYPE.TASK, title: 'Persist last trigger payload for retries', epicKey: 'EVP-4288', epicTitle: 'OCPP admin trigger message support', pi: 'PI-27.3', sprint: 'Sparks 27.3.1', projectName: 'eMobility Sparks', dependencyBlocked: false, status: 'In Progress', statusCategory: 'indeterminate', priority: 'Medium' },
        { key: 'EBO-16970', type: ISSUE_TYPE.BUG, title: 'Trigger button double-submits on slow network', epicKey: 'EVP-4288', epicTitle: 'OCPP admin trigger message support', pi: 'PI-27.3', sprint: 'Sparks 27.3.1', projectName: 'eMobility Sparks', dependencyBlocked: true, dependencyNote: 'Waits on EVP-5102 — connector firmware update', status: 'Blocked', statusCategory: 'indeterminate', impediment: true, priority: 'Highest' },
        // Paired with d21/legacyMigrationEnabled above — deliberately placed under the same epic as the
        // open EBO-16970 bug so the fallback preview shows Gap A's "ghost flag" row/epic badge and Gap D's
        // "open bug" epic badge together on one epic, without needing a server or real synced data.
        { key: 'EBO-99001', type: ISSUE_TYPE.STORY, title: 'Host migration — legacy data backfill', epicKey: 'EVP-4288', epicTitle: 'OCPP admin trigger message support', pi: 'PI-27.3', sprint: 'Sparks 27.3.1', projectName: 'eMobility Sparks', dependencyBlocked: false, status: 'Done', statusCategory: 'done', priority: 'Medium' },
        // No flag anywhere links to this key (see flagsMeta below), yet it's deployed to test/qa/prod
        // (d2/d10/d16 above) — deliberately mirrors a real case we hit: Jira still shows it "In Test"
        // with open sub-tasks/bugs, while every env's pill says "Code deployed" since there's no flag to
        // confirm against. Exercises both the Jira-status tag and the sub-task ratio added to
        // renderIssueRow specifically so this mismatch is visible at a glance instead of only inside the
        // expanded breakdown.
        { key: 'EBO-17001', type: ISSUE_TYPE.STORY, title: 'FE + BE: retry queue viewer for failed trigger messages', epicKey: 'EVP-4288', epicTitle: 'OCPP admin trigger message support', pi: 'PI-27.3', sprint: 'Sparks 27.3.2', projectName: 'eMobility Sparks', dependencyBlocked: false, status: 'In Test', statusCategory: 'indeterminate', subtasks: { done: 2, total: 6 }, priority: 'Medium' },
        // Epic with a mix of prod states (2 released, 2 code deployed, 1 not deployed) so the layered progress
        // bar shows both fills at once — see d22 and retryQueueViewerEnabled/retryQueueExportEnabled above.
        { key: 'EVP-5600', type: ISSUE_TYPE.EPIC, title: 'Retry queue operator tooling', pi: 'PI-27.3', sprint: 'Sparks 27.3.2', projectName: 'eMobility Sparks', status: 'In Development' },
        { key: 'EBO-17101', type: ISSUE_TYPE.STORY, title: 'Retry queue viewer — list of failed messages', epicKey: 'EVP-5600', epicTitle: 'Retry queue operator tooling', pi: 'PI-27.3', sprint: 'Sparks 27.3.2', projectName: 'eMobility Sparks', dependencyBlocked: false, status: 'Done', statusCategory: 'done', priority: 'High', resolvedAt: daysAgo(21) },
        { key: 'EBO-17102', type: ISSUE_TYPE.TASK, title: 'Retry queue viewer — filters by connector', epicKey: 'EVP-5600', epicTitle: 'Retry queue operator tooling', pi: 'PI-27.3', sprint: 'Sparks 27.3.2', projectName: 'eMobility Sparks', dependencyBlocked: false, status: 'Done', statusCategory: 'done', priority: 'Medium', resolvedAt: daysAgo(21) },
        { key: 'EBO-17103', type: ISSUE_TYPE.STORY, title: 'Retry queue — manual re-send action', epicKey: 'EVP-5600', epicTitle: 'Retry queue operator tooling', pi: 'PI-27.3', sprint: 'Sparks 27.3.2', projectName: 'eMobility Sparks', dependencyBlocked: false, status: 'In Test', statusCategory: 'indeterminate', priority: 'Medium' },
        { key: 'EBO-17105', type: ISSUE_TYPE.TASK, title: 'Retry queue — CSV export', epicKey: 'EVP-5600', epicTitle: 'Retry queue operator tooling', pi: 'PI-27.3', sprint: 'Sparks 27.3.2', projectName: 'eMobility Sparks', dependencyBlocked: false, status: 'In Progress', statusCategory: 'indeterminate', priority: 'Low' },
        { key: 'EBO-17104', type: ISSUE_TYPE.TASK, title: 'Retry queue — alert when queue grows', epicKey: 'EVP-5600', epicTitle: 'Retry queue operator tooling', pi: 'PI-27.3', sprint: 'Sparks 27.3.2', projectName: 'eMobility Sparks', dependencyBlocked: false, status: 'To Do', statusCategory: 'new', priority: 'Low' },
        { key: 'EVP-5406', type: ISSUE_TYPE.EPIC, title: '[Sparks][ARCH] Document all existing scopes in Swagger Hub', pi: 'PI-27.3', sprint: 'Sparks 27.3.1', projectName: 'eMobility Sparks', status: 'Ready for Prod' },
        { key: 'EBO-16820', type: ISSUE_TYPE.TASK, title: 'PH1 — documentation of scopes of the token', epicKey: 'EVP-5406', epicTitle: '[Sparks][ARCH] Document all existing scopes in Swagger Hub', pi: 'PI-27.3', sprint: 'Sparks 27.3.1', projectName: 'eMobility Sparks', dependencyBlocked: false, status: 'Done', statusCategory: 'done', priority: 'Low', resolvedAt: daysAgo(46) },
        { key: 'EVP-5111', type: ISSUE_TYPE.EPIC, title: 'OCPP templates improvements — deviation visibility in Templates list', pi: 'PI-27.2', sprint: 'Sparks 27.2.4', projectName: 'eMobility Sparks', status: 'In Development' },
        { key: 'EBO-16702', type: ISSUE_TYPE.STORY, title: 'Show deviation badge in the OCPP templates list', epicKey: 'EVP-5111', epicTitle: 'OCPP templates improvements — deviation visibility in Templates list', pi: 'PI-27.2', sprint: 'Sparks 27.2.4', projectName: 'eMobility Sparks', dependencyBlocked: false, status: 'In Test', statusCategory: 'indeterminate', priority: 'High' },
        { key: 'EBO-16981', type: ISSUE_TYPE.BUG, title: 'Fix stale cache on environment switch', pi: 'PI-27.3', sprint: 'Sparks 27.3.1', projectName: 'eMobility Sparks', dependencyBlocked: false, status: 'To Do', statusCategory: 'new', priority: 'Medium' },
        // No child issues resolve `epicKey` to this one — exercises the empty-epic row (dash instead of
        // a chevron, not expandable) in Product view.
        { key: 'EVP-5522', type: ISSUE_TYPE.EPIC, title: 'Explore multi-connector charge scheduling', pi: 'PI-27.3', sprint: 'Sparks 27.3.1', projectName: 'eMobility Sparks', status: 'Backlog' },
    ];

    const componentsOrder = [
        { name: FE, description: 'EV Admin Panel — frontend', serviceType: SERVICE_TYPE.FE, featureFlagsIncluded: true, application: ['EVAPL'] },
        { name: CH, description: 'Charger infrastructure management', serviceType: SERVICE_TYPE.BE, featureFlagsIncluded: true, application: ['EVNM'] },
        { name: BO, description: 'Back-office web — frontend', serviceType: SERVICE_TYPE.FE, featureFlagsIncluded: true, application: ['EBO'] },
        // false (not null) on purpose — shows the ⚑? "flags not tracked here" icon next to this row.
        { name: BF, description: 'Back-office web — BFF', serviceType: SERVICE_TYPE.BE, featureFlagsIncluded: false, application: ['EBO'] },
        { name: SI, description: 'SIM adapter service', serviceType: SERVICE_TYPE.BE, featureFlagsIncluded: null, application: ['EVSIM'] },
        { name: HO, description: 'Asset management host', serviceType: SERVICE_TYPE.BE, featureFlagsIncluded: null, application: ['EVAM'] },
    ];

    // Release Notes-only history: a batch of already-released issues across several PIs/sprints, purely
    // to populate that tab in the fallback preview. Each (pi, sprint) group gets ONE synthetic prod
    // deployment carrying every issue key in that group as `relatedIssues` — that's enough for
    // issueIsReleasedToProd()'s deployed_code_only path (no flag needed) to mark them all released,
    // the same way a single release commonly ships many tickets at once. Deployed far enough in the past
    // (200+ days) that they never outrank the "current version" deploys set up above for the same
    // components in the Technical view.
    const releaseNotesSeed = [
        { pi: 'PI-27.3', sprint: 'Sparks 27.3.2', items: [
            [ISSUE_TYPE.TASK, 'PH 1 Documentation of scopes of the token'],
            [ISSUE_TYPE.TASK, 'Delete com4 related code from evboweb-bff'],
            [ISSUE_TYPE.BUG, 'Get on charger variant models returns 500 status due to index out of bounds exception'],
            [ISSUE_TYPE.BUG, 'Can\'t delete a template that shows 0 in the "total chargers" column on QA environment; an error toast says chargers are assigned'],
        ] },
        { pi: 'PI-27.3', sprint: 'Sparks 27.3.1', items: [
            [ISSUE_TYPE.TASK, 'Remove deprecated code'],
            [ISSUE_TYPE.TASK, 'Add additional logic to fill the connectionType field on charger'],
            [ISSUE_TYPE.STORY, '[Not meeting DoR] OCPP configuration improvements'],
            [ISSUE_TYPE.BUG, 'Multiply same error message'],
            [ISSUE_TYPE.BUG, 'Invalid GET stalls query parameter added in request'],
            [ISSUE_TYPE.BUG, 'On the Add pool screen, clicking the Add pool button repeatedly creates duplicate records.'],
            [ISSUE_TYPE.BUG, 'Issue with DECOMMISSIONING a ROAMING Charger multiple times in a row.'],
        ] },
        { pi: 'PI-27.2', sprint: 'Sparks 27.2.5', items: [
            [ISSUE_TYPE.STORY, 'FE: Refactor RQL library in EVA'],
            [ISSUE_TYPE.STORY, 'FE: Restrict charger add/edit actions to network manager role'],
            [ISSUE_TYPE.TASK, 'Remove rabbitmq settings from task-definitions'],
            [ISSUE_TYPE.TASK, 'EVNM- Create additional alerts and statistics to prevent production incidents'],
            [ISSUE_TYPE.TASK, 'Fe: Remake the data usage view in admin portal for new API'],
            [ISSUE_TYPE.TASK, 'Enable switching of Outbox integration for evse status updates'],
            [ISSUE_TYPE.STORY, 'BE+ FE - Export template chargers to CSV (with optional filters)'],
            [ISSUE_TYPE.BUG, 'Display name field covers button on Edit pool screen'],
            [ISSUE_TYPE.BUG, 'Not all chargers other than Roaming in all environments have Connection_type: cellular added.'],
            [ISSUE_TYPE.BUG, 'Lack of chargerIsProvisioned event when synchronized to CK CPMS'],
            [ISSUE_TYPE.BUG, 'Authentication methods are not selected by default per business branch in the Admin portal'],
            [ISSUE_TYPE.BUG, '[ocpp config] cyclical auto fetch should also work for chargers with no existing ocpp config'],
            [ISSUE_TYPE.BUG, 'Chargers cannot be switched back from CKPMS to Driivz via eBO/EVA cpms change'],
            [ISSUE_TYPE.BUG, 'Prevent decommissioning new charger with the same identity key as decommissioning charger'],
            [ISSUE_TYPE.BUG, 'Reports for roaming chargers on Mac with the Safari browser generate incorrect file formats.'],
            [ISSUE_TYPE.BUG, 'Manual template creation does not work on QA environment'],
            [ISSUE_TYPE.BUG, 'Showing that the Fetch config is clicked on OCPP keys when other sync is being done'],
            [ISSUE_TYPE.BUG, '"Create template" on ocpp keys sidepanel does not work properly'],
            [ISSUE_TYPE.BUG, 'BE + FE: Stalls list - No default DESC sorting on the "Label" column'],
        ] },
        { pi: 'PI-27.2', sprint: 'Sparks 27.2.4', items: [
            [ISSUE_TYPE.STORY, 'PoC for Sparks Deployment Tracker'],
            [ISSUE_TYPE.STORY, 'EVNM - critical user journey metric for statuses processing - time of statuses processing'],
            [ISSUE_TYPE.STORY, 'Create a page with all feature flags for internal users, where feature flags statuses could be visible and modified'],
            [ISSUE_TYPE.STORY, 'FE + BE- Template chargers side panel (view, filter, fetch latest config)'],
            [ISSUE_TYPE.BUG, '[PROD] Charger Displays CK_CPMS While All Charging Sessions Route Through Driivz'],
            [ISSUE_TYPE.BUG, 'In response for API for EVAPL FE → /internal/evapl/api/v1/chargers when validation fails a 500 error code is returned, which is misleading for the user'],
        ] },
        { pi: 'PI-27.2', sprint: 'Sparks 27.2.3', items: [
            [ISSUE_TYPE.TASK, 'BE: Change lock handling of domain refresh process when there is shutdown of service'],
            [ISSUE_TYPE.TASK, 'Update dependencies in projects'],
            [ISSUE_TYPE.BUG, 'White screen after log in to EVA'],
            [ISSUE_TYPE.BUG, 'Block the option to create a transit charger from EVA if there is no Transit Location'],
        ] },
        { pi: 'PI-27.2', sprint: 'Sparks 27.2.2', items: [
            [ISSUE_TYPE.STORY, 'FE + BE: Extend Stall single view with data about charger assigned'],
        ] },
        { pi: 'PI-27.2', sprint: null, items: [
            [ISSUE_TYPE.EPIC, 'OCPP templates improvements - deviation visibility in Templates list'],
            [ISSUE_TYPE.EPIC, '[Driivz exit] OCPP templates and configurations improvements (placeholder)'],
            [ISSUE_TYPE.EPIC, 'OCPP templates: Fix N/A handlig and deviation accuracy'],
        ] },
        { pi: 'PI-27.1', sprint: 'Sparks PI-27.1.5', items: [
            [ISSUE_TYPE.TASK, '[security] migrate to ministack'],
        ] },
        { pi: 'PI-27.1', sprint: 'Sparks PI-27.1.4', items: [
            [ISSUE_TYPE.TASK, 'Ugrade Spring to 4.x to reduce technical debt'],
            [ISSUE_TYPE.TASK, 'Add slack notifications for failed main builds/deployments on our products'],
            [ISSUE_TYPE.BUG, 'Issue with lack of failed requests and logs on BFF'],
        ] },
        { pi: 'PI-27.1', sprint: null, items: [
            [ISSUE_TYPE.EPIC, '[driivz exit] Creation of stall-based chargers in Admin portal on CK-CPMS (Greenfield only)'],
            [ISSUE_TYPE.EPIC, '[1CP][M4][Sparks] [PLACEHOLDER] Performance improvements based on tests results + needed adjustments'],
            [ISSUE_TYPE.EPIC, 'Bulk Editing of Stall Configurations'],
        ] },
        { pi: 'PI-26.5', sprint: 'Sparks PI-26.5.3', items: [
            [ISSUE_TYPE.TASK, 'Improve evtools logging library - adapt to standard'],
        ] },
    ];

    // Deterministic (not Math.random(): the preview must look the same on every reload) rotation of Jira
    // statuses / sub-task ratios over the seeded issues below, purely so Product view's per-row badges —
    // the status tag ("In Progress", "Blocked" + flag icon, ...), the "done/total sub-tasks" tag, and the
    // Epic header's "Open bug" badge — all show up in the fallback preview instead of only on the few
    // hand-written issues above. Mirrors the "deployed doesn't mean done" case those already exercise.
    const SEED_STATUSES = [['Done', 'done'], ['In Progress', 'indeterminate'], ['In Test', 'indeterminate'], ['Blocked', 'indeterminate'], ['Ready for Prod', 'done'], ['To Do', 'new']];
    const SEED_SUBTASKS = [{ done: 1, total: 1 }, { done: 2, total: 5 }, null, { done: 0, total: 3 }, { done: 4, total: 4 }];
    let relKeyCounter = 6000;

    releaseNotesSeed.forEach((group, gi) => {
        const keysInGroup = [];
        const keysBeyondTest = [];
        const keysBeyondQa = [];

        group.items.forEach(([type, title]) => {
            relKeyCounter++;

            const key = `EVP-${relKeyCounter}`;
            const issue = { key, type, title, pi: group.pi, projectName: 'eMobility Sparks', dependencyBlocked: false };

            if (group.sprint) {
                issue.sprint = group.sprint;
            }

            if (type !== ISSUE_TYPE.EPIC) {
                const n = relKeyCounter - 6001;
                const [status, statusCategory] = SEED_STATUSES[n % SEED_STATUSES.length];
                const subtasks = SEED_SUBTASKS[n % SEED_SUBTASKS.length];

                Object.assign(issue, { status, statusCategory });

                if (status === 'Blocked') {
                    issue.impediment = true;
                }
                if (subtasks) {
                    issue.subtasks = subtasks;
                }
                // Current-PI items, except every third one (left ungrouped on purpose), hang under one
                // epic — with the rotation above that epic gets open Bugs, i.e. the "Open bug" badge.
                if (group.pi === 'PI-27.3' && n % 3 !== 2) {
                    issue.epicKey = 'EVP-5406';
                    issue.epicTitle = '[Sparks][ARCH] Document all existing scopes in Swagger Hub';
                }
            }

            keysInGroup.push(key);

            // Promotion order test -> qa -> prod: most items reached every env, but every 5th stops at QA and
            // the one after it at TEST, so those rows show "Code deployed" only on the left-hand env(s).
            const stage = type === ISSUE_TYPE.EPIC ? 0 : (relKeyCounter - 6001) % 5;

            if (stage !== 4) {
                keysBeyondTest.push(key);
            }
            if (stage !== 3 && stage !== 4) {
                keysBeyondQa.push(key);
            }
            jiraIssues.push(issue);
        });

        [[ENVIRONMENT.TEST, 3, keysInGroup], [ENVIRONMENT.QA, 2, keysBeyondTest], [ENVIRONMENT.PROD, 0, keysBeyondQa]].forEach(([environment, daysEarlier, relatedIssues]) => {
            if (!relatedIssues.length) {
                return;
            }

            deployments.push({
                id: `relnotes-${environment}-${gi}`,
                component: ALL[gi % ALL.length],
                environment,
                version: `rel-${(group.sprint || group.pi).replace(/\s+/g, '-')}`,
                deployedAt: daysAgo(200 + gi * 5 + daysEarlier),
                deployedBy: 'ci-bot',
                status: 'success',
                relatedIssues,
            });
        });
    });

    // Mirrors sync-jira.js's own per-PI sharding (see CLAUDE.md's Jira issues section): group the flat
    // seed list above by `pi`, and build the same `{ currentPi, pis: [{ pi, sprints }] }` shape
    // index.json carries, so the fallback path can be driven through the exact same loadJiraIssuesForPi()
    // as the real data instead of a separate offline-only code path.
    const jiraIssuesByPi = new Map();

    jiraIssues.forEach(issue => {
        if (!jiraIssuesByPi.has(issue.pi)) jiraIssuesByPi.set(issue.pi, []);
        jiraIssuesByPi.get(issue.pi).push(issue);
    });

    // Real start/end dates for the current PI's two sprints — enough to exercise the Sprint scope
    // select's actual "does today fall inside this sprint" logic (currentSprintNames()) in the fallback
    // preview (Sparks 27.3.2 is deliberately active *now*), rather than always falling through to its
    // most-recently-started fallback. Every other sprint stays dateless (null/null, same as a real issue
    // whose Sprint field happened to omit dates) — only the demo-relevant one needs to be realistic.
    const SPRINT_DATES = {
        'Sparks 27.3.1': { startDate: daysAgo(28), endDate: daysAgo(14) },
        'Sparks 27.3.2': { startDate: daysAgo(3), endDate: daysAgo(-11) },
    };

    const sprintsByPi = new Map();

    jiraIssues.forEach(issue => {
        if (!issue.sprint) return;
        if (!sprintsByPi.has(issue.pi)) sprintsByPi.set(issue.pi, new Map());

        const bySprint = sprintsByPi.get(issue.pi);

        if (!bySprint.has(issue.sprint)) {
            const dates = SPRINT_DATES[issue.sprint] || { startDate: null, endDate: null };

            bySprint.set(issue.sprint, { name: issue.sprint, ...dates });
        }
    });

    const piEntries = [...jiraIssuesByPi.keys()].sort(compareVersionDesc).map(pi => ({
        pi,
        sprints: [...(sprintsByPi.get(pi)?.values() || [])],
    }));
    const jiraIndex = { currentPi: piEntries[0]?.pi || null, pis: piEntries };

    // Mirrors sync-jira.js's buildStatusIndex() — same key -> { pi, statusCategory } shape, spanning
    // every PI in the seed data, so flagBlastRadius()/flagStaleWarning() behave the same in the fallback
    // preview as they do against real data.
    const issueStatusIndex = {};

    jiraIssues.forEach(issue => { issueStatusIndex[issue.key] = { pi: issue.pi, statusCategory: issue.statusCategory }; });

    // Empty in the fallback/preview dataset — nothing is ever trimmed here (there's no real sync, no
    // RETENTION_DAYS), so `state.deployments` alone already covers everything this would otherwise
    // supplement; see loadData()'s own fetch for what this looks like against real data.
    const issueDeployments = {};

    // Empty for the same reason: the fallback dataset is small enough that currentVersion()'s plain scan
    // over state.deployments is already instant, so there's nothing worth precomputing here. currentVersion()
    // falls back to that same scan whenever a component/env is missing from state.summary.components.
    const summary = { components: {} };

    return { deployments, flagsMeta, flagStates, flagStateHistory, jiraIssuesByPi, jiraIndex, issueStatusIndex, componentsOrder, issueDeployments, summary };
}

// FALLBACK itself is initialised in app-main.js (right before init()): buildFallbackData() calls helpers from
// later scripts (e.g. compareVersionDesc in app-model.js), which don't exist yet while this file loads.

/**
 * SaaS mode: when the ShipScope server serves this page at /t/<tenantId>/, the data comes from its API for that
 * tenant, in one request and in the same shapes as the data/*.json files loaded below. Null everywhere else
 * (GitHub Pages, a static file server, file://), where loadData() works exactly as it always has.
 */
const API_TENANT_ID = (() => {
    const pathname = (typeof location !== 'undefined' && location.pathname) || '';
    const match = /^\/t\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\//i.exec(pathname);
    return match ? match[1] : null;
})();

const emptyDashboardData = () => ({
    deployments: [], flagsMeta: {}, flagStates: {}, jiraIndex: { currentPi: null, pis: [] }, flagStateHistory: [],
    componentsOrder: [], issueStatusIndex: {}, issueDeployments: {}, summary: { components: {} },
});

/**
 * loadData() in SaaS mode. Unlike the file-based path it never falls back to the built-in sample data: on a
 * real tenant's page, sample deployments would read as that tenant's own. Signed out (401) it goes through
 * sign-in and back; any other failure shows an empty dashboard with an error badge.
 */
async function loadApiData(tenantId){
    const badge = document.getElementById('statusBadge');
    // Only the server has a settings page (/t/<tenantId>/settings); on GitHub Pages the link stays hidden.
    const settingsLink = document.getElementById('settingsLink');
    if (settingsLink) {
        settingsLink.hidden = false;
    }
    let res = null;

    try {
        res = await fetch(`/api/tenants/${tenantId}/dashboard-data`, { credentials: 'same-origin' });
    } catch (e) {
        res = null;
    }

    if (res && res.status === 401) {
        location.assign(`/auth/github/login?returnTo=${encodeURIComponent(location.pathname)}`);
        return new Promise(() => {}); // the page is navigating away; render nothing in the meantime
    }

    if (!res || !res.ok) {
        badge.classList.add('fallback');
        badge.title = 'Could not load this tenant\'s data — reload the page to try again';
        document.getElementById('statusBadgeLabel').textContent = 'Error';
        document.getElementById('statusBadgeTime').textContent = 'source: ShipScope API';

        return { ...emptyDashboardData(), jiraBrowseUrl: null, isFallback: false };
    }

    const data = await res.json();
    badge.classList.remove('fallback');
    badge.title = '';
    document.getElementById('statusBadgeLabel').textContent = 'Live';
    document.getElementById('statusBadgeTime').textContent = data.lastSyncedAt
        ? `synced ${fmtTime(data.lastSyncedAt)} · source: ShipScope API`
        : 'source: ShipScope API';

    // A new workspace's dashboard is empty: point at what's left to set up rather than a blank page.
    const nothingYet = !(data.deployments || []).length && !Object.keys(data.flagsMeta || {}).length && !((data.jiraIndex || {}).pis || []).length;
    const setupBanner = document.getElementById('setupBanner');
    if (setupBanner) {
        setupBanner.hidden = !nothingYet;
    }

    // `jiraBrowseUrl: null` (no Jira connected) must not fall back to the file-based dashboard's Jira site.
    return { ...emptyDashboardData(), jiraBrowseUrl: null, ...data, isFallback: false };
}

async function loadData(){
    if (API_TENANT_ID) return loadApiData(API_TENANT_ID);

    try {
        const [deployments, flagsMeta, flagStates, jiraIndex] = await Promise.all([
            fetch('data/deployments.json').then(r=>{ if(!r.ok) throw new Error(); return r.json(); }),
            fetch('data/flags-meta.json').then(r=>{ if(!r.ok) throw new Error(); return r.json(); }),
            fetch('data/flag-states.json').then(r=>{ if(!r.ok) throw new Error(); return r.json(); }),
            fetch('data/jira-issues/index.json').then(r=>{ if(!r.ok) throw new Error(); return r.json(); }),
        ]);
        document.getElementById('statusBadge').classList.remove('fallback');
        document.getElementById('statusBadge').title = '';
        document.getElementById('statusBadgeLabel').textContent = 'Live';

        // Best-effort: losing the flag audit trail shouldn't take down the rest of the dashboard.
        const flagStateHistory = await fetch('data/flag-state-history.json')
            .then(r => r.ok ? r.json() : [])
            .catch(() => []);

        // Best-effort: only used to order the Technical view's component rows the way they were
        // onboarded instead of alphabetically — missing/unreachable just falls back to alphabetical.
        const componentsOrder = await fetch('components.json')
            .then(r => r.ok ? r.json() : null)
            .then(json => (json && json.components) || [])
            .catch(() => []);

        // Best-effort: a tiny key -> { pi, statusCategory } map spanning every PI (not just the one
        // currently loaded into state.jiraIssues) — see sync-jira.js's buildStatusIndex() for why the
        // Flags panel specifically needs this instead of just reading state.jiraIssues. Missing/unreachable
        // just means flagBlastRadius()/flagStaleWarning() can't resolve any issue (same as not finding a
        // key in state.jiraIssues today), not a hard failure.
        const issueStatusIndex = await fetch('data/jira-issues/status-index.json')
            .then(r => r.ok ? r.json() : {})
            .catch(() => ({}));

        // Best-effort: `{ [issueKey]: { [env]: { [component]: { deployedAt, commitUrl } } } }`, never
        // trimmed by RETENTION_DAYS unlike `deployments.json` itself — see sync-github-deployments.js's
        // ISSUE_DEPLOYMENTS_PATH for why. Missing/unreachable just means
        // anyDeploymentForIssue()/issueDeployedOnComponent() have nothing to fall back to.
        const issueDeployments = await fetch('data/issue-deployments.json')
            .then(r => r.ok ? r.json() : {})
            .catch(() => ({}));

        // Best-effort: written only by the branch of orchestrate-full-sync.yml that syncs every tracked
        // component (cron safety net, manual run, or an unknown/malformed dispatch), never by a
        // single-component repository_dispatch — so this is "all data last confirmed against the real
        // state," not just "something changed." Missing/unreachable just hides the line below the tag.
        const syncMeta = await fetch('data/sync-meta.json')
            .then(r => r.ok ? r.json() : null)
            .catch(() => null);

        // Best-effort: `{ components: { [component]: { [env]: { current, latestOverall } } } }`, a
        // precomputed fast path for currentVersion()/componentDeployments() so the Technical view's
        // summary cards and component×env matrix don't each have to rescan the full (potentially large)
        // `deployments` array on first render — see sync-github-deployments.js's SUMMARY_PATH comment.
        // Missing/unreachable just means those lookups fall back to scanning `state.deployments`.
        const summary = await fetch('data/summary.json')
            .then(r => r.ok ? r.json() : { components: {} })
            .catch(() => ({ components: {} }));

        document.getElementById('statusBadgeTime').textContent = syncMeta && syncMeta.lastFullSync
            ? `synced ${fmtTime(syncMeta.lastFullSync)} · source: data/*.json`
            : 'source: data/*.json';

        return { deployments, flagsMeta, flagStates, jiraIndex, flagStateHistory, componentsOrder, issueStatusIndex, issueDeployments, summary, isFallback: false };
    } catch(e) {
        document.getElementById('statusBadge').classList.add('fallback');
        document.getElementById('statusBadge').title = 'Built-in fallback data — preview without a file server';
        document.getElementById('statusBadgeLabel').textContent = 'Fallback';
        document.getElementById('statusBadgeTime').textContent = 'source: data/*.json (mock)';

        return { ...FALLBACK, isFallback: true };
    }
}

/** Fetches one PI's Jira issues — the per-PI shard named in `state.jiraIndex.pis` (or, in fallback mode,
 *  the matching slice of the embedded seed data) — and returns a plain array. Called once up front for
 *  the initial PI (see init()) and again whenever the global PI select changes. Never touches
 *  `state.jiraIssues` itself, so callers can swap it in only once the fetch actually resolves. */
async function loadJiraIssuesForPi(pi){
    if (!pi) return [];

    if (state.isFallback) {
        return FALLBACK.jiraIssuesByPi.get(pi) || [];
    }

    const entry = state.jiraIndex.pis.find(e => e.pi === pi);

    if (!entry) return [];

    if (API_TENANT_ID) {
        return fetch(`/api/tenants/${API_TENANT_ID}/jira-issues?pi=${encodeURIComponent(pi)}`, { credentials: 'same-origin' })
            .then(r => r.ok ? r.json() : []).catch(() => []);
    }

    return fetch(`data/jira-issues/${entry.file}`).then(r => r.ok ? r.json() : []).catch(() => []);
}

