// views.js — runtime for the interfaces Amy builds.
//
// A "view" is a string of JavaScript. We execute it with two arguments:
//   render(root, api)
// where `root` is a fresh DOM element to populate and `api` exposes Nostr
// access, the signer, formatting helpers, and per-view persistent state.
//
// The whole premise of this app is that the user is building their OWN client,
// so executing model-generated code in their own page is the intended design —
// not an injection vector. Keep that in mind if you adapt this for multi-user.

import * as nostr from './nostr.js';

// Small helpers exposed to view code so it doesn't reinvent the basics.
function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== undefined && v !== null) node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

function timeAgo(unixSeconds) {
  const s = Math.floor(Date.now() / 1000) - unixSeconds;
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/**
 * Build the api object handed to a view.
 * @param {object} ctx - { relays, getState, setState }
 */
function makeApi(ctx) {
  return {
    relays: ctx.relays,
    signer: nostr.signer,
    nip19: nostr.nip19,
    query: (filters, opts) => nostr.query(ctx.relays, filters, opts),
    subscribe: (filters, onEvent, opts) => nostr.subscribe(ctx.relays, filters, onEvent, opts),
    publish: (draft) => nostr.publish(ctx.relays, draft),
    // tiny dom + format helpers
    el,
    timeAgo,
    // per-view persisted state (survives reloads)
    getState: ctx.getState,
    setState: ctx.setState,
  };
}

/**
 * Render a view into `host`.
 * @param {HTMLElement} host
 * @param {object} view - { id, title, code }
 * @param {object} ctx - { relays, getState, setState, onCleanup }
 */
export function runView(host, view, ctx) {
  host.innerHTML = '';
  const root = el('div', { class: 'view-host' });
  host.append(root);
  const api = makeApi(ctx);
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function('root', 'api', view.code);
    const maybeCleanup = fn(root, api);
    if (typeof maybeCleanup === 'function' && ctx.onCleanup) ctx.onCleanup(maybeCleanup);
  } catch (err) {
    root.append(el('div', { class: 'view-error', text: `View "${view.title}" failed:\n${err.stack || err}` }));
  }
}
