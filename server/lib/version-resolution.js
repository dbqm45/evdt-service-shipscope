const { githubGet, GitHubApiError } = require('./github-app');

/**
 * Which version a deployment shipped, ported from the file-based sync (see CLAUDE.md,
 * "Deployments" -> `version`). Priority, most authoritative first: a GitHub Release on that exact sha, a git
 * tag on it, the repo's version file (`version=<ref>` at the deployed commit), a version-like string in the
 * commit message, else nothing (the dashboard then shows the short sha).
 *
 * The *label* and the *ref* are different things on purpose: `version` is only displayed, while `resolvedRef`
 * is what /compare is called with -- a verified release/tag name or a commit sha, never the commit-message
 * regex match, which may name no real ref or an unrelated one (a real bug in the file-based sync once).
 */

const MAX_PAGES = 10;

/** A `v1.2.3` / `1.2.3`-like substring of a commit message, or null. */
function extractPromotedVersion(commitMessage) {
    const match = (commitMessage || '').match(/\bv?\d+\.\d+\.\d+\b/);
    return match ? match[0] : null;
}

/** The `version` value of a `key=value` properties file, or null. */
function parseVersionProperty(text) {
    const match = /^\s*version\s*[=:]\s*(\S+)\s*$/m.exec(text || '');
    return match ? match[1] : null;
}

async function allPages(token, path, fetchFn) {
    const items = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
        const batch = await githubGet({ token, path: `${path}?per_page=100&page=${page}`, fetch: fetchFn });
        if (!Array.isArray(batch)) throw new GitHubApiError(`${path} response is not a list`, 502);
        items.push(...batch);
        if (batch.length < 100) break;
    }
    return items;
}

/**
 * The tag a version file's label means, or null when none does (the caller then asks GitHub for a commit by
 * that name). In order: the tag as written; the same with the `v` prefix added or dropped; for `X.Y.Z` with a
 * suffix (`1.4.25-okta`, `v2.0.0-rc.1`, `1.0.0+build5`, `1.0.0_hotfix`; not a fourth number) the base tag `X.Y.Z` (either prefix), so
 * an exact tag always wins over the base one. `latest` (any case, when no tag has that name) is the newest
 * published release that existed when the deployment was created; then the tag is also the label, since
 * "latest" names no version.
 *
 * @param {string} label
 * @param {{ tagNames: Set<string>, releases?: { tag: string, publishedAt: string }[], at?: string|null }} index
 *   `releases`: published, non-prerelease releases whose tag exists, newest first; `at`: the deployment's created_at
 * @returns {{ ref: string, label: string }|null}
 */
function matchVersionLabel(label, { tagNames, releases = [], at = null }) {
    const toggled = (name) => (/^v\d/.test(name) ? name.slice(1) : `v${name}`);
    for (const name of [label, toggled(label)]) if (tagNames.has(name)) return { ref: name, label };
    const base = /^v?(\d+\.\d+\.\d+)[-+_]\S+$/.exec(label);
    if (base) for (const name of [`v${base[1]}`, base[1]]) if (tagNames.has(name)) return { ref: name, label };
    if (label.toLowerCase() === 'latest' && at) {
        const atMs = Date.parse(at);
        const release = releases.find((r) => Date.parse(r.publishedAt) <= atMs);
        if (release) return { ref: release.tag, label: release.tag };
    }
    return null;
}

/**
 * Tags and releases of a repo, indexed for lookups. Two list calls per repo per pass (only made when the pass
 * has new deployments), however many deployments there are.
 *
 * @param {{ token: string, fullName: string, fetch?: typeof fetch }} input
 * @returns {Promise<{ shaToRelease: Map<string, string>, shaToTag: Map<string, string>, tagNames: Set<string>, releases: { tag: string, publishedAt: string }[] }>}
 */
async function fetchRefIndex({ token, fullName, fetch: fetchFn = fetch }) {
    const tags = (await allPages(token, `/repos/${fullName}/tags`, fetchFn))
        .filter((t) => typeof t?.name === 'string' && typeof t?.commit?.sha === 'string');
    const releases = (await allPages(token, `/repos/${fullName}/releases`, fetchFn))
        .filter((r) => typeof r?.tag_name === 'string');
    const tagNameToSha = new Map(tags.map((t) => [t.name, t.commit.sha]));
    return {
        shaToTag: new Map(tags.map((t) => [t.commit.sha, t.name])),
        shaToRelease: new Map(releases.map((r) => [tagNameToSha.get(r.tag_name), r.tag_name]).filter(([sha]) => sha)),
        tagNames: new Set(tagNameToSha.keys()),
        // For `version=latest`: what GitHub itself calls the latest release (published, not a prerelease).
        releases: releases
            .filter((r) => !r.draft && !r.prerelease && typeof r.published_at === 'string' && !Number.isNaN(Date.parse(r.published_at)) && tagNameToSha.has(r.tag_name))
            .map((r) => ({ tag: r.tag_name, publishedAt: r.published_at }))
            .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt)),
    };
}

/**
 * For repos with a version file: the ref the file names at `sha`. `ref` is the tag the label means
 * (matchVersionLabel()), else the commit sha the name resolves to; `label` is the value as written (the release
 * tag for `latest`). Null when the file or the ref is missing -- never throws, a lookup problem must not fail the
 * sync (the sha is used instead).
 *
 * @param {{ token: string, fullName: string, versionFile: string, sha: string, tagNames: Set<string>, releases?: { tag: string, publishedAt: string }[], at?: string|null, fetch?: typeof fetch }} input
 * @returns {Promise<{ ref: string, label: string }|null>}
 */
async function resolveVersionFile({ token, fullName, versionFile, sha, tagNames, releases = [], at = null, fetch: fetchFn = fetch }) {
    try {
        const encodedPath = versionFile.split('/').map(encodeURIComponent).join('/');
        const file = await githubGet({ token, path: `/repos/${fullName}/contents/${encodedPath}?ref=${sha}`, fetch: fetchFn });
        if (typeof file?.content !== 'string') return null;
        const label = parseVersionProperty(Buffer.from(file.content, 'base64').toString('utf8'));
        if (!label) return null;
        const tag = matchVersionLabel(label, { tagNames, releases, at });
        if (tag) return tag;
        const commit = await githubGet({ token, path: `/repos/${fullName}/commits/${encodeURIComponent(label)}`, fetch: fetchFn });
        return typeof commit?.sha === 'string' ? { ref: commit.sha, label } : null;
    } catch {
        return null;
    }
}

/**
 * @param {{ sha: string, message: string, refIndex: { shaToRelease: Map<string, string>, shaToTag: Map<string, string> }, fileRef: { ref: string, label: string }|null }} input
 * @returns {{ version: string|null, resolvedRef: string }}
 */
function resolveVersion({ sha, message, refIndex, fileRef }) {
    const verifiedRef = refIndex.shaToRelease.get(sha) || refIndex.shaToTag.get(sha) || null;
    if (fileRef) return { version: fileRef.label, resolvedRef: fileRef.ref };
    return { version: verifiedRef || extractPromotedVersion(message), resolvedRef: verifiedRef || sha };
}

module.exports = { extractPromotedVersion, parseVersionProperty, matchVersionLabel, fetchRefIndex, resolveVersionFile, resolveVersion };
