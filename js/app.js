// app.js — wires everything together: project state, the view canvas,
// the Claude chat, and the tools that let Claude build the client.

import * as store from './storage.js';
import * as nostr from './nostr.js';
import * as views from './views.js';
import * as theme from './theme.js';
import { initNsiteExport } from './nsite-ui.js';
import { initSigner } from './signer-ui.js';
import { initConnect } from './connect-ui.js';
import { initSettings } from './settings-ui.js';
import { converse, complete } from './llm.js';
import { SYSTEM, TOOLS } from './agent.js';

// Dialog controllers (signer identity, LLM login, settings) live in their own
// modules; app.js is the composition root that wires them in init() and holds
// the returned handles for the few cross-cutting actions it still triggers.
let signerUi = null;
let connectUi = null;

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

// Strip a trailing "v3" the model might tack on so we don't render "Feed v3 v4";
// the version number is appended from view.version, not the title.
function cleanTitle(t) { return String(t || 'View').replace(/\s*v\d+\s*$/i, '').trim() || 'View'; }

// Views in lineage order: lineages by first appearance, versions ascending
// within each, so successive versions of one view sit together in the tab strip.
function orderedViews() {
  const groups = [];
  const at = new Map();
  for (const v of project.views) {
    if (!at.has(v.lineage)) { at.set(v.lineage, groups.length); groups.push([]); }
    groups[at.get(v.lineage)].push(v);
  }
  return groups.flatMap((g) => g.slice().sort((a, b) => a.version - b.version));
}

// The same data, grouped — what list_views returns and what canvasContext renders.
function viewGroups() {
  const groups = [];
  const at = new Map();
  for (const v of orderedViews()) {
    if (!at.has(v.lineage)) { at.set(v.lineage, groups.length); groups.push({ lineage: v.lineage, title: v.title, versions: [] }); }
    const g = groups[at.get(v.lineage)];
    g.title = v.title; // keep the newest title for the lineage label
    g.versions.push({ id: v.id, version: v.version, active: v.id === activeViewId });
  }
  return groups;
}

// A live snapshot of the canvas, appended to the system prompt each turn so the
// model can resolve "this view" / "go back" / "v2" against what's on screen.
function canvasContext() {
  if (!project.views.length) return '\n\n## Current canvas\n(No views yet — the canvas is empty.)';
  const active = project.views.find((v) => v.id === activeViewId);
  const focus = active ? `"${active.title} v${active.version}" (id: ${active.id})` : 'none';
  const lines = viewGroups().map((g) => {
    const vers = g.versions.map((x) => `v${x.version} (id ${x.id})${x.active ? ' ← ACTIVE' : ''}`).join(' · ');
    return `  • ${g.title} — ${vers}`;
  });
  return [
    '\n\n## Current canvas (live — reflects what the user sees right now)',
    `The user is currently looking at: ${focus}.`,
    'All views, grouped by lineage:',
    ...lines,
    'When the user says "this view", "the current one", "go back", or names a version like "v2", resolve it against THIS list — do not guess from chat history. To improve a version, call save_view with fromId set to it (which creates the next version as a new tab) rather than overwriting. After saving, tell the user which version you produced, e.g. "Updated Feed v3 → created Feed v4."',
  ].join('\n');
}

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
      const title = cleanTitle(input.title);
      // id => overwrite that exact version in place (rare). Otherwise create a
      // new view: a next version when fromId points at an existing lineage, else
      // a fresh v1.
      let view = input.id ? project.views.find((v) => v.id === input.id) : null;
      if (view) {
        view.title = title;
        view.code = input.code;
      } else {
        const source = input.fromId ? project.views.find((v) => v.id === input.fromId) : null;
        const lineage = source ? source.lineage : uid();
        const version = source
          ? Math.max(...project.views.filter((v) => v.lineage === lineage).map((v) => v.version)) + 1
          : 1;
        view = { id: uid(), title, lineage, version, code: input.code, createdAt: Date.now(), state: {} };
        project.views.push(view);
      }
      activeViewId = view.id;
      persist();
      renderTabs();
      renderActiveView();
      return `Saved "${view.title} v${view.version}" (id: ${view.id}) and opened it on the canvas.`;
    }
    case 'list_views':
      return JSON.stringify(viewGroups());
    case 'read_view': {
      const view = project.views.find((v) => v.id === input.id);
      if (!view) return `No view with id ${input.id}.`;
      return JSON.stringify({ id: view.id, title: view.title, version: view.version, lineage: view.lineage, code: view.code });
    }
    case 'delete_view': {
      const before = project.views.length;
      const gone = project.views.find((v) => v.id === input.id);
      project.views = project.views.filter((v) => v.id !== input.id);
      if (activeViewId === input.id) {
        // Prefer the latest surviving version of the same lineage; otherwise the
        // first remaining view.
        const sibling = project.views
          .filter((v) => gone && v.lineage === gone.lineage)
          .sort((a, b) => b.version - a.version)[0];
        activeViewId = (sibling || project.views[0])?.id || null;
      }
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
  let prevLineage = null;
  for (const v of orderedViews()) {
    const tab = document.createElement('div');
    // Gap before the first tab of each new lineage so versions of one view read
    // as a group in the strip.
    const groupStart = prevLineage !== null && v.lineage !== prevLineage;
    tab.className = 'tab' + (v.id === activeViewId ? ' active' : '') + (groupStart ? ' lineage-start' : '');
    prevLineage = v.lineage;
    const label = document.createElement('span');
    label.textContent = `${v.title} v${v.version}`;
    label.onclick = () => { activeViewId = v.id; persist(); renderTabs(); renderActiveView(); };
    const x = document.createElement('span');
    x.className = 'x';
    x.textContent = '×';
    x.title = 'Delete view';
    x.onclick = async (e) => {
      e.stopPropagation();
      const ok = await confirmDialog({
        title: 'Close this view?',
        message: `“${v.title} v${v.version}” will be deleted permanently. This cannot be undone.`,
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
          const sys = opts.system || 'You are a helpful assistant.';
          const combined = `System:\n${sys}\n\nPrompt:\n${prompt}`;
          const estTokens = Math.round(combined.length / 4).toLocaleString();
          const preview = combined.length > 1800 ? combined.slice(0, 1800) + '…' : combined;
          const allowed = await confirmDialog({
            title: `A view wants to call the AI  (~${estTokens} tokens)`,
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
  if (!connectUi.isConnected()) { connectUi.open(); setStatus('Connect an LLM to start.'); return; }

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
      system: SYSTEM + canvasContext(),
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
// Boot
// ---------------------------------------------------------------------------
function init() {
  // Compose the dialog controllers. Order matters: connect needs the signer's
  // post-login nudge, and settings needs connect's connection-status refresh.
  signerUi = initSigner({
    getProject: () => project,
    persist,
    setStatus,
    onRelaysChanged: () => { resetPanes(); renderActiveView(); },
  });
  connectUi = initConnect({
    getProject: () => project,
    persist,
    setStatus,
    afterConnect: signerUi.nudge,
  });
  initSettings({
    getProject: () => project,
    persist,
    onSaved: () => { $('#project-name').textContent = project.name; resetPanes(); renderActiveView(); },
    refreshConnectionStatus: connectUi.refreshStatus,
  });
  initNsiteExport(() => project);

  $('#project-name').textContent = project.name;
  renderTabs();
  renderActiveView();
  renderChatHistory();
  signerUi.refreshStatus();
  signerUi.restore();
  connectUi.refreshStatus();

  $('#composer').addEventListener('submit', onSend);
  $('#prompt').addEventListener('keydown', (e) => {
    // Enter sends; Shift+Enter inserts a newline.
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend(e); }
  });
  // Grow the composer with its content, up to the CSS max-height.
  $('#prompt').addEventListener('input', autoGrowPrompt);
  refreshThemeButton();
  $('#btn-theme').addEventListener('click', () => { theme.toggle(); refreshThemeButton(); });

  // User menu dropdown (holds the nav actions, opened from the avatar).
  const userBtn = $('#user-menu-btn');
  const dropdown = $('#user-dropdown');
  const closeMenu = () => { dropdown.hidden = true; userBtn.setAttribute('aria-expanded', 'false'); };
  const openMenu = () => { dropdown.hidden = false; userBtn.setAttribute('aria-expanded', 'true'); };
  userBtn.addEventListener('click', (e) => { e.stopPropagation(); dropdown.hidden ? openMenu() : closeMenu(); });
  dropdown.addEventListener('click', (e) => { if (e.target.closest('.menu-item')) closeMenu(); });
  document.addEventListener('click', (e) => { if (!e.target.closest('.user-menu')) closeMenu(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });

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
    signerUi.clearAvatar();
    signerUi.refreshStatus();
    $('#project-name').textContent = project.name;
    renderTabs(); renderActiveView(); renderChatHistory();
  });

  if (!connectUi.isConnected()) {
    setStatus('Log in (top right) with a Claude, OpenAI, or Gemini key — or an OpenAI-compatible endpoint — to start, then ask Amy to build a view.');
  } else {
    signerUi.nudge();
  }
}

init();
