// The first page for someone signed in without a workspace: create one, then go to its settings.
document.getElementById('createTenant').addEventListener('submit', async (event) => {
    event.preventDefault();
    const error = document.getElementById('startError');
    const name = event.target.elements.namedItem('name').value.trim();
    error.hidden = true;
    const res = await fetch('/tenants', {
        method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }),
    }).catch(() => null);
    const body = res ? await res.json().catch(() => ({})) : {};
    if (!res || !res.ok) {
        error.textContent = body.error || 'Could not create the workspace; please try again.';
        error.hidden = false;
        return;
    }
    location.assign(`/t/${body.tenant.id}/settings`);
});
