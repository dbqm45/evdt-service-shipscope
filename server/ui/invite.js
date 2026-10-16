// The page an invitation link opens (GET /invitations/<token> from a browser): who invites you, as what, and a
// button to join. It reads the same URL as JSON and accepts with POST <url>/accept; the server checks everything.
// Plain DOM text only (textContent), never markup: the workspace name is someone else's input.

/** What to show for an invitation preview ({ tenant, role, status, alreadyMember }). */
function invitationView(preview){
    const name = preview.tenant.name;
    if (preview.alreadyMember) {
        return { title: name, text: `You are already a member of ${name}.`, accept: false, open: `/t/${preview.tenant.id}/` };
    }
    const gone = {
        accepted: 'This invitation has already been used.',
        revoked: 'This invitation was withdrawn.',
        expired: 'This invitation has expired.',
    }[preview.status];
    if (gone) {
        return { title: name, text: `${gone} Ask an admin of ${name} for a new link.`, accept: false, open: null };
    }
    const role = preview.role === 'admin' ? 'an admin (you can change its settings)' : 'a member (you see everything; admins change settings)';
    return { title: `Join ${name}`, text: `You are invited to join ${name} on ShipScope as ${role}.`, accept: true, open: null };
}

async function initInvite(){
    const el = (id) => document.getElementById(id);
    const showError = (message) => {
        el('inviteError').textContent = message;
        el('inviteError').hidden = false;
    };
    const res = await fetch(location.pathname, { credentials: 'same-origin', headers: { accept: 'application/json' } }).catch(() => null);
    const body = res ? await res.json().catch(() => ({})) : {};
    if (!res || !res.ok) {
        el('inviteText').textContent = res && res.status === 404 ? 'This invitation link is not valid. Check that you copied all of it.' : '';
        if (!res || res.status !== 404) showError(body.error || 'Could not load the invitation; reload the page to try again.');
        return;
    }
    const view = invitationView(body);
    el('inviteTitle').textContent = view.title;
    el('inviteText').textContent = view.text;
    el('inviteText').className = 'settings-hint';
    el('inviteAccept').hidden = !view.accept;
    if (view.open) {
        el('inviteOpen').href = view.open;
        el('inviteOpen').hidden = false;
    }
    el('inviteAccept').addEventListener('click', async () => {
        el('inviteAccept').disabled = true;
        el('inviteError').hidden = true;
        const accepted = await fetch(`${location.pathname}/accept`, { method: 'POST', credentials: 'same-origin', headers: { accept: 'application/json' } }).catch(() => null);
        const result = accepted ? await accepted.json().catch(() => ({})) : {};
        if (!accepted || !accepted.ok) {
            el('inviteAccept').disabled = false;
            showError(result.error || 'Could not join; please try again.');
            return;
        }
        location.assign(`/t/${result.tenant.id}/`);
    });
}

if (typeof module !== 'undefined') {
    module.exports = { invitationView };
} else {
    initInvite();
}
