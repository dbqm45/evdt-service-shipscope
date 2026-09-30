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

module.exports = { resolveDisplayName };