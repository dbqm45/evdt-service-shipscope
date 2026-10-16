function switchToTab(view){
    document.querySelectorAll('.tab').forEach(t=> t.classList.remove('active'));
    document.querySelectorAll('.view').forEach(v=> v.classList.remove('active'));
    document.querySelector(`.tab[data-view="${view}"]`).classList.add('active');
    document.getElementById('view-' + view).classList.add('active');
    // Technical view has nothing scoped per-PI (component × environment matrix, deployment timeline, flat
    // flag list) — the global PI selector would be a dead control there, so it's hidden rather than shown
    // but inert.
    document.getElementById('globalPiSelectWrap').style.display = view === 'tech' ? 'none' : '';
    // The Sprint scope control only ever affects Product view (issuesInSprintScope() is read by
    // piWorkItemCounts()/renderIssues() alone — see CLAUDE.md's Frontend section) — unlike the PI
    // selector, which Release Notes and Insights also read. Shown only there, same reasoning as above.
    document.getElementById('sprintSelectWrap').style.display = view === 'product' ? '' : 'none';
}

/**
 * Populates and wires the one PI selector shared by Product view, Release Notes, and Insights (see
 * CLAUDE.md's Jira issues section — all three now render "one PI at a time"). Options come from
 * `state.jiraIndex.pis` (already sorted newest-first, same order sync-jira.js wrote them in); the
 * server-resolved `currentPi()` gets a visible marker so switching away and back is obvious. On change,
 * fetches the newly-selected PI's shard, swaps it into `state.jiraIssues`/`state.selectedPi`, then
 * refreshes+resets both tabs' filters (reusing their own Clear buttons, so there's exactly one place
 * that knows how to reset each tab's filter UI) before re-rendering everything that reads `state.jiraIssues`.
 */
function initGlobalPiSelect(){
    const sel = document.getElementById('globalPiSelect');

    (state.jiraIndex.pis || []).forEach(entry => {
        const o = document.createElement('option');

        o.value = entry.pi;
        const label = entry.label || entry.pi;

        o.textContent = entry.pi === currentPi() ? `${label} (current)` : label;
        sel.appendChild(o);
    });

    sel.value = state.selectedPi || '';

    sel.addEventListener('change', async () => {
        // "Latest request wins" guard against a real race: switching the PI select twice in quick
        // succession fires two overlapping loadJiraIssuesForPi() calls, and nothing guarantees they
        // resolve in the order they were sent — a slower first fetch resolving *after* a faster second
        // one would otherwise silently overwrite state.jiraIssues/selectedPi with stale data while the
        // <select> itself already shows the newer selection. Re-checking sel.value after the await
        // discards a response that's no longer the user's current selection by the time it arrives.
        const requestedPi = sel.value;
        const issues = await loadJiraIssuesForPi(requestedPi);

        if (sel.value !== requestedPi) {
            return;
        }

        state.jiraIssues = issues;
        state.selectedPi = requestedPi;

        refreshSprintSelect();
        refreshProductViewFilterOptions();
        document.getElementById('btnClearFilters').click();

        refreshReleaseNotesFilterOptions();
        document.getElementById('btnClearNotesFilters').click();

        if (INSIGHTS_ENABLED) {
            renderInsights();
        }
    });
}

function initTabs(){
    switchToTab(DEFAULT_VIEW);

    if (!INSIGHTS_ENABLED) {
        document.querySelector('.tab[data-view="insights"]').remove();
    } else {
        document.querySelector('.tab[data-view="insights"]').style.display = '';
    }

    document.querySelectorAll('.tab').forEach(tab=>{
        tab.onclick = ()=> switchToTab(tab.dataset.view);
    });
}

/**
 * Replaces the browser's native `title` tooltip (plain, unstyled, slow, one fixed look) with a styled one
 * matching the drift modal. Every `title` in the document is moved into `data-tip` and the attribute
 * removed *up front* (and again whenever one is added or reassigned, via a MutationObserver), so the
 * native tooltip can never show — swapping it only on hover and restoring it afterwards let the native one
 * leak through whenever the title came back under a still-hovering pointer (after a click or scroll, or
 * moving between nested titled elements). An empty/cleared title (`el.title = ''`) removes the tip.
 * Text is set via `textContent`, never HTML, and `\n` in it is kept as a line break
 * (`white-space:pre-line`).
 */
function initTooltips(){
    const tip = document.createElement('div');
    const SHOW_DELAY_MS = 250;
    const MARGIN = 8;
    let current = null;
    let timer = null;

    tip.className = 'app-tooltip';
    tip.setAttribute('role', 'tooltip');
    document.body.appendChild(tip);

    function absorbTitle(el){
        if (!el.hasAttribute || !el.hasAttribute('title')) {
            return;
        }

        const text = el.getAttribute('title');

        el.removeAttribute('title');

        if (text) {
            el.dataset.tip = text;

            // An icon-only control (no text, no aria-label) was named by its title — keep it accessible.
            if (!el.hasAttribute('aria-label') && !(el.textContent || '').trim()) {
                el.setAttribute('aria-label', text);
            }
        } else {
            delete el.dataset.tip;
        }
    }

    function absorbTree(root){
        if (root.nodeType !== 1) {
            return;
        }

        absorbTitle(root);
        root.querySelectorAll('[title]').forEach(absorbTitle);
    }

    function hide(){
        clearTimeout(timer);
        tip.classList.remove('show');
        current = null;
    }

    function show(el){
        const root = document.documentElement;
        const r = el.getBoundingClientRect();

        tip.textContent = el.dataset.tip;
        tip.style.left = '0px';
        tip.style.top = '0px';
        tip.classList.add('show');

        const t = tip.getBoundingClientRect();
        const left = Math.max(MARGIN, Math.min(r.left + r.width / 2 - t.width / 2, root.clientWidth - t.width - MARGIN));
        const below = r.bottom + MARGIN;
        const top = below + t.height > root.clientHeight - MARGIN ? Math.max(MARGIN, r.top - t.height - MARGIN) : below;

        tip.style.left = `${left}px`;
        tip.style.top = `${top}px`;
    }

    absorbTree(document.documentElement);

    if (typeof MutationObserver === 'function') {
        new MutationObserver(records => records.forEach(rec => {
            if (rec.type === 'attributes') {
                absorbTitle(rec.target);
            } else {
                rec.addedNodes.forEach(absorbTree);
            }
        })).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['title'] });
    }

    document.addEventListener('mouseover', e => {
        const el = e.target && e.target.closest ? e.target.closest('[data-tip]') : null;

        if (el === current) {
            return;
        }

        hide();

        if (el) {
            current = el;
            timer = setTimeout(() => show(el), SHOW_DELAY_MS);
        }
    });
    document.addEventListener('mouseout', e => {
        if (current && !(e.relatedTarget && current.contains(e.relatedTarget))) {
            hide();
        }
    });
    // A click (e.g. opening the drift modal) or scroll leaves the tooltip pointing at the wrong place.
    document.addEventListener('click', hide, true);
    document.addEventListener('scroll', hide, true);
}

async function init(){
    initTabs();
    initTooltips();
    state = await loadData();

    state.selectedPi = state.jiraIndex.currentPi
        || (state.jiraIndex.pis[0] && state.jiraIndex.pis[0].pi)
        || null;
    state.jiraIssues = await loadJiraIssuesForPi(state.selectedPi);

    initGlobalPiSelect();
    refreshSprintSelect();
    initProductView();

    const sel = document.getElementById('filterEnv');

    ENVIRONMENTS.forEach(env=> {
        const o=document.createElement('option');
        o.value = env;
        o.textContent = env.toUpperCase();
        sel.appendChild(o);
    });
    sel.onchange = resetDeployPagination;

    const compSel = document.getElementById('filterComponent');

    [...new Set(state.deployments.map(d=> d.component))].sort().forEach(comp=> {
        const o=document.createElement('option');
        o.value = comp;
        o.textContent = comp;
        compSel.appendChild(o);
    });
    compSel.onchange = resetDeployPagination;

    const rangeSel = document.getElementById('filterDeployRange');

    rangeSel.onchange = resetDeployPagination;

    document.getElementById('btnClearDeployFilters').onclick = () => {
        compSel.value = '';
        sel.value = '';
        // Resets to this view's own default (last 90 days), not "no restriction" — unlike
        // service/environment, where "no restriction" *is* the default.
        rangeSel.value = '90';
        resetDeployPagination();
    };

    document.getElementById('filterFlagSource').onchange = renderFlags;

    document.getElementById('timeline').addEventListener('scroll', function(){
        if (this.scrollTop + this.clientHeight >= this.scrollHeight - 100) {
            const savedScroll = this.scrollTop;

            visibleDeployCount += DEPLOY_PAGE_SIZE;
            renderTimeline();
            this.scrollTop = savedScroll;
        }
    });

    renderSummaryCards();
    renderMatrix();
    renderTimeline();
    renderFlags();
    renderProductSummary();
    renderIssues();

    initReleaseNotesFilters();
    renderReleaseNotes();

    if (INSIGHTS_ENABLED) {
        renderInsights();
    }
}
const FALLBACK = buildFallbackData();

init();