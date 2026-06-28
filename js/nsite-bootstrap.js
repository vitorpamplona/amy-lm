// nsite-bootstrap.js — the runtime that boots an EXPORTED Amy nsite.
//
// This file is never imported by the app itself. The nsite exporter ships it as
// `/js/bootstrap.js` inside the published site, next to Amy's real view runtime
// (views.js / nostr.js / nip19.js / markdown.js / theme.js). It loads
// `/project.json` and renders the author's saved views with the same canvas +
// tabs they built — a self-contained, serverless client that anyone can open at
// the nsite's address.

import * as views from './views.js';
import * as theme from './theme.js';

// The shell chrome. Views bring their own styling and inherit the theme tokens
// from the bundled style.css, so this only needs to lay out the bar + tabs.
const SHELL_CSS = `
  body { margin:0; min-height:100vh; background:var(--bg); color:var(--text);
    font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
  #nsite-bar { display:flex; align-items:center; justify-content:space-between; gap:12px;
    padding:10px 16px; border-bottom:1px solid var(--border); background:var(--panel);
    position:sticky; top:0; z-index:5; }
  .nsite-brand { display:flex; align-items:center; gap:9px; font-size:15px; font-weight:700; }
  .nsite-logo { color:var(--accent); }
  .nsite-actions { display:flex; align-items:center; gap:12px; }
  .nsite-built { color:var(--muted); text-decoration:none; font-size:12px; }
  .nsite-built:hover { color:var(--accent); }
  .nsite-theme { background:var(--panel-2); border:1px solid var(--border); color:var(--text);
    border-radius:8px; width:32px; height:32px; cursor:pointer; font-size:14px; }
  #nsite-tabs { display:flex; gap:4px; flex-wrap:wrap; padding:12px 16px 0; }
  .nsite-tab { padding:6px 12px; border:1px solid var(--border); border-bottom:none;
    border-radius:8px 8px 0 0; background:var(--panel-2); color:var(--muted);
    cursor:pointer; font-weight:600; }
  .nsite-tab.active { background:var(--panel); color:var(--text); }
  #nsite-body { padding:16px; border-top:1px solid var(--border); }
  .nsite-empty { color:var(--muted); padding:48px 16px; text-align:center; }
`;

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

async function boot() {
  const style = document.createElement('style');
  style.textContent = SHELL_CSS;
  document.head.append(style);

  let project;
  try {
    const res = await fetch(new URL('../project.json', import.meta.url));
    if (!res.ok) throw new Error(res.status);
    project = await res.json();
  } catch (e) {
    document.body.append(el('div', 'nsite-empty', 'Could not load this nsite (project.json missing).'));
    return;
  }
  if (project.name) document.title = project.name;
  render(project);
}

function render(project) {
  const list = Array.isArray(project.views) ? project.views : [];
  // A version suffix only helps when a view actually has more than one exported
  // version; otherwise the bare title reads cleaner.
  const lineageCounts = {};
  for (const v of list) lineageCounts[v.lineage] = (lineageCounts[v.lineage] || 0) + 1;
  const label = (v) => (lineageCounts[v.lineage] > 1 ? `${v.title} v${v.version}` : v.title);

  // Header
  const bar = el('header'); bar.id = 'nsite-bar';
  const brand = el('div', 'nsite-brand');
  brand.append(el('span', 'nsite-logo', '⚡'), el('span', null, project.name || 'Amy nsite'));
  const actions = el('div', 'nsite-actions');
  const built = el('a', 'nsite-built', 'Built with Amy');
  built.href = project.builtWith || 'https://github.com/vitorpamplona/amy-lm';
  built.target = '_blank'; built.rel = 'noopener';
  const themeBtn = el('button', 'nsite-theme'); themeBtn.type = 'button';
  const paintTheme = () => { themeBtn.textContent = theme.current() === 'dark' ? '☀' : '☾'; };
  paintTheme();
  themeBtn.onclick = () => { theme.toggle(); paintTheme(); };
  actions.append(built, themeBtn);
  bar.append(brand, actions);

  const tabs = el('div'); tabs.id = 'nsite-tabs';
  const body = el('div'); body.id = 'nsite-body';
  document.body.append(bar, tabs, body);

  if (!list.length) {
    body.append(el('div', 'nsite-empty', 'This nsite has no views.'));
    return;
  }

  // One mounted pane per view, like the app: render lazily, keep scroll on switch.
  const panes = new Map();
  const states = {};
  const ns = `amy.nsite.${project.key || 'root'}`;
  let active = list[0].id;

  const mount = (v) => {
    const pane = el('div'); pane.style.display = 'none';
    body.append(pane);
    const entry = { el: pane, cleanups: [], rendered: false, view: v };
    panes.set(v.id, entry);
    return entry;
  };
  for (const v of list) mount(v);

  const show = (id) => {
    active = id;
    for (const t of tabs.children) t.classList.toggle('active', t.dataset.id === id);
    for (const [vid, entry] of panes) {
      const on = vid === id;
      entry.el.style.display = on ? '' : 'none';
      if (on && !entry.rendered) {
        entry.rendered = true;
        views.runView(entry.el, entry.view, {
          relays: project.relays || [],
          pubkey: null, // anonymous visitor — search falls back to public indexers
          getState: () => states[vid] || (states[vid] = loadState(ns, vid)),
          setState: (obj) => { states[vid] = { ...(states[vid] || {}), ...obj }; saveState(ns, vid, states[vid]); },
          onCleanup: (fn) => entry.cleanups.push(fn),
          agent: null, // no LLM key travels with a published site
        });
      }
    }
  };

  for (const v of list) {
    const tab = el('div', 'nsite-tab', label(v));
    tab.dataset.id = v.id;
    tab.onclick = () => show(v.id);
    tabs.append(tab);
  }
  show(active);
}

function loadState(ns, id) {
  try { return JSON.parse(localStorage.getItem(`${ns}.${id}`)) || {}; } catch { return {}; }
}
function saveState(ns, id, state) {
  try { localStorage.setItem(`${ns}.${id}`, JSON.stringify(state)); } catch {}
}

boot();
