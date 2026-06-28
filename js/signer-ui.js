// signer-ui.js — the NIP-07 signer connection, the remembered identity, and the
// avatar/profile in the top bar. Extracted from app.js; app wires it once at
// boot with initSigner(deps) and uses the returned handle for the few actions it
// still triggers itself (status refresh on boot/reset, the post-login nudge).
//
// deps: { getProject, persist, setStatus, onRelaysChanged }
//   getProject       — returns the live project (app reassigns it on reset)
//   persist          — save the project to localStorage
//   setStatus        — write the chat status line
//   onRelaysChanged  — re-mount views after the seed relays change

import * as nostr from './nostr.js';

const $ = (sel) => document.querySelector(sel);

export function initSigner({ getProject, persist, setStatus, onRelaysChanged }) {
  // A remembered identity (persisted pubkey) keeps the user "connected" across
  // reloads, even before the extension is queried again.
  function refreshSignerStatus() {
    const item = $('#btn-connect-signer');
    if (!item) return;
    item.textContent = getProject().settings.pubkey ? 'Disconnect signer' : 'Connect signer';
  }

  // Menu entry: when connected it disconnects; otherwise it opens the guided
  // dialog, which both authorizes an existing extension AND walks users who
  // don't have a signer yet through installing one.
  function onSignerMenu() {
    if (getProject().settings.pubkey) { disconnectSigner(); return; }
    openSignerDialog();
  }

  function setSignerStatus(text, kind = '') {
    const el = $('#signer-status');
    if (!el) return;
    el.textContent = text;
    el.className = 'connect-status' + (kind ? ' ' + kind : '');
  }

  // Adapt the dialog to whether a NIP-07 extension is present right now: existing
  // users get a one-click Connect; users without one get install guidance + Retry.
  function refreshSignerDialog() {
    const present = nostr.signer.available();
    $('#signer-present').hidden = !present;
    $('#signer-absent').hidden = present;
    $('#signer-action').textContent = present ? 'Connect' : 'Retry';
    setSignerStatus('');
  }

  function openSignerDialog() {
    refreshSignerDialog();
    $('#signer-dialog').showModal();
  }

  async function signerAction() {
    // No extension yet: this is the "Retry" path — re-check after they install one.
    if (!nostr.signer.available()) {
      refreshSignerDialog();
      if (!nostr.signer.available()) {
        setSignerStatus('Still no signer detected. Make sure the extension is installed and enabled, then retry. You may need to reload the page.', 'error');
      }
      return;
    }
    const action = $('#signer-action');
    action.disabled = true;
    setSignerStatus('Waiting for the extension to authorize…');
    try {
      const pk = await nostr.signer.getPublicKey();
      getProject().settings.pubkey = pk;
      persist();
      refreshSignerStatus();
      setSignerStatus('Connected! Importing your relays and profile…', 'ok');
      // Pull the user's own relays so the outbox model routes through their real
      // network with no manual relay setup, then show their profile.
      await importUserRelays(pk);
      await loadUserProfile(pk);
      setStatus('');
      setTimeout(() => $('#signer-dialog').close(), 700);
    } catch (err) {
      setSignerStatus('Authorization was denied. Approve the request in your extension and retry.', 'error');
    } finally {
      action.disabled = false;
    }
  }

  // On load, recognize a returning nostr user from their remembered pubkey:
  // paint the cached avatar at once, then refresh the profile in the background.
  // No extension prompt is triggered — we already trust the stored pubkey.
  function restoreSigner() {
    const pk = getProject().settings.pubkey;
    if (!pk) return;
    const cached = getProject().settings.profile;
    if (cached) setAvatar(cached.picture, cached.name);
    else setAvatar('', '');
    loadUserProfile(pk);
  }

  // After login, point the user toward connecting a Nostr identity. If an
  // extension is already present we invite a one-click connect; if not (e.g. a
  // user new to Nostr) we point them at the guided setup that suggests Alby.
  function nudgeConnectSigner() {
    if (getProject().settings.pubkey) return;
    if (nostr.signer.available()) {
      setStatus('Nostr extension detected — open the menu (top right) and “Connect signer” to use your identity.');
    } else {
      setStatus('New to Nostr? Open the menu (top right) → “Connect signer” to set up a signer extension (we suggest Alby).');
    }
  }

  function disconnectSigner() {
    const project = getProject();
    project.settings.pubkey = '';
    project.settings.profile = null;
    persist();
    refreshSignerStatus();
    clearAvatar();
  }

  // Merge the user's own NIP-65 (kind 10002) read/write relays into the discovery
  // seeds so per-author outbox routing starts from where they actually publish.
  // De-duplicated; existing seeds are kept as a fallback.
  async function importUserRelays(pubkey) {
    const project = getProject();
    try {
      const list = await nostr.relayListFor(pubkey, project.settings.relays, { timeout: 4000 });
      const merged = [...list.write, ...list.read, ...project.settings.relays]
        .map((u) => u.trim()).filter(Boolean);
      const deduped = [...new Set(merged)];
      if (deduped.length === project.settings.relays.length
          && deduped.every((u, i) => u === project.settings.relays[i])) return; // nothing new
      project.settings.relays = deduped;
      persist();
      onRelaysChanged();   // re-mount views against the user's relays
    } catch { /* keep the default seeds */ }
  }

  // Show the user's avatar (kind 0 'picture') in the menu button. Falls back to
  // the placeholder silhouette if there's no picture or the image fails to load.
  function setAvatar(url, name) {
    const img = $('#user-avatar');
    const btn = $('#user-menu-btn');
    if (!img) return;
    btn.classList.add('connected');
    if (name) { btn.title = name; btn.setAttribute('aria-label', name); }
    if (!url) return;
    // Show the picture only once it has actually loaded; on failure fall back to
    // the silhouette. .has-img drives which one displays (see CSS).
    img.onload = () => btn.classList.add('has-img');
    img.onerror = () => btn.classList.remove('has-img');
    img.src = url;
  }

  // Reset the menu button back to the anonymous placeholder silhouette.
  function clearAvatar() {
    const img = $('#user-avatar');
    const btn = $('#user-menu-btn');
    if (!btn) return;
    btn.classList.remove('connected', 'has-img');
    btn.removeAttribute('title');
    btn.setAttribute('aria-label', 'Open menu');
    if (img) img.removeAttribute('src');
  }

  // Fetch the signed-in user's profile metadata (kind 0) and pull their picture.
  // The result is cached in settings so the avatar paints instantly next load.
  async function loadUserProfile(pubkey) {
    const project = getProject();
    try {
      const events = await nostr.outboxQuery(
        project.settings.relays,
        { kinds: [0], authors: [pubkey], limit: 1 },
        { timeout: 4000 },
      );
      const meta = events[0] ? JSON.parse(events[0].content || '{}') : {};
      const profile = { picture: meta.picture || '', name: meta.display_name || meta.name || '' };
      project.settings.profile = profile;
      persist();
      setAvatar(profile.picture, profile.name);
    } catch { /* keep the placeholder avatar */ }
  }

  $('#btn-connect-signer').addEventListener('click', onSignerMenu);
  $('#signer-action').addEventListener('click', signerAction);
  $('#signer-cancel').addEventListener('click', () => $('#signer-dialog').close());

  return { refreshStatus: refreshSignerStatus, restore: restoreSigner, nudge: nudgeConnectSigner, clearAvatar };
}
