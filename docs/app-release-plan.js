/* ---------- Release plan (G1.3) ----------
 * Plan against reality: which items of each release line R1…Rn are with users on PROD, where each flag stands against
 * its planned rollout stages, and which flags are past their remove-by date. The model is releasePlanModel()
 * (app-model.js); lines come from Jira (a `release:R1` label by default, the tenant's convention) or, later, from a
 * change's release.yaml (pdi contract 0.4.0). */

/** "25%", "on (100%)", "off", or "not reported" for a flag's PROD value. */
function flagRolloutText(f){
    if (f.state === null) {
        return 'not reported on PROD';
    }
    if (f.state === 'off') {
        return 'off on PROD';
    }

    return f.percent === null ? 'partial on PROD' : `${f.percent}% on PROD`;
}

/** The stage part of a flag's row, from its flagPlanStatus(). */
function flagStageTexts(f){
    if (f.status === 'no_plan') {
        return { stageText: 'No plan', progressText: '' };
    }
    if (f.status === 'not_started') {
        return { stageText: `Before stage ${f.nextStage}`, progressText: '' };
    }

    const days = f.daysInStage === null ? '' : `${f.daysInStage} day${f.daysInStage === 1 ? '' : 's'}`;

    if (f.status === 'final') {
        return { stageText: `Stage ${f.stage} (last)`, progressText: days ? `${days} in stage` : '' };
    }
    if (f.status === 'waiting') {
        return { stageText: `Stage ${f.stage}`, progressText: `${f.daysInStage ?? 0} of ${f.minDays} days` };
    }

    return { stageText: `Stage ${f.stage}`, progressText: `Ready for ${f.nextStage}${days ? ` · ${days} in stage` : ''}${f.exit ? ` · exit: ${f.exit}` : ''}` };
}

function renderReleasePlan(){
    const box = document.getElementById('releasePlanBody');
    const { groups } = releasePlanModel();

    if (!groups.length) {
        box.innerHTML = EmptyState({
            panel: true,
            message: 'No release lines yet. Mark the MVP’s issues in Jira with the label release:R1 (and later lines release:R2, …), or choose another convention in Settings → Jira.',
        });
        return;
    }

    box.innerHTML = html`${groups.map(g => ReleasePlanGroup({
        title: g.title,
        groupKey: g.key,
        outcome: g.outcome,
        mvpReleased: g.mvpReleased,
        problems: g.problems,
        lines: g.lines.map(l => ReleaseLineCard({
            id: l.id,
            name: l.name,
            isMvp: l.id === g.mvp,
            released: l.released,
            onProdCount: l.onProdCount,
            total: l.items.length,
            items: l.items.map(i => ReleasePlanItem({
                itemKey: i.key,
                href: jiraIssueUrl(i.key),
                title: i.title,
                type: i.type || null,
                pill: StatusPill({
                    cls: statusClass(i.prodLevel),
                    label: i.prod.uncertain.length ? `${statusLabel(i.prodLevel)}?` : statusLabel(i.prodLevel),
                    title: `PROD: ${statusLabelTooltip(i.prodLevel)}`,
                    alert: i.prod.mismatch.length > 0,
                }),
            })),
        })),
        flags: g.flags.map(f => ReleasePlanFlag({
            flagKey: f.key,
            rolloutText: flagRolloutText(f),
            ...flagStageTexts(f),
            owner: f.owner,
            removeByText: f.removeBy ? (f.overdue ? `${f.daysPastRemoveBy} day${f.daysPastRemoveBy === 1 ? '' : 's'} past remove-by (${f.removeBy})` : `remove by ${f.removeBy}`) : '',
            overdue: f.overdue,
        })),
    }))}`;
}
