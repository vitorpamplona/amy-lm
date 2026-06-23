// app.js — wires everything together: project state, the view canvas,
// the Claude chat, and the tools that let Claude build the client.

import * as store from './storage.js';
import * as nostr from './nostr.js';
import * as views from './views.js';
import * as theme from './theme.js';
import { converse } from './claude.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let project = store.load();
let activeViewId = project.views[0]?.id || null;
const viewCleanups = []; // teardown fns for the currently-rendered view

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

api surface:
- api.relays            -> string[] of the user's relay URLs
- api.query(filters, opts?) -> Promise<event[]> (one-shot; newest-first, de-duplicated). filters is a NIP-01 filter or array of them. opts.timeout ms.
- api.subscribe(filters, onEvent, opts?) -> returns an unsubscribe() function (live, incl. new events). If you call subscribe, RETURN the unsubscribe function from your code so it is cleaned up when the view closes.
- api.publish({ kind, content, tags? }) -> Promise<{event, results}> (signs via the user's NIP-07 extension).
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
    description: 'Run a one-shot Nostr query against the user\'s relays and return matching events (capped). Use to inspect real data before building a view.',
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
    description: 'Get the current signer public key (if connected) and the configured relays.',
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
      const events = await nostr.query(project.settings.relays, input.filters, { timeout: input.timeout ?? 4000 });
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

function teardownView() {
  while (viewCleanups.length) {
    try { viewCleanups.pop()(); } catch {}
  }
}

function renderActiveView() {
  teardownView();
  const body = $('#canvas-body');
  const view = project.views.find((v) => v.id === activeViewId);
  if (!view) {
    body.innerHTML = '';
    body.append(buildEmptyState());
    return;
  }
  body.innerHTML = '';
  views.runView(body, view, {
    relays: project.settings.relays,
    getState: () => view.state || (view.state = {}),
    setState: (obj) => { view.state = { ...(view.state || {}), ...obj }; persist(); },
    onCleanup: (fn) => viewCleanups.push(fn),
  });
}

function buildEmptyState() {
  const tpl = document.createElement('div');
  tpl.className = 'empty';
  tpl.innerHTML = `<h2>Your client is empty.</h2>
    <p>Amy knows Nostr, how to read NIPs, and how to talk to your NIP-07 signer. Ask the chat on the right to build an interface — a feed, a profile card, a publish box — and it will appear here as a live view.</p>
    <ul class="suggestions">
      <li>“Build me a view that shows the latest 20 notes (kind 1) from my relays.”</li>
      <li>“Make a profile card for an npub I paste in.”</li>
      <li>“Give me a box to publish a short text note, signed by my extension.”</li>
      <li>“Read NIP-51 and build a view of my bookmarked notes.”</li>
    </ul>`;
  return tpl;
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
  if (!project.settings.apiKey) { openSettings(); setStatus('Add an Anthropic API key to start.'); return; }

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
  // Show the icon for the mode you'd switch *to*.
  btn.textContent = dark ? '☀' : '☾';
  btn.title = dark ? 'Switch to light theme' : 'Switch to dark theme';
}

// ---------------------------------------------------------------------------
// Signer + settings
// ---------------------------------------------------------------------------
async function refreshSignerStatus() {
  const pill = $('#signer-status');
  if (!nostr.signer.available()) { pill.textContent = 'no signer'; pill.classList.remove('ok'); return; }
  pill.textContent = 'signer ready';
  pill.classList.add('ok');
}

async function connectSigner() {
  if (!nostr.signer.available()) { setStatus('No NIP-07 extension found. Install e.g. Alby or nos2x.'); return; }
  try {
    const pk = await nostr.signer.getPublicKey();
    const pill = $('#signer-status');
    pill.textContent = nostr.nip19.npubEncode(pk).slice(0, 12) + '…';
    pill.classList.add('ok');
  } catch (err) {
    setStatus('Signer connection denied.');
  }
}

function openSettings() {
  $('#set-apikey').value = project.settings.apiKey;
  $('#set-model').value = project.settings.model;
  $('#set-relays').value = project.settings.relays.join('\n');
  $('#set-projname').value = project.name;
  $('#settings-dialog').showModal();
}

function saveSettingsFromForm() {
  project.settings.apiKey = $('#set-apikey').value.trim();
  project.settings.model = $('#set-model').value.trim() || 'claude-opus-4-8';
  project.settings.relays = $('#set-relays').value.split('\n').map((s) => s.trim()).filter(Boolean);
  project.name = $('#set-projname').value.trim() || 'untitled project';
  persist();
  $('#project-name').textContent = project.name;
  renderActiveView(); // relays may have changed
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

  $('#composer').addEventListener('submit', onSend);
  $('#prompt').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onSend(e); }
  });
  refreshThemeButton();
  $('#btn-theme').addEventListener('click', () => { theme.toggle(); refreshThemeButton(); });
  $('#btn-connect-signer').addEventListener('click', connectSigner);
  $('#btn-settings').addEventListener('click', openSettings);
  $('#settings-dialog').addEventListener('close', () => {
    if ($('#settings-dialog').returnValue === 'save') saveSettingsFromForm();
  });
  $('#btn-reset').addEventListener('click', () => {
    if (!confirm('Wipe this local project (views, chat, settings)? This cannot be undone.')) return;
    store.reset();
    project = store.load();
    activeViewId = null;
    $('#project-name').textContent = project.name;
    renderTabs(); renderActiveView(); renderChatHistory();
  });

  if (!project.settings.apiKey) setStatus('Open Settings to add your Anthropic API key, then ask Amy to build a view.');
}

init();
