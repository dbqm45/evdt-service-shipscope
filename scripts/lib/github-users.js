/**
 * Resolves a GitHub login to the display name ("Imię Nazwisko") the user has set on their public
 * profile, via GitHub's Users API. Falls back to `null` (caller falls back to the login itself) on any
 * failure — missing name, deleted/bot account, rate limit, network error — so a resolution problem never
 * breaks the caller's sync run.
 */
async function resolveDisplayName(login, token, cache) {
    if (!login) {
        return null;
    }

    if (cache.has(login)) {
        return cache.get(login);
    }

    let name = null;

    try {
        const res = await fetch(`https://api.github.com/users/${login}`, {
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: 'application/vnd.github+json',
            },
        });

        if (res.ok) {
            const user = await res.json();

            name = user.name || null;
        }
    } catch (e) {
        console.warn(`Warning: could not resolve display name for "${login}": ${e.message}`);
    }

    cache.set(login, name);

    return name;
}

// A GitHub login: alphanumerics and single hyphens, max 39 chars. Anything else (a bot like
// "dependabot[bot]", an already-human string such as "m.nowak (BE)") is not looked up and is kept as-is — this
// also keeps free-form input (e.g. a repository_dispatch `changedBy`) out of the request URL.
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/**
 * Display name ("Imię Nazwisko") for the person behind a flag change, falling back to `actor` unchanged —
 * same login → name → login chain the Deployment History's `deployedBy` uses. Returns `actor` as-is when
 * there is no token (an unauthenticated /users call would burn the shared runner IP's tiny rate limit), when
 * it doesn't look like a login, or when the lookup finds no public name.
 */
async function resolveActorName(actor, token) {
    if (!actor || !token || !GITHUB_LOGIN.test(actor)) {
        return actor;
    }

    return (await resolveDisplayName(actor, token, new Map())) || actor;
}

module.exports = { resolveDisplayName, resolveActorName };