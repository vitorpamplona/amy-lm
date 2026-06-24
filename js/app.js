// app.js — wires everything together: project state, the view canvas,
// the Claude chat, and the tools that let Claude build the client.

import * as store from './storage.js';
import * as nostr from './nostr.js';
import * as views from './views.js';
import * as theme from './theme.js';
import { converse, complete } from './llm.js';
import { verifyApiKey, detectProvider, normalizeBaseUrl, PROVIDERS } from './auth.js';
import { SYSTEM, TOOLS } from './agent.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let project = store.load();
let activeViewId = project.views[0]?.id || null;

// One mounted, independently-scrollable pane per view, so each tab keeps its
// own scroll position (and stays put when you switch away and back).
// viewId -> { el, cleanups: fn[], code: string, rendered: bool }
const panes = new Map();

const $ = (sel) => document.querySelector(sel);

function persist() { store.save(project); }

function uid() { return 'v' + Math.random().toString(36).slice(2, 9); }

// The full source of every view we build piles up inside save_view tool_use
// blocks in the chat, which inflates every request the model sees. The canonical
// copy lives in project.views and can be re-read with read_view, so before each
// turn we strip the code out of older save_view calls — keeping the most recent
// one intact, so a quick follow-up edit needs no extra round trip.
const ELIDED_CODE = '[elided to save context — call read_view to fetch the current code]';

function compactHistory() {
  let last = null;
  for (const m of project.chat) {
    if (m.role !== 'assistant' || !Array.isArray(m.content)) continue;
    for (const b of m.content) if (b.type === 'tool_use' && b.name === 'save_view') last = b;
  }
  for (const m of project.chat) {
    if (m.role !== 'assistant' || !Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b.type === 'tool_use' && b.name === 'save_view' && b !== last
          && b.input && typeof b.input.code === 'string' && b.input.code !== ELIDED_CODE) {
        b.input.code = ELIDED_CODE;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Tool implementations — dispatch() runs the tools defined in agent.js TOOLS.
// ---------------------------------------------------------------------------
async function dispatch(name, input) {
  switch (name) {
    case 'save_view': {
      let view = project.views.find((v) => v.id === input.id);
      if (view) {
        view.title = input.title;
        view.code = input.code;
      } else {
        view = { id: uid(), title: input.title, code: input.code, createdAt: Date.now(), state: {} };
        project.views.push(view);
      }
      activeViewId = view.id;
      persist();
      renderTabs();
      renderActiveView();
      return `Saved view "${view.title}" (id: ${view.id}) and opened it on the canvas.`;
    }
    case 'list_views':
      return JSON.stringify(project.views.map((v) => ({ id: v.id, title: v.title })));
    case 'read_view': {
      const view = project.views.find((v) => v.id === input.id);
      if (!view) return `No view with id ${input.id}.`;
      return JSON.stringify({ id: view.id, title: view.title, code: view.code });
    }
    case 'delete_view': {
      const before = project.views.length;
      project.views = project.views.filter((v) => v.id !== input.id);
      if (activeViewId === input.id) activeViewId = project.views[0]?.id || null;
      persist();
      renderTabs();
      renderActiveView();
      return project.views.length < before ? `Deleted ${input.id}.` : `No view with id ${input.id}.`;
    }
    case 'read_nip': {
      const n = String(input.nip).replace(/[^0-9a-zA-Z]/g, '');
      const name = /^\d$/.test(n) ? '0' + n : n; // "1" -> "01"
      const url = `https://raw.githubusercontent.com/nostr-protocol/nips/master/${name}.md`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Could not fetch NIP ${name} (${res.status}).`);
      const text = await res.text();
      return text.length > 24000 ? text.slice(0, 24000) + '\n…(truncated)' : text;
    }
    case 'query_relays': {
      // Gemini may hand us the filter as a JSON string (see sanitizeSchema); tolerate both.
      let filters = input.filters;
      if (typeof filters === 'string') { try { filters = JSON.parse(filters); } catch {} }
      const events = await nostr.outboxQuery(project.settings.relays, filters, { timeout: input.timeout ?? 4000 });
      const trimmed = events.slice(0, 20).map((e) => ({
        id: e.id, pubkey: e.pubkey, kind: e.kind, created_at: e.created_at,
        tags: e.tags, content: (e.content || '').slice(0, 500),
      }));
      return JSON.stringify({ count: events.length, events: trimmed });
    }
    case 'search_relays': {
      // Gemini may hand the filter over as a JSON string (see sanitizeSchema); tolerate both.
      let filters = input.filters || {};
      if (typeof filters === 'string') { try { filters = JSON.parse(filters); } catch {} }
      const events = await nostr.search(project.settings.relays, input.query, filters, {
        timeout: input.timeout ?? 4000,
        pubkey: project.settings.pubkey || null,
      });
      const trimmed = events.slice(0, 20).map((e) => ({
        id: e.id, pubkey: e.pubkey, kind: e.kind, created_at: e.created_at,
        tags: e.tags, content: (e.content || '').slice(0, 500),
      }));
      return JSON.stringify({ count: events.length, events: trimmed });
    }
    case 'get_context': {
      // Prefer the remembered identity (no extension prompt); fall back to the
      // live signer if nothing is stored yet.
      let pubkey = project.settings.pubkey || null;
      if (!pubkey) { try { if (nostr.signer.available()) pubkey = await nostr.signer.getPublicKey(); } catch {} }
      return JSON.stringify({ pubkey, npub: pubkey ? nostr.nip19.npubEncode(pubkey) : null, relays: project.settings.relays });
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// Confirm dialog — a designed replacement for window.confirm(). Resolves true
// when the user confirms, false on cancel / Escape / backdrop dismiss.
// ---------------------------------------------------------------------------
function confirmDialog({ title = 'Are you sure?', message = '', confirmLabel = 'Confirm', danger = true } = {}) {
  const dlg = $('#confirm-dialog');
  const ok = $('#confirm-ok');
  $('#confirm-title').textContent = title;
  $('#confirm-message').textContent = message;
  ok.textContent = confirmLabel;
  ok.classList.toggle('danger', danger);
  $('#confirm-icon').hidden = !danger;

  return new Promise((resolve) => {
    let confirmed = false;
    const onOk = () => { confirmed = true; dlg.close(); };
    const onCancel = () => dlg.close();
    const onClose = () => {
      ok.removeEventListener('click', onOk);
      $('#confirm-cancel').removeEventListener('click', onCancel);
      dlg.removeEventListener('close', onClose);
      resolve(confirmed);
    };
    ok.addEventListener('click', onOk);
    $('#confirm-cancel').addEventListener('click', onCancel);
    dlg.addEventListener('close', onClose);
    dlg.showModal();
    ok.focus();
  });
}

// ---------------------------------------------------------------------------
// Canvas (views)
// ---------------------------------------------------------------------------
function renderTabs() {
  const tabs = $('#canvas-tabs');
  tabs.innerHTML = '';
  for (const v of project.views) {
    const tab = document.createElement('div');
    tab.className = 'tab' + (v.id === activeViewId ? ' active' : '');
    const label = document.createElement('span');
    label.textContent = v.title;
    label.onclick = () => { activeViewId = v.id; persist(); renderTabs(); renderActiveView(); };
    const x = document.createElement('span');
    x.className = 'x';
    x.textContent = '×';
    x.title = 'Delete view';
    x.onclick = async (e) => {
      e.stopPropagation();
      const ok = await confirmDialog({
        title: 'Close this view?',
        message: `“${v.title}” will be deleted permanently. This cannot be undone.`,
        confirmLabel: 'Delete view',
      });
      if (ok) dispatch('delete_view', { id: v.id });
    };
    tab.append(label, x);
    tabs.append(tab);
  }
}

function teardownPane(entry) {
  while (entry.cleanups.length) {
    try { entry.cleanups.pop()(); } catch {}
  }
}

// Drop every mounted pane (used when something global changes, e.g. relays).
function resetPanes() {
  for (const entry of panes.values()) { teardownPane(entry); entry.el.remove(); }
  panes.clear();
}

// Reconcile the mounted panes with the current set of views: create a pane for
// each view, re-create panes whose code changed, and remove panes for deleted
// views (tearing down their subscriptions).
function syncPanes() {
  const body = $('#canvas-body');
  const live = new Set(project.views.map((v) => v.id));
  for (const [id, entry] of panes) {
    if (!live.has(id)) { teardownPane(entry); entry.el.remove(); panes.delete(id); }
  }
  for (const v of project.views) {
    const entry = panes.get(v.id);
    if (entry && entry.code !== v.code) { teardownPane(entry); entry.el.remove(); panes.delete(v.id); }
    if (!panes.has(v.id)) {
      const pane = document.createElement('div');
      pane.className = 'view-pane';
      pane.style.display = 'none';
      body.append(pane);
      panes.set(v.id, { el: pane, cleanups: [], code: v.code, rendered: false });
    }
  }
}

function renderActiveView() {
  syncPanes();
  const view = project.views.find((v) => v.id === activeViewId);
  $('#empty-canvas').style.display = view ? 'none' : '';

  for (const [id, entry] of panes) {
    const active = !!view && id === activeViewId;
    entry.el.style.display = active ? '' : 'none';
    // Mount the active view the first time it's shown; afterwards it stays in
    // the DOM (hidden) so its scroll position is preserved across tab switches.
    if (active && !entry.rendered) {
      entry.rendered = true;
      views.runView(entry.el, view, {
        relays: project.settings.relays,
        pubkey: project.settings.pubkey || null, // whose kind 10007 search relays to use
        getState: () => view.state || (view.state = {}),
        setState: (obj) => { view.state = { ...(view.state || {}), ...obj }; persist(); },
        onCleanup: (fn) => entry.cleanups.push(fn),
        agent: async (prompt, opts = {}) => {
          if ($('#confirm-dialog').open) throw new Error('Another AI call is already awaiting confirmation.');
          const preview = prompt.length > 200 ? prompt.slice(0, 200) + '…' : prompt;
          const allowed = await confirmDialog({
            title: 'A view wants to call the AI',
            message: preview,
            confirmLabel: 'Allow',
            danger: false,
          });
          if (!allowed) throw new Error('AI call denied by user.');
          return complete({
            apiKey: project.settings.apiKey,
            provider: project.settings.provider,
            baseUrl: project.settings.baseUrl,
            model: project.settings.model,
            system: opts.system || 'You are a helpful assistant.',
            prompt,
          });
        },
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------
function addMessageEl(role, text, cls = '') {
  const wrap = document.createElement('div');
  wrap.className = `msg ${role} ${cls}`.trim();
  const r = document.createElement('div');
  r.className = 'role';
  r.textContent = role === 'tool' ? 'amy · tool' : role;
  const b = document.createElement('div');
  b.className = 'bubble';
  b.textContent = text;
  wrap.append(r, b);
  $('#messages').append(wrap);
  $('#messages').scrollTop = $('#messages').scrollHeight;
  return b;
}

function renderChatHistory() {
  $('#messages').innerHTML = '';
  for (const m of project.chat) {
    if (m.role === 'user') {
      if (typeof m.content === 'string') addMessageEl('user', m.content);
      // array content = tool results; skip in transcript
    } else if (m.role === 'assistant') {
      const blocks = Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content }];
      for (const b of blocks) {
        if (b.type === 'text' && b.text.trim()) addMessageEl('assistant', b.text);
        else if (b.type === 'tool_use') addMessageEl('tool', `→ ${b.name}(${shortInput(b.input)})`);
      }
    }
  }
}

function shortInput(input) {
  const s = JSON.stringify(input);
  return s.length > 80 ? s.slice(0, 80) + '…' : s;
}

let busy = false;
async function onSend(e) {
  e.preventDefault();
  if (busy) return;
  const text = $('#prompt').value.trim();
  if (!text) return;
  if (!isConnected()) { openConnect(); setStatus('Connect an LLM to start.'); return; }

  $('#prompt').value = '';
  autoGrowPrompt();
  project.chat.push({ role: 'user', content: text });
  addMessageEl('user', text);
  compactHistory();
  persist();

  busy = true;
  $('#send').disabled = true;
  setStatus('Amy is thinking…');

  try {
    await converse({
      apiKey: project.settings.apiKey,
      provider: project.settings.provider,
      baseUrl: project.settings.baseUrl,
      model: project.settings.model,
      system: SYSTEM,
      messages: project.chat,
      tools: TOOLS,
      dispatch,
      onText: (t) => { if (t.trim()) addMessageEl('assistant', t); persist(); },
      onToolUse: (name, input) => { addMessageEl('tool', `→ ${name}(${shortInput(input)})`); setStatus(`Running ${name}…`); persist(); },
    });
    setStatus('');
  } catch (err) {
    addMessageEl('tool', `⚠ ${err.message}`, '');
    setStatus('');
  } finally {
    persist();
    busy = false;
    $('#send').disabled = false;
    $('#prompt').focus();
  }
}

function setStatus(t) { $('#chat-status').textContent = t; }

// Resize the prompt textarea to fit its content. The CSS max-height caps the
// growth and switches the box to scrolling once that limit is reached.
function autoGrowPrompt() {
  const el = $('#prompt');
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
}

// Start a fresh conversation: empties the transcript that's replayed to the LLM
// each turn (it accumulates and inflates every request), while keeping views,
// settings, and the signer. Safe because views live in project.views and the
// model re-reads their code with read_view rather than trusting chat history.
function clearChat() {
  if (busy) return;
  if (!project.chat.length) { setStatus('Chat is already empty.'); return; }
  project.chat = [];
  persist();
  renderChatHistory();
  setStatus('Started a fresh chat. Your views are kept.');
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------
function refreshThemeButton() {
  const btn = $('#btn-theme');
  if (!btn) return;
  const dark = theme.current() === 'dark';
  // Label the menu item with the mode you'd switch *to*.
  btn.textContent = dark ? '☀  Light theme' : '☾  Dark theme';
  btn.title = dark ? 'Switch to light theme' : 'Switch to dark theme';
}

// ---------------------------------------------------------------------------
// Signer + settings
// ---------------------------------------------------------------------------
function refreshSignerStatus() {
  const item = $('#btn-connect-signer');
  if (!item) return;
  // A remembered identity (persisted pubkey) keeps the user "connected" across
  // reloads, even before the extension is queried again.
  item.textContent = project.settings.pubkey ? 'Disconnect signer' : 'Connect signer';
}

// Menu entry: when connected it disconnects; otherwise it opens the guided
// dialog, which both authorizes an existing extension AND walks users who
// don't have a signer yet through installing one.
function onSignerMenu() {
  if (project.settings.pubkey) { disconnectSigner(); return; }
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
    project.settings.pubkey = pk;
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
  const pk = project.settings.pubkey;
  if (!pk) return;
  const cached = project.settings.profile;
  if (cached) setAvatar(cached.picture, cached.name);
  else setAvatar('', '');
  loadUserProfile(pk);
}

// After login, point the user toward connecting a Nostr identity. If an
// extension is already present we invite a one-click connect; if not (e.g. a
// user new to Nostr) we point them at the guided setup that suggests Alby.
function nudgeConnectSigner() {
  if (project.settings.pubkey) return;
  if (nostr.signer.available()) {
    setStatus('Nostr extension detected — open the menu (top right) and “Connect signer” to use your identity.');
  } else {
    setStatus('New to Nostr? Open the menu (top right) → “Connect signer” to set up a signer extension (we suggest Alby).');
  }
}

function disconnectSigner() {
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
  try {
    const list = await nostr.relayListFor(pubkey, project.settings.relays, { timeout: 4000 });
    const merged = [...list.write, ...list.read, ...project.settings.relays]
      .map((u) => u.trim()).filter(Boolean);
    const deduped = [...new Set(merged)];
    if (deduped.length === project.settings.relays.length
        && deduped.every((u, i) => u === project.settings.relays[i])) return; // nothing new
    project.settings.relays = deduped;
    persist();
    resetPanes();        // re-mount views against the user's relays
    renderActiveView();
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

function openSettings() {
  $('#set-model').value = project.settings.model;
  $('#set-relays').value = project.settings.relays.join('\n');
  $('#set-projname').value = project.name;
  populateModelOptions(project.settings.availableModels);
  refreshClaudeStatus();
  $('#settings-dialog').showModal();
}

// Fill the Model <datalist> with the connected provider's reported ids, and
// reflect how many we have in the hint line. The input stays free-text, so a
// user can always type an id the endpoint didn't list.
function populateModelOptions(models) {
  const list = $('#set-model-options');
  list.innerHTML = (models || []).map((m) => `<option value="${m}"></option>`).join('');
  const hint = $('#set-model-hint');
  const refresh = $('#set-refresh-models');
  const connected = !!(project.settings.provider);
  refresh.disabled = !connected;
  if (!connected) {
    hint.textContent = 'Pick from the models your connected key can use, or type any id. Connect a key to populate this list.';
  } else if (models && models.length) {
    hint.textContent = `${models.length} model${models.length === 1 ? '' : 's'} available from your connected key — pick one or type any id.`;
  } else {
    hint.textContent = 'Your endpoint didn’t list any models — type the model id manually, or hit Refresh.';
  }
}

// Re-query the connected key/endpoint for its current model list, without
// reconnecting. Uses the stored credentials.
async function refreshModelOptions() {
  const btn = $('#set-refresh-models');
  const hint = $('#set-model-hint');
  if (!project.settings.provider) return;
  btn.disabled = true;
  hint.textContent = 'Fetching available models…';
  try {
    const { models } = await verifyApiKey(project.settings.apiKey, project.settings.baseUrl);
    project.settings.availableModels = models;
    persist();
    populateModelOptions(models);
  } catch (err) {
    hint.textContent = err.message || String(err);
    btn.disabled = false;
  }
}

function saveSettingsFromForm() {
  project.settings.model = $('#set-model').value.trim() || 'claude-opus-4-8';
  project.settings.relays = $('#set-relays').value.split('\n').map((s) => s.trim()).filter(Boolean);
  project.name = $('#set-projname').value.trim() || 'untitled project';
  persist();
  $('#project-name').textContent = project.name;
  resetPanes();        // relays may have changed — re-mount views with them
  renderActiveView();
}

// ---------------------------------------------------------------------------
// Log in with Claude (guided, client-only — see js/auth.js)
// ---------------------------------------------------------------------------
function maskKey(key) {
  if (!key) return '';
  return key.length <= 12 ? key : key.slice(0, 7) + '…' + key.slice(-4);
}

// Connected when there's a key, or an OpenAI-compatible base URL (which may need
// no key, e.g. a local Ollama / LM Studio).
function isConnected() {
  return !!project.settings.apiKey || !!project.settings.baseUrl;
}

function refreshClaudeStatus() {
  const connected = isConnected();
  const provider = project.settings.provider || detectProvider(project.settings.apiKey, project.settings.baseUrl);
  const label = provider ? PROVIDERS[provider].label : 'LLM';
  const pill = $('#claude-status');
  // The green `.ok` styling already signals "connected", so the word is redundant;
  // a leading dot marks the live state for anyone who can't perceive the color shift.
  pill.textContent = connected ? `● ${label}` : 'not connected';
  pill.classList.toggle('ok', connected);
  $('#btn-connect-claude').textContent = connected ? label : 'Log in';
  // Settings mirror, if present.
  const state = $('#set-claude-state');
  if (state) {
    // For an OpenAI-compatible endpoint, show the URL (and key if any); otherwise the masked key.
    const detail = provider === 'openai-compatible'
      ? project.settings.baseUrl + (project.settings.apiKey ? `, ${maskKey(project.settings.apiKey)}` : '')
      : maskKey(project.settings.apiKey);
    state.textContent = connected ? `Connected to ${label} (${detail}).` : 'Not connected.';
    state.classList.toggle('ok', connected);
  }
  const manage = $('#set-manage-claude');
  if (manage) manage.textContent = connected ? 'Manage' : 'Log in';
}

function setConnectStatus(text, kind = '') {
  const el = $('#connect-status');
  el.textContent = text;
  el.className = 'connect-status' + (kind ? ' ' + kind : '');
}

function openConnect() {
  $('#connect-open-anthropic').href = PROVIDERS.anthropic.consoleUrl;
  $('#connect-open-openai').href = PROVIDERS.openai.consoleUrl;
  $('#connect-open-google').href = PROVIDERS.google.consoleUrl;
  $('#connect-apikey').value = project.settings.apiKey || '';
  $('#connect-baseurl').value = project.settings.baseUrl || '';
  $('#connect-disconnect').hidden = !isConnected();
  setConnectStatus(isConnected() ? 'Connected. Paste a new key (or base URL) to replace it.' : '');
  if ($('#settings-dialog').open) $('#settings-dialog').close();
  $('#connect-dialog').showModal();
  $('#connect-apikey').focus();
}

// Live hint as the user types, so they know which provider they'll connect to.
function reflectDetectedProvider() {
  const key = $('#connect-apikey').value.trim();
  const baseUrl = $('#connect-baseurl').value.trim();
  // A base URL wins: it routes to the OpenAI-compatible path regardless of key shape.
  if (baseUrl) { setConnectStatus('Will connect to your OpenAI-compatible endpoint.', 'ok'); return; }
  if (!key) { setConnectStatus(''); return; }
  const provider = detectProvider(key);
  if (provider) setConnectStatus(`Detected a ${PROVIDERS[provider].label} key.`, 'ok');
  else setConnectStatus('Unrecognized key — expected sk-ant-… (Claude), sk-… (OpenAI), or AIza…/AQ.… (Gemini). For any other service, add its base URL below.', '');
}

async function submitConnect() {
  const key = $('#connect-apikey').value.trim();
  const baseUrl = $('#connect-baseurl').value.trim();
  const submit = $('#connect-submit');
  submit.disabled = true;
  const detected = detectProvider(key, baseUrl);
  setConnectStatus(detected ? `Verifying with ${PROVIDERS[detected].label}…` : 'Verifying…', '');
  try {
    const { provider, models } = await verifyApiKey(key, baseUrl);
    project.settings.apiKey = key;
    project.settings.provider = provider;
    project.settings.baseUrl = provider === 'openai-compatible' ? normalizeBaseUrl(baseUrl) : '';
    project.settings.availableModels = models; // remember for the Model picker in Settings
    // If the endpoint listed models and the configured one isn't among them, fall
    // back to the provider default (or the first listed) so the first message works.
    // When no models are listed (some compatible servers omit /models), keep the
    // user's current model — they can change it in Settings.
    if (models.length && !models.includes(project.settings.model)) {
      const def = PROVIDERS[provider].defaultModel;
      project.settings.model = models.includes(def) ? def : models[0];
    }
    persist();
    refreshClaudeStatus();
    // For a compatible endpoint, nudge the user to confirm the model when we
    // couldn't pick one from the endpoint (no model set, or it listed none).
    const needsModel = provider === 'openai-compatible' && (!project.settings.model || !models.length);
    const hint = needsModel
      ? ` Set the model name in Settings (currently "${project.settings.model || 'none'}") to match this endpoint before chatting.`
      : ' You can close this and start chatting.';
    setConnectStatus(`Connected to ${PROVIDERS[provider].label}!${hint}`, 'ok');
    setStatus('');
    nudgeConnectSigner();
    setTimeout(() => $('#connect-dialog').close(), 700);
  } catch (err) {
    setConnectStatus(err.message || String(err), 'error');
  } finally {
    submit.disabled = false;
  }
}

function disconnectClaude() {
  project.settings.apiKey = '';
  project.settings.provider = '';
  project.settings.baseUrl = '';
  project.settings.availableModels = [];
  persist();
  refreshClaudeStatus();
  $('#connect-apikey').value = '';
  $('#connect-baseurl').value = '';
  $('#connect-disconnect').hidden = true;
  setConnectStatus('Disconnected.', '');
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
function init() {
  $('#project-name').textContent = project.name;
  renderTabs();
  renderActiveView();
  renderChatHistory();
  refreshSignerStatus();
  restoreSigner();
  refreshClaudeStatus();

  $('#composer').addEventListener('submit', onSend);
  $('#prompt').addEventListener('keydown', (e) => {
    // Enter sends; Shift+Enter inserts a newline.
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend(e); }
  });
  // Grow the composer with its content, up to the CSS max-height.
  $('#prompt').addEventListener('input', autoGrowPrompt);
  refreshThemeButton();
  $('#btn-theme').addEventListener('click', () => { theme.toggle(); refreshThemeButton(); });
  $('#btn-connect-signer').addEventListener('click', onSignerMenu);

  // User menu dropdown (holds the nav actions, opened from the avatar).
  const userBtn = $('#user-menu-btn');
  const dropdown = $('#user-dropdown');
  const closeMenu = () => { dropdown.hidden = true; userBtn.setAttribute('aria-expanded', 'false'); };
  const openMenu = () => { dropdown.hidden = false; userBtn.setAttribute('aria-expanded', 'true'); };
  userBtn.addEventListener('click', (e) => { e.stopPropagation(); dropdown.hidden ? openMenu() : closeMenu(); });
  dropdown.addEventListener('click', (e) => { if (e.target.closest('.menu-item')) closeMenu(); });
  document.addEventListener('click', (e) => { if (!e.target.closest('.user-menu')) closeMenu(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });

  $('#btn-settings').addEventListener('click', openSettings);
  $('#set-refresh-models').addEventListener('click', refreshModelOptions);
  $('#settings-dialog').addEventListener('close', () => {
    if ($('#settings-dialog').returnValue === 'save') saveSettingsFromForm();
  });

  // Log in with Claude
  $('#btn-connect-claude').addEventListener('click', openConnect);
  $('#set-manage-claude').addEventListener('click', openConnect);
  $('#connect-submit').addEventListener('click', submitConnect);
  $('#connect-cancel').addEventListener('click', () => $('#connect-dialog').close());
  $('#connect-disconnect').addEventListener('click', disconnectClaude);

  // Connect signer (guided)
  $('#signer-action').addEventListener('click', signerAction);
  $('#signer-cancel').addEventListener('click', () => $('#signer-dialog').close());
  $('#connect-apikey').addEventListener('input', reflectDetectedProvider);
  $('#connect-baseurl').addEventListener('input', reflectDetectedProvider);
  $('#connect-apikey').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submitConnect(); }
  });
  $('#connect-baseurl').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submitConnect(); }
  });
  $('#btn-clear-chat').addEventListener('click', clearChat);
  $('#btn-reset').addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Reset this project?',
      message: 'Your views, chat, and settings in this browser will be wiped. This cannot be undone.',
      confirmLabel: 'Reset project',
    });
    if (!ok) return;
    store.reset();
    project = store.load();
    activeViewId = null;
    resetPanes();
    clearAvatar();
    refreshSignerStatus();
    $('#project-name').textContent = project.name;
    renderTabs(); renderActiveView(); renderChatHistory();
  });

  if (!isConnected()) {
    setStatus('Log in (top right) with a Claude, OpenAI, or Gemini key — or an OpenAI-compatible endpoint — to start, then ask Amy to build a view.');
  } else {
    nudgeConnectSigner();
  }
}

init();
