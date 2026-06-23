// app.js — wires everything together: project state, the view canvas,
// the Claude chat, and the tools that let Claude build the client.

import * as store from './storage.js';
import * as nostr from './nostr.js';
import * as views from './views.js';
import * as theme from './theme.js';
import { converse } from './llm.js';
import { verifyApiKey, detectProvider, PROVIDERS } from './auth.js';

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

// ---------------------------------------------------------------------------
// System prompt — teaches Claude what it is and the view contract
// ---------------------------------------------------------------------------
const SYSTEM = `You are Amy, the assistant at the center of a self-building Nostr client that runs entirely in the user's browser (no server). Your job is to build and edit small interfaces ("views") for the Nostr events the user cares about, in response to plain-language requests.

You know the Nostr protocol (NIP-01 events: { id, pubkey, created_at, kind, tags, content, sig }; common kinds: 0 = profile metadata, 1 = short text note, 3 = contacts, 7 = reaction). When you need details about a NIP, call read_nip — do not guess.

## Building views
To create or update an interface, call save_view with a 'code' string. The code is the BODY of a function called as render(root, api):
- 'root' is a fresh <div> you populate with DOM.
- 'api' provides everything you need. DO NOT import anything; only use 'api', 'root', and standard browser globals.

## Relays: use the outbox model (NIP-65) by default
Nostr has no central server — each user reads and writes on THEIR OWN relays. The right way to find someone's events is to fetch them from the relays that user publishes to (their "write"/outbox relays), NOT from one fixed relay list. api.query/api.subscribe/api.publish already do this for you: they look up each author's NIP-65 relay list and route per-author automatically. So the rule is: just give filters with 'authors' and let the api route — do NOT collect, hardcode, or pass relay URLs around. api.relays is only a small set of discovery/seed relays used to bootstrap those lookups and as a fallback for users who have no relay list anywhere; do not treat it as "the relays for everything." Only reach for api.queryAt/api.subscribeAt/api.publishAt (explicit relays) when a view genuinely needs a specific fixed relay, e.g. a single-relay browser.

api surface:
- api.query(filters, opts?) -> Promise<event[]> (one-shot; newest-first, de-duplicated; outbox-routed by author). filters is a NIP-01 filter or array of them. opts.timeout ms.
- api.subscribe(filters, onEvent, opts?) -> returns an unsubscribe() function (live, incl. new events; outbox-routed). If you call subscribe, RETURN the unsubscribe function from your code so it is cleaned up when the view closes.
- api.publish({ kind, content, tags? }, opts?) -> Promise<{event, results}> (signs via the user's NIP-07 extension; sends to the user's own write relays).
- api.relayListFor(pubkey, opts?) -> Promise<{ read: string[], write: string[] }> a user's NIP-65 relay list (cached). Useful for inbox features (reach a user on their read relays) or showing where someone publishes.
- api.relays -> string[] of discovery/seed/fallback relay URLs (NOT a per-user list; see above).
- api.queryAt(relays, filters, opts?) / api.subscribeAt(relays, filters, onEvent, opts?) / api.publishAt(relays, draft) -> explicit-relay escape hatches that bypass outbox routing.
- api.signer.getPublicKey() -> Promise<hex pubkey>
- api.nip19.npubEncode(hex) / .noteEncode(hex) / .decode(str) / .toHexPubkey(npubOrHex)
- api.el(tag, props?, children?) -> element. props: { class, text, style:{}, onClick, ...attrs }. children: node | string | array.
- api.timeAgo(unixSeconds) -> "5m ago"
- api.getState() / api.setState(obj) -> small per-view persisted state (survives reloads).

Guidance:
- Write self-contained, defensive code. Show a loading state, then render. Catch errors and show them in 'root'.
- Profile (kind 0) content is JSON: parse for { name, display_name, picture, about }.
- The host app provides matching light and dark themes. Inline styles are fine, but prefer the host CSS variables so your view adapts to both: var(--text), var(--muted), var(--panel-2) / var(--panel-3) for surfaces, var(--border) for lines, var(--accent) and var(--accent-2) for emphasis, var(--radius) for corners. Avoid hard-coded black/white backgrounds.
- Prefer api.query for fetch-once lists; use api.subscribe only for live feeds.
- When the user references an account by npub, convert with api.nip19.toHexPubkey before using it in filters (authors are hex).

When you update an existing view, reuse its id (call list_views first if unsure). Keep titles short. After building, briefly tell the user what you made in one or two sentences. Do not paste the full code into the chat.`;

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------
const TOOLS = [
  {
    name: 'save_view',
    description: 'Create or update a view (an interface rendered on the canvas). Provide a short title and the render code body.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Existing view id to update; omit to create a new one.' },
        title: { type: 'string', description: 'Short human title for the tab.' },
        code: { type: 'string', description: 'JavaScript body of render(root, api). See system instructions.' },
      },
      required: ['title', 'code'],
    },
  },
  {
    name: 'list_views',
    description: 'List the current views with their ids and titles.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'delete_view',
    description: 'Delete a view by id.',
    input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'read_nip',
    description: 'Fetch the markdown text of a NIP from the official nostr-protocol/nips repository.',
    input_schema: {
      type: 'object',
      properties: { nip: { type: 'string', description: 'NIP number or filename, e.g. "01", "51", or "7".' } },
      required: ['nip'],
    },
  },
  {
    name: 'query_relays',
    description: 'Run a one-shot Nostr query and return matching events (capped). Routed via the outbox model (NIP-65): when the filter names authors, each author is queried on their own write relays, with the seed relays as fallback/discovery. Use to inspect real data before building a view.',
    input_schema: {
      type: 'object',
      properties: {
        filters: { type: 'object', description: 'A single NIP-01 filter object, e.g. {"kinds":[1],"limit":5}.' },
        timeout: { type: 'number', description: 'Max ms to wait (default 4000).' },
      },
      required: ['filters'],
    },
  },
  {
    name: 'get_context',
    description: 'Get the current signer public key (if connected) and the configured seed/discovery relays (the outbox-model fallback, not a per-user list).',
    input_schema: { type: 'object', properties: {} },
  },
];

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
    case 'get_context': {
      let pubkey = null;
      try { if (nostr.signer.available()) pubkey = await nostr.signer.getPublicKey(); } catch {}
      return JSON.stringify({ pubkey, npub: pubkey ? nostr.nip19.npubEncode(pubkey) : null, relays: project.settings.relays });
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
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
    x.onclick = (e) => { e.stopPropagation(); dispatch('delete_view', { id: v.id }); };
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
        getState: () => view.state || (view.state = {}),
        setState: (obj) => { view.state = { ...(view.state || {}), ...obj }; persist(); },
        onCleanup: (fn) => entry.cleanups.push(fn),
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
  if (!project.settings.apiKey) { openConnect(); setStatus('Connect Claude or Gemini to start.'); return; }

  $('#prompt').value = '';
  project.chat.push({ role: 'user', content: text });
  addMessageEl('user', text);
  persist();

  busy = true;
  $('#send').disabled = true;
  setStatus('Amy is thinking…');

  try {
    await converse({
      apiKey: project.settings.apiKey,
      provider: project.settings.provider,
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
  if (item && !nostr.signer.available()) item.textContent = 'Connect signer';
}

async function connectSigner() {
  if (!nostr.signer.available()) { setStatus('No NIP-07 extension found. Install e.g. Alby or nos2x.'); return; }
  try {
    const pk = await nostr.signer.getPublicKey();
    $('#btn-connect-signer').textContent = 'Signer connected';
    await loadUserProfile(pk);
  } catch (err) {
    setStatus('Signer connection denied.');
  }
}

// Show the user's avatar (kind 0 'picture') in the menu button. Falls back to
// the placeholder silhouette if there's no picture or the image fails to load.
function setAvatar(url, name) {
  const img = $('#user-avatar');
  const fallback = $('#user-avatar-fallback');
  const btn = $('#user-menu-btn');
  if (!img) return;
  btn.classList.add('connected');
  if (name) { btn.title = name; btn.setAttribute('aria-label', name); }
  if (!url) return;
  img.onload = () => { img.hidden = false; fallback.hidden = true; };
  img.onerror = () => { img.hidden = true; fallback.hidden = false; };
  img.src = url;
}

// Fetch the signed-in user's profile metadata (kind 0) and pull their picture.
async function loadUserProfile(pubkey) {
  try {
    const events = await nostr.outboxQuery(
      project.settings.relays,
      { kinds: [0], authors: [pubkey], limit: 1 },
      { timeout: 4000 },
    );
    const meta = events[0] ? JSON.parse(events[0].content || '{}') : {};
    setAvatar(meta.picture, meta.display_name || meta.name);
  } catch { /* keep the placeholder avatar */ }
}

function openSettings() {
  $('#set-model').value = project.settings.model;
  $('#set-relays').value = project.settings.relays.join('\n');
  $('#set-projname').value = project.name;
  refreshClaudeStatus();
  $('#settings-dialog').showModal();
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

function refreshClaudeStatus() {
  const connected = !!project.settings.apiKey;
  const provider = project.settings.provider || detectProvider(project.settings.apiKey);
  const label = provider ? PROVIDERS[provider].label : 'LLM';
  const pill = $('#claude-status');
  pill.textContent = connected ? `${label} connected` : 'not connected';
  pill.classList.toggle('ok', connected);
  $('#btn-connect-claude').textContent = connected ? label : 'Log in';
  // Settings mirror, if present.
  const state = $('#set-claude-state');
  if (state) {
    state.textContent = connected ? `Connected to ${label} (${maskKey(project.settings.apiKey)}).` : 'Not connected.';
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
  $('#connect-open-google').href = PROVIDERS.google.consoleUrl;
  $('#connect-apikey').value = project.settings.apiKey || '';
  $('#connect-disconnect').hidden = !project.settings.apiKey;
  setConnectStatus(project.settings.apiKey ? 'Connected. Paste a new key to replace it.' : '');
  if ($('#settings-dialog').open) $('#settings-dialog').close();
  $('#connect-dialog').showModal();
  $('#connect-apikey').focus();
}

// Live hint as the user types, so they know which provider their key maps to.
function reflectDetectedProvider() {
  const key = $('#connect-apikey').value.trim();
  if (!key) { setConnectStatus(''); return; }
  const provider = detectProvider(key);
  if (provider) setConnectStatus(`Detected a ${PROVIDERS[provider].label} key.`, 'ok');
  else setConnectStatus('Unrecognized key — expected sk-ant-… (Claude) or AIza…/AQ.… (Gemini).', '');
}

async function submitConnect() {
  const key = $('#connect-apikey').value.trim();
  const submit = $('#connect-submit');
  submit.disabled = true;
  setConnectStatus('Verifying with Anthropic…', '');
  try {
    const { provider, models } = await verifyApiKey(key);
    project.settings.apiKey = key;
    project.settings.provider = provider;
    // If the configured model isn't offered by this provider/account, fall back
    // to the provider default (or the first listed) so the first message works.
    if (!models.includes(project.settings.model)) {
      const def = PROVIDERS[provider].defaultModel;
      project.settings.model = models.includes(def) ? def : (models[0] || def);
    }
    persist();
    refreshClaudeStatus();
    setConnectStatus(`Connected to ${PROVIDERS[provider].label}! You can close this and start chatting.`, 'ok');
    setStatus('');
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
  persist();
  refreshClaudeStatus();
  $('#connect-apikey').value = '';
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
  refreshClaudeStatus();

  $('#composer').addEventListener('submit', onSend);
  $('#prompt').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onSend(e); }
  });
  refreshThemeButton();
  $('#btn-theme').addEventListener('click', () => { theme.toggle(); refreshThemeButton(); });
  $('#btn-connect-signer').addEventListener('click', connectSigner);

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
  $('#settings-dialog').addEventListener('close', () => {
    if ($('#settings-dialog').returnValue === 'save') saveSettingsFromForm();
  });

  // Log in with Claude
  $('#btn-connect-claude').addEventListener('click', openConnect);
  $('#set-manage-claude').addEventListener('click', openConnect);
  $('#connect-submit').addEventListener('click', submitConnect);
  $('#connect-cancel').addEventListener('click', () => $('#connect-dialog').close());
  $('#connect-disconnect').addEventListener('click', disconnectClaude);
  $('#connect-apikey').addEventListener('input', reflectDetectedProvider);
  $('#connect-apikey').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submitConnect(); }
  });
  $('#btn-reset').addEventListener('click', () => {
    if (!confirm('Wipe this local project (views, chat, settings)? This cannot be undone.')) return;
    store.reset();
    project = store.load();
    activeViewId = null;
    resetPanes();
    $('#project-name').textContent = project.name;
    renderTabs(); renderActiveView(); renderChatHistory();
  });

  if (!project.settings.apiKey) setStatus('Log in (top right) with a Claude or Gemini key to start, then ask Amy to build a view.');
}

init();
