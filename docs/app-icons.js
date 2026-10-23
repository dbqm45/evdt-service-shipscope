// Icons: fixed, developer-authored inline SVGs, each already a raw() value, so they go straight into `html`
// templates (a forgotten raw() can no longer show an icon as escaped text). No DOM access; loaded right after
// app-html.js (raw()) and before app-core.js.

/** Small inline SVGs reused across env/deployment badges — kept tiny, same spirit as the header's own
 *  logo mark. `external`/`manual`/`chevron` use stroke/fill:currentColor so they inherit whatever color
 *  context they're placed in; the environment "bars" icon is the one exception (see barsIcon() below) —
 *  its lit bars are always literal white, everywhere it's used, so it can't be recolored by context. */
const ICONS = Object.freeze({
    external: raw('<svg viewBox="0 0 16 16" width="11" height="11" fill="none" aria-hidden="true"><path d="M6.5 3H4A1.5 1.5 0 0 0 2.5 4.5v7A1.5 1.5 0 0 0 4 13h7a1.5 1.5 0 0 0 1.5-1.5V9M9.5 2.5H13v3.5M13 2.5 7.5 8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>'),
    manual: raw('<svg viewBox="0 0 16 16" width="10" height="10" fill="currentColor" aria-hidden="true"><path d="M3 1.5l9.5 4.2-3.6.9 2.4 4.1-1.7 1-2.4-4.1-2.6 2.7z"/></svg>'),
    chevron: raw('<svg viewBox="0 0 16 16" width="10" height="10" fill="none" aria-hidden="true"><path d="M5.5 3l5 5-5 5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>'),
    copy: raw('<svg viewBox="0 0 16 16" width="12" height="12" fill="none" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.6" stroke="currentColor" stroke-width="1.3"/><path d="M10.5 3.5v-.4A1.6 1.6 0 0 0 8.9 1.5H4.1a1.6 1.6 0 0 0-1.6 1.6v4.8a1.6 1.6 0 0 0 1.6 1.6h.4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>'),
    chevronDown: raw('<svg viewBox="0 0 16 16" width="10" height="10" fill="none" aria-hidden="true"><path d="M3 6l5 5 5-5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>'),
    warn: raw('<svg viewBox="0 0 16 16" width="12" height="12" fill="none" aria-hidden="true"><path d="M8 2.3 14.3 13a1 1 0 0 1-.87 1.5H2.57A1 1 0 0 1 1.7 13L8 2.3Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M8 6.5v3.2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><circle cx="8" cy="11.8" r="0.9" fill="currentColor"/></svg>'),
    flag: raw('<svg viewBox="0 0 16 16" width="12" height="12" fill="none" aria-hidden="true"><path d="M3.5 2v12M3.5 2.8h8l-2 2.7 2 2.7h-8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>'),
    info: raw('<svg viewBox="0 0 16 16" width="12" height="12" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.2"/><path d="M8 7.2v4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><circle cx="8" cy="5.1" r="0.9" fill="currentColor"/></svg>'),
    rewind: raw('<svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor" aria-hidden="true"><path d="M8 4 3 8l5 4V4Z"/><path d="M13.5 4 8.5 8l5 4V4Z"/></svg>'),
    bug: raw('<svg viewBox="0 0 16 16" width="11" height="11" fill="none" aria-hidden="true"><ellipse cx="8" cy="9.2" rx="3.3" ry="4" stroke="currentColor" stroke-width="1.2"/><path d="M8 5.2V3M5.4 4.2 4.2 2.8M10.6 4.2l1.2-1.4M4 8.4H1.8M14.2 8.4H12M4.3 12 2.6 13.6M11.7 12l1.7 1.6" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg>'),
    hourglass: raw('<svg viewBox="0 0 16 16" width="11" height="11" fill="none" aria-hidden="true"><path d="M4 2h8M4 14h8M4.6 2c0 2.3 1.1 3.8 3.4 5-2.3 1.2-3.4 2.7-3.4 5M11.4 2c0 2.3-1.1 3.8-3.4 5 2.3 1.2 3.4 2.7 3.4 5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>'),
    check: raw('<svg viewBox="0 0 16 16" width="11" height="11" fill="none" aria-hidden="true"><path d="M3.5 8.5 6.5 11.5 12.5 4.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>'),
    arrowRight: raw('<svg class="arrow-right" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></svg>'),
});

/** How many of the 3 ascending bars are lit for a given environment — test/qa/prod map to stage 1/2/3
 *  of the promotion chain, so the icon reads as "how far along" at a glance. Used everywhere an
 *  environment is labeled (env card titles, deployment env badges, Product view column headers) so the
 *  same environment always shows the same bar count. */
const ENV_BAR_COUNT = { test: 1, qa: 2, prod: 3 };

/** Builds the 3-bar environment icon with `activeCount` bars lit. Lit bars are always literal white
 *  (#ECEEF1), empty bars always #33373D — per design, the bars never take on the surrounding
 *  badge/text color, unlike every other icon in ICONS above. */
function barsIcon(activeCount){
    const bars = [{ x: 0, y: 8, h: 8 }, { x: 7, y: 4, h: 12 }, { x: 14, y: 0, h: 16 }];
    const rects = bars.map((b, i) => {
        const lit = i < activeCount;

        return `<rect x="${b.x}" y="${b.y}" width="4" height="${b.h}" rx="2" fill="${lit ? '#ECEEF1' : '#33373D'}"/>`;
    }).join('');

    return raw(`<svg class="stage-icon" width="18" height="16" viewBox="0 0 18 16" aria-hidden="true">${rects}</svg>`);
}

/** Compact 13x12 variant of barsIcon() for the Deployment history `.env-badge` pill (same colors and
 *  lit-bar rule, just the badge's own proportions). */
function envBadgeIcon(activeCount){
    const bars = [{ x: 0, y: 6, h: 6 }, { x: 5, y: 3, h: 9 }, { x: 10, y: 0, h: 12 }];
    const rects = bars.map((b, i) => `<rect x="${b.x}" y="${b.y}" width="3" height="${b.h}" rx="1" fill="${i < activeCount ? '#ECEEF1' : '#33373D'}"/>`).join('');

    return raw(`<svg width="13" height="12" viewBox="0 0 13 12" aria-hidden="true">${rects}</svg>`);
}
