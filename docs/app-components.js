// Presentational components: pure functions that take plain values and return an `html` result. They hold
// markup only — no `state`, no DOM access, no data lookups; every value they show arrives as a parameter, and
// "children"/slots are other components' `html` results. Views (app-product.js, app-technical.js,
// app-release-notes.js, app-insights.js, app-model.js) decide *what* to show; this file decides how it looks,
// so moving to a framework later means rewriting this one file's bodies, not the views' logic.
//
// Loaded after app-core.js (some components read `ICONS`) and before every view. Atoms (Tag, StatusPill, …)
// come first, molecules built from them after, grouped by the view that uses them. Naming: PascalCase, one
// props object per component. Strings go in as plain strings (escaped by `html`); pre-built markup goes in as
// `html` results; only fixed developer-authored constants (`ICONS.*`) are wrapped in `raw()` here.

/** Joins truthy class names with a space — keeps optional modifiers from leaving stray double spaces. */
function classNames(...parts){
    return parts.filter(Boolean).join(' ');
}

/* ---------- Atoms ---------- */

/** Small label chip. With `icon` (an `ICONS` entry) it becomes the icon-plus-text `.tag-flagged` layout. */
function Tag({ text, cls = '', title = '', icon = null }){
    const titleAttr = title ? html` title="${title}"` : '';

    if (icon) {
        return html`<span class="${classNames('tag', 'tag-flagged', cls)}"${titleAttr}>${raw(icon)}<span>${text}</span></span>`;
    }

    return html`<span class="${classNames('tag', cls)}"${titleAttr}>${text}</span>`;
}

function SprintTag({ sprint }){
    return html`<span class="sprint-tag" title="Jira sprint">${sprint}</span>`;
}

/** Environment-status pill ("Released", "Deployed (hidden)", …); `title` is the plain-English tooltip. */
function StatusPill({ cls, label, title }){
    return html`<span class="status-pill ${cls}" title="${title}">${label}</span>`;
}

function StatusDot({ status }){
    return html`<span class="status-dot status-${status}"></span>`;
}

function ComponentAvatar({ kind }){
    return html`<span class="comp-avatar">${kind}</span>`;
}

function MetaDot(){
    return html`<span class="deploy-meta-dot"></span>`;
}

function MonoText({ text }){
    return html`<span class="mono">${text}</span>`;
}

/** True for an absolute `https://` URL whose host part has no user info: escaping alone would still let
 *  `javascript:…` or `https://github.com@evil.example/` through as a working link. */
function isSafeHttpsUrl(href){
    return typeof href === 'string' && /^https:\/\/[^\s\/?#\\@]+(?:[\/?#][^\s]*)?$/i.test(href);
}

/** Same `<a target=_blank>` everywhere; `stopClick` (data-stop-click, handled in app-main.js: no inline handlers,
 *  for the page's Content-Security-Policy) keeps a click from also triggering the clickable row/card the link sits
 *  in. Without a safe `href` (a Jira key before Jira is connected, or anything but https) the same text, unlinked. */
function ExternalLink({ href, cls = '', stopClick = false, title = '', children }){
    const classAttr = cls ? html` class="${cls}"` : '';
    const titleAttr = title ? html` title="${title}"` : '';
    if (!isSafeHttpsUrl(href)) {
        return html`<span${classAttr}${titleAttr}>${children}</span>`;
    }
    const clickAttr = stopClick ? raw(' data-stop-click') : '';

    return html`<a${classAttr} href="${href}" target="_blank" rel="noopener noreferrer"${clickAttr}${titleAttr}>${children}</a>`;
}

/** A version label that links to its commit/compare range when there is one, else plain text. */
function VersionLink({ version, url = '', stopClick = false }){
    return url ? ExternalLink({ href: url, stopClick, children: version }) : html`${version}`;
}

function IssueBadge({ issueKey, href, stopClick = false }){
    return ExternalLink({ href, cls: 'issue-badge', stopClick, children: issueKey });
}

function ResolvedFlagBadge({ flagKey, on }){
    return html`<span class="resolved-flag-badge ${on ? 'rf-on' : 'rf-off'}">${flagKey}: ${on ? 'ON' : 'OFF'}</span>`;
}

/** Grey pill. `withIcon` adds the cursor glyph used for "Manual" deploys; without it the same look doubles as a
 *  plain component chip. */
function ManualBadge({ text = 'Manual', withIcon = false }){
    return html`<span class="manual-badge">${withIcon ? raw(ICONS.manual) : ''}${text}</span>`;
}

function RollbackBadge({ toRef }){
    return html`<span class="rollback-badge" title="moved this environment back to an earlier commit (${toRef})">${raw(ICONS.rewind)} rollback</span>`;
}

function RunBadge({ url }){
    return ExternalLink({ href: url, cls: 'run-badge', stopClick: true, title: 'View workflow run', children: raw(ICONS.external) });
}

/** `icon` is a ready-made SVG string (see `envBadgeIcon()` in app-core.js). */
function EnvBadge({ env, icon }){
    return html`<span class="env-badge">${raw(icon)}${env.toUpperCase()}</span>`;
}

/** "Name" or, when the raw login differs from the shown name, "Name" with the login as its tooltip. */
function AuthorLabel({ name, login = '' }){
    return login && login !== name ? html`<span title="@${login}">${name}</span>` : html`${name}`;
}

function EmptyState({ message, panel = false }){
    return html`<div class="${classNames('empty', panel && 'panel')}">${message}</div>`;
}

/** Infinite-scroll marker observed by the lazy-pagination code. */
function LoadMoreSentinel({ id }){
    return html`<div class="load-more-sentinel" id="${id}">Loading more…</div>`;
}

/** "<n> item(s)" counter used above the Product view and Release Notes lists. */
function ItemCount({ count }){
    return html`<span class="pv-count-num">${count}</span> item${count === 1 ? '' : 's'}`;
}

/** Joins the pieces of a .deploy-meta line (time / author / duration / "N deploys" toggle, ...) with a
 *  `.deploy-meta-dot` separator instead of a plain "·" character — falsy parts are dropped first so a
 *  missing duration doesn't leave a dangling dot. Each part is an `html` result (kept as-is) or a plain
 *  string (escaped), so a raw author name can be passed straight in. */
function joinMeta(parts){
    return html`${parts.filter(Boolean).map((p, i) => (i === 0 ? p : html`${MetaDot()}${p}`))}`;
}

/* ---------- Summary cards (Technical view, Release Notes) ---------- */

/** `tone`: '' (neutral), 'warn' or 'ok' — colors the note next to the value. */
function SummaryCard({ label, value, note, tone = '' }){
    return html`
    <div class="summary-card">
      <div class="summary-label">${label}</div>
      <div class="summary-value">${value} <span class="${classNames('summary-note', tone && `summary-note-${tone}`)}">${note}</span></div>
    </div>`;
}

/* ---------- Product view ---------- */

/** "Current PI" snapshot card: name, an on-prod progress fill and the item counts. */
function PiCard({ name, isCurrent, total, onProd, onProdPct }){
    return html`
    <div class="pv-pi-card">
      <div class="pv-pi-top">
        <span class="pv-pi-name">${name || '—'}</span>
        ${isCurrent ? html`<span class="pv-pi-current-tag">current PI</span>` : ''}
      </div>
      <div class="pv-pi-bar">
        ${onProd ? html`<div class="pv-pi-bar-seg" style="width:${onProdPct}%"></div>` : ''}
      </div>
      <div class="pv-pi-meta"><span><b>${total}</b> item${total === 1 ? '' : 's'}</span>${MetaDot()}<span><b>${onProd}/${total}</b> on prod</span></div>
    </div>`;
}

function StatusTile({ tileKey, label, color, value, percent }){
    return html`
      <div class="pv-tile" data-tile-key="${tileKey}">
        <div class="pv-tile-top"><span class="pv-tile-swatch" style="background:${color}"></span><span class="pv-tile-label">${label}</span></div>
        <div class="pv-tile-bottom"><span class="pv-tile-value">${value}</span><span class="pv-tile-total">${percent}% of items</span></div>
      </div>`;
}

/** One deployed/flag cell in the per-component breakdown table. */
function DotCell({ yes, yesLabel, noLabel }){
    return html`<td>${yes
        ? html`<span class="dot-yes">●</span> ${yesLabel}`
        : html`<span class="dot-no">○</span> <span class="muted-label">${noLabel}</span>`}</td>`;
}

/** `envs` is `[{ deployed, flagOn }]` in TEST, QA, PROD order. */
function BreakdownRow({ component, flagKey, envs }){
    return html`<tr>
              <td><b>${component}</b></td>
              <td class="mono">${flagKey}</td>
              ${envs.map(e => html`${DotCell({ yes: e.deployed, yesLabel: 'deployed', noLabel: 'not found' })}${DotCell({ yes: e.flagOn, yesLabel: 'ON', noLabel: 'OFF' })}`)}
            </tr>`;
}

/** Expanded per-component code/flag breakdown under an open issue row. `rows` are `BreakdownRow` props;
 *  with none, `noFlagReason` explains why instead. `dependency` is `{ note }` or null. */
function IssueBreakdown({ issueKey, rows, noFlagReason, dependency = null }){
    return html`<div class="breakdown">
        ${rows.length ? html`
        <table class="breakdown-table">
          <thead><tr><th>Component</th><th>Flag</th><th>TEST code</th><th>TEST flag</th><th>QA code</th><th>QA flag</th><th>PROD code</th><th>PROD flag</th></tr></thead>
          <tbody>
          ${rows.map(BreakdownRow)}
          </tbody>
        </table>
        <div class="breakdown-hint">"Not found" means no successful deployment of that component carried a commit referencing ${issueKey} yet.</div>
        ` : html`<div class="breakdown-row" style="justify-content:flex-start;">No flag linked to ${issueKey} — ${noFlagReason}</div>`}
        ${dependency ? html`<div class="breakdown-row"><span>Blocking dependency</span><span style="color:var(--blocked)">${dependency.note}</span></div>` : ''}
    </div>`;
}

/** One env column of a work-item row: status pill plus the relative date (or dependency note) under it. */
function StatusCell({ pill, dateText }){
    return html`
      <div>
        ${pill}
        <div class="status-date">${dateText}</div>
      </div>`;
}

/** A work-item row. `badges` = the tags after type/key; `cells` = three `StatusCell` results (TEST/QA/PROD);
 *  `title` empty = the Jira title isn't available; `breakdown` = open-row details or ''. */
function IssueRow({ rowClass, issueKey, href, title, type, badges, cells, breakdown = '' }){
    const titleHtml = title
        ? html`${title}`
        : html`<span style="color:var(--nd-fg-4); font-style:italic; font-weight:400;">title unavailable (Jira access pending)</span>`;

    return html`
    <div class="wi-row ${rowClass}" data-key="${issueKey}">
      <div>
        ${ExternalLink({ href, cls: 'wi-title wi-child-title', stopClick: true, children: titleHtml })}
        <div class="wi-child-meta">
          <span class="wi-type">${type}</span>
          ${Tag({ text: issueKey, cls: 'mono' })}
          ${badges}
        </div>
      </div>
      ${cells}
    </div>
    ${breakdown}
    `;
}

function EpicChevron({ hasChildren, collapsed }){
    return hasChildren
        ? html`<span class="wi-epic-chevron${collapsed ? '' : ' open'}">${raw(ICONS.chevron)}</span>`
        : html`<span class="wi-epic-chevron-empty" title="No linked work items">–</span>`;
}

/** "N/M released to prod" bar. `progress` = `{ released, code, total }`, or null for an empty placeholder. */
function EpicProgress({ progress }){
    if (!progress) {
        return html`<div class="wi-epic-progress"></div>`;
    }

    const { released, code, total } = progress;

    return html`
      <div class="wi-epic-progress${released > 0 && released < total ? ' wi-epic-partial' : ''}">
        <div class="wi-epic-bar" title="${code} deployed, ${released} released, ${total - released - code} other"><div class="wi-epic-bar-fill wi-epic-bar-code" style="width:${((released + code) / total * 100).toFixed(1)}%"></div><div class="wi-epic-bar-fill wi-epic-bar-released" style="width:${(released / total * 100).toFixed(1)}%"></div></div>
        <div class="wi-epic-progress-label"><b>${released}/${total}</b> released to prod</div>
      </div>`;
}

/** An Epic section header. `badges` = the tags after type/key; `progress` as in `EpicProgress`. */
function EpicHeader({ epicKey, href, title, hasChildren, collapsed, badges, progress }){
    return html`
    <div class="wi-row wi-epic-row${hasChildren ? '' : ' wi-epic-row-empty'}" data-epic-key="${epicKey}">
      <div class="wi-epic-cell">
        ${EpicChevron({ hasChildren, collapsed })}
        <div class="wi-epic-stack">
          ${ExternalLink({ href, cls: 'wi-title wi-epic-title', stopClick: true, children: title })}
          <div class="wi-epic-badges">
            <span class="wi-type">Epic</span>
            ${Tag({ text: epicKey, cls: 'mono' })}
            ${badges}
          </div>
        </div>
      </div>
      ${EpicProgress({ progress })}
    </div>`;
}

function UngroupedLabelRow(){
    return html`<div class="wi-ungrouped-label-row">Ungrouped</div>`;
}

/* ---------- Technical view: matrix ---------- */

function EnvStatusNote({ text, warn = false }){
    return html`<span class="${classNames('env-status-note', warn && 'env-status-warn')}">${text}</span>`;
}

/** Title row of an env card; `icon` is the `barsIcon()` SVG string, `note` an `EnvStatusNote`. */
function EnvCardHeader({ env, icon, serviceCount, note }){
    return html`
      <div class="env-title-row">
        <div class="env-title">${raw(icon)}${env}<span class="env-count">${serviceCount} service${serviceCount === 1 ? '' : 's'}</span></div>
        ${note}
      </div>`;
}

function FlagsNotTrackedIcon(){
    return html`<span class="flags-not-tracked-icon" title="Feature flags for this component aren't tracked in the Flags panel below yet — check with the owning team directly.">${raw(ICONS.flag)}</span>`;
}

/** Avatar plus name block of a matrix row. `.comp-name` is the flex row: avatar on the left, then a plain
 *  block "stack" holding the name line (and, once there's a deploy, `subline` underneath it) — the avatar never
 *  becomes part of that stack, so the version lines up under the name's own left edge. Only the name text
 *  truncates (`.comp-name-text`); the "flags not tracked" icon is a `flex:none` sibling so that warning
 *  stays visible even for a long component name. */
function ComponentName({ name, kind, description = '', flagsNotTracked = false, subline = '' }){
    const titleAttr = description ? html` title="${description}"` : '';

    return html`
        <div class="comp-name"${titleAttr}>
          ${ComponentAvatar({ kind })}
          <div class="comp-name-stack"><span class="comp-name-line"><span class="comp-name-text">${name}</span>${flagsNotTracked ? FlagsNotTrackedIcon() : ''}</span>${subline}</div>
        </div>`;
}

function RelTime({ text }){
    return html`<div class="rel-time">${text}</div>`;
}

function ComponentNotDeployedMeta(){
    return html`<div class="comp-meta">${RelTime({ text: 'not deployed' })}</div>`;
}

function ComponentDeployedMeta({ status, version, driftNote = '' }){
    return html`
        <div class="comp-meta">
          <div class="version">${StatusDot({ status })}${version}</div>
          ${driftNote}
        </div>`;
}

/** The single drift control of a matrix cell. `data-*` is read back by the click handler; `diffJson` is the
 *  JSON string of `driftBehind.diff`. */
function DriftNoteButton({ env, behind, skipped, sameVersion, diffJson }){
    const data = html`data-env="${env}" data-behind="${behind}" data-skipped="${skipped}" data-same-version="${sameVersion ? '1' : ''}" data-diff="${diffJson}"`;

    return html`<button type="button" class="drift-info-btn drift-note" title="Diff to ${env} — click for details" ${data}>${raw(ICONS.warn)} Diff to ${env}</button>`;
}

/** Plain `.drift-note` line (Flags panel): "possibly stale", "diverges from build default". */
function DriftNote({ text, title = '' }){
    const titleAttr = title ? html` title="${title}"` : '';

    return html`<div class="drift-note"${titleAttr}>${text}</div>`;
}

/** One section of the drift modal. `paths` are the first differing files; `more` how many were cut off. */
function DriftModalSection({ title, counts = '', paths = [], more = 0, text, cls = '' }){
    return html`<section class="${classNames('drift-modal-section', cls)}"><h4>${title}</h4>${counts ? html`<p class="drift-modal-counts">${counts}</p>` : ''}${paths.length ? html`<ul class="drift-modal-paths">${paths.map(p => html`<li>${p}</li>`)}${more ? html`<li>… and ${more} more</li>` : ''}</ul>` : ''}<p class="drift-modal-text">${text}</p></section>`;
}

/** `sections` are `DriftModalSection` props. */
function DriftModalContent({ headTitle, component = '', sections }){
    return html`
        <div class="drift-modal-head"><h3>${raw(ICONS.warn)} <span>${headTitle}${component ? html` <span class="drift-modal-service">${component}</span>` : ''}</span></h3><button type="button" class="drift-modal-close" aria-label="Close" data-close-dialog>×</button></div>
        ${sections.map(DriftModalSection)}`;
}

/** Label + effective value of a flag in a matrix env card. `kind`: 'on' | 'off' | 'missing'. */
function FlagStateText({ kind, title = '', cls = '' }){
    const text = kind === 'on' ? 'ON' : kind === 'off' ? 'OFF' : '—';
    const stateCls = kind === 'on' ? 'flag-on-text' : kind === 'off' ? 'flag-off-text' : 'flag-missing-text';
    const titleAttr = title ? html` title="${title}"` : '';

    return html`<span class="${classNames('flag-row-state', stateCls, cls)}"${titleAttr}>${text}</span>`;
}

function FlagRowContent({ name, state }){
    return html`<span class="flag-row-name">${name}</span>${state}`;
}

function InfoTip({ text }){
    return html`<span class="info-tip" title="${text}">${raw(ICONS.info)}</span>`;
}

/* ---------- Technical view: deployment history ---------- */

function DayHead({ label }){
    return html`<div class="dh-day-head">${label}</div>`;
}

/** Ticket + flag-flip chips of a deploy card. `flagBadges` = `{ flagKey: on }`. '' when there's nothing. */
function DeployChips({ issues, flagBadges }){
    const issueChips = issues.map(i => IssueBadge({ issueKey: i.key, href: i.href, stopClick: true }));
    const flagChips = Object.entries(flagBadges).map(([k, v]) => ResolvedFlagBadge({ flagKey: k, on: !!v }));

    if (!issueChips.length && !flagChips.length) {
        return '';
    }

    return html`<div class="deploy-chips">${issueChips}${flagChips}</div>`;
}

/** Shared card frame: `left` / `right` header halves, a `meta` line, optional `extra` block and `chips`. */
function DeployCard({ left, right, meta, extra = '', chips = '' }){
    return html`
    <div class="deploy-item">
      <div class="deploy-top">
        <div class="deploy-left">${left}</div>
        <div class="deploy-right">${right}</div>
      </div>
      <div class="deploy-meta">${meta}</div>
      ${extra}
      ${chips}
    </div>`;
}

/** Left half of a deploy card's header: avatar, status dot, service, arrow, version. */
function DeployCardTitle({ kind, status, component, version }){
    return html`
          ${ComponentAvatar({ kind })}
          ${StatusDot({ status })}
          <span class="deploy-comp">${component}</span>
          <span class="version-arrow">${raw(ICONS.arrowRight)}</span>
          <span class="version">${version}</span>`;
}

function DeployGroupToggle({ groupKey, count, open }){
    return html`<button type="button" class="deploy-group-toggle${open ? ' open' : ''}" data-group-key="${groupKey}">${count} deploys ${raw(ICONS.chevronDown)}</button>`;
}

/** One run inside an expanded grouped-deploy card. */
function DeployGroupItem({ status, timeText, durationText = '', manual = false, runUrl = '' }){
    return html`
        <div class="deploy-group-item">
          ${StatusDot({ status })}${timeText}
          ${durationText ? html`· ${durationText}` : ''}
          ${manual ? ManualBadge({}) : ''}
          ${runUrl ? RunBadge({ url: runUrl }) : ''}
        </div>`;
}

function DeployGroupList({ items }){
    return html`<div class="deploy-group-list">${items.map(DeployGroupItem)}</div>`;
}

/** "New flag" event card in the timeline. */
function FlagAddedCard({ name, timeText, components }){
    return html`
    <div class="flag-added-item">
      <div class="deploy-top">
        <div class="deploy-left">
          <span class="flag-event-icon">${raw(ICONS.flag)}</span>
          <span class="flag-new-name">${name}</span>
          <span class="flag-new-pill">New flag</span>
        </div>
      </div>
      <div class="deploy-meta">${joinMeta([
          MonoText({ text: timeText }),
          'first discovered — no earlier state for this flag exists',
      ])}</div>
      ${components.length ? html`<div class="deploy-chips">${components.map(c => ManualBadge({ text: c }))}</div>` : ''}
    </div>`;
}

/* ---------- Technical view: flags panel ---------- */

/** One label/value line inside a flag's Details drawer; `value` is an already-built `html` fragment. */
function flagDetailLine(label, value){
    return html`<div class="ff-detail"><span>${label}</span><div class="ff-detail-value">${value}</div></div>`;
}

/** Grey "nothing here" pill used in the Details drawer (same look as the Manual badge). */
function flagNoneBadge(text){
    return html`<span class="ff-none">${text}</span>`;
}

function FlagsColumnHeader({ labels }){
    return html`<div class="ff-cols"><span>Flag</span>${labels.map(l => html`<span>${l}</span>`)}</div>`;
}

function BlastRadiusWarning({ keys }){
    return html`<div class="blast-radius-warning">⚠ shares this flag with unfinished work (${keys.join(', ')}) — enabling it releases those too</div>`;
}

/** The Details drawer body. `issues` = `[{ key, href }]`, `components` = names, `added` = a formatted date or ''. */
function FlagDetails({ description, issues, components, added }){
    return html`
        ${description ? html`<span class="ff-desc">${description}</span>` : html`<span class="ff-desc ff-desc--empty">No description provided</span>`}
        ${flagDetailLine('Issue', issues.length
            ? issues.map(i => IssueBadge({ issueKey: i.key, href: i.href }))
            : flagNoneBadge('Not linked'))}
        ${flagDetailLine('Components', components.length
            ? html`<span class="ff-text">${components.join(', ')}</span>`
            : flagNoneBadge('Not used in any component'))}
        ${flagDetailLine('Added', added ? html`<span class="ff-text">${added}</span>` : flagNoneBadge('—'))}`;
}

/** One flag row: name + type + Details toggle + warning `notes`, the per-env `states`, and the `details` drawer. */
function FlagRow({ name, typeLabel, open, notes, states, details }){
    return html`
    <div class="ff-row" data-flag="${name}">
      <div class="ff-name-stack">
        <span class="ff-name" title="${name}">${name}</span>
        <div class="ff-meta">
          <span>${typeLabel}</span>
          ${MetaDot()}
          <button type="button" class="deploy-group-toggle${open ? ' open' : ''}" aria-expanded="${open}" aria-label="${open ? 'Hide' : 'Show'} details for ${name}">Details ${raw(ICONS.chevronDown)}</button>
        </div>
        ${notes}
      </div>
      ${states}
      <div class="ff-details" ${open ? '' : 'hidden'}>${details}
      </div>
    </div>`;
}

/* ---------- Release Notes ---------- */

/** One shipped item: type, linked title, PROD `pill`, then key + first-prod date. */
function ReleaseNoteItem({ type, href, title, pill, issueKey, dateText = '' }){
    return html`
        <div class="release-note-item">
          <span class="issue-type">${type}</span>
          <div class="release-note-main">
            <div class="release-note-title-wrap">
              ${ExternalLink({ href, cls: 'release-note-title', children: title })}
              ${pill}
            </div>
            <div class="release-note-meta">${joinMeta([
                Tag({ text: issueKey, cls: 'mono' }),
                dateText ? MonoText({ text: dateText }) : null,
            ])}</div>
          </div>
        </div>`;
}

function ReleaseNotesCategory({ label, items }){
    return html`
          <div class="release-notes-category">
            <div class="release-notes-category-label">${label}</div>
            ${items}
          </div>`;
}

function ReleaseNotesSprint({ title, categories }){
    return html`
        <div class="release-notes-sprint">
          <div class="release-notes-sprint-head">
            <span class="release-notes-sprint-title">${title}</span>
          </div>
          ${categories}
        </div>`;
}

function ReleaseNotesPi({ pi, sprints }){
    return html`
      <div class="release-notes-pi">
        <div class="release-notes-pi-head">
          <h2>${pi}</h2>
        </div>
        ${sprints}
      </div>`;
}

function PanelBody({ children }){
    return html`
    <div class="panel">
      <div class="panel-body">${children}</div>
    </div>`;
}

/* ---------- Insights charts ---------- */

/** `items` = `[{ cls, label }]` (swatch class + text). */
function ChartLegend({ items }){
    return html`<div class="chart-legend">${items.map(s => html`<span><span class="chart-legend-swatch ${s.cls}"></span>${s.label}</span>`)}</div>`;
}

function BarSegment({ cls, widthPct, title }){
    return html`<div class="bar-segment ${cls}" style="width:${widthPct.toFixed(1)}%" title="${title}"></div>`;
}

/** Horizontal bar row: label, a track holding `segments`, and the value text on the right. */
function BarRow({ label, valueText, segments }){
    return html`
        <div class="bar-row">
          <div class="bar-row-label" title="${label}">${label}</div>
          <div class="bar-track">${segments}</div>
          <div class="bar-row-count">${valueText}</div>
        </div>`;
}

/** `bars` = `[{ cls, height, title }]` (height in px). */
function ColumnChartColumn({ label, bars }){
    return html`
      <div class="col-chart-col">
        <div class="col-chart-bars">
          ${bars.map(b => html`<div class="col-bar ${b.cls}" style="height:${b.height}px" title="${b.title}"></div>`)}
        </div>
        <div class="col-chart-label">${label}</div>
      </div>`;
}

function ColumnChart({ columns }){
    return html`<div class="col-chart">${columns}</div>`;
}
