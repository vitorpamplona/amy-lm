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

// The AsyncFunction constructor isn't a global, so reach it via an async fn's
// prototype. Compiling view code with it lets views use top-level `await`.
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

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
  const seeds = ctx.relays; // discovery/fallback relays from settings
  return {
    relays: seeds,
    signer: nostr.signer,
    nip19: nostr.nip19,
    // Outbox model (NIP-65) is the DEFAULT: reads are routed to each author's
    // own write relays, writes go to the user's own write relays. `seeds` are
    // only used to discover relay lists and as a fallback for users who have
    // none. Don't pass relay lists around — just give filters with `authors`.
    query: (filters, opts) => nostr.outboxQuery(seeds, filters, opts),
    subscribe: (filters, onEvent, opts) => nostr.outboxSubscribe(seeds, filters, onEvent, opts),
    publish: (draft, opts) => nostr.outboxPublish(seeds, draft, opts),
    // Resolve a user's NIP-65 outbox relay list -> { read, write } (cached).
    relayListFor: (pubkey, opts) => nostr.relayListFor(pubkey, seeds, opts),
    // Resolve any other per-NIP relay list -> string[] (cached). e.g. kind
    // 10050 = NIP-17 DM relays, 10007 = search relays, 10063 = media servers.
    relaysFromList: (pubkey, kind, opts) => nostr.relaysFromList(pubkey, kind, seeds, opts),
    // Escape hatch: talk to explicit relays, bypassing outbox routing. Use only
    // when a view genuinely needs a fixed relay (e.g. a single-relay browser).
    queryAt: (relays, filters, opts) => nostr.query(relays, filters, opts),
    subscribeAt: (relays, filters, onEvent, opts) => nostr.subscribe(relays, filters, onEvent, opts),
    publishAt: (relays, draft) => nostr.publish(relays, draft),
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
  const fail = (err) => {
    root.append(el('div', { class: 'view-error', text: `View "${view.title}" failed:\n${err.stack || err}` }));
  };
  try {
    // View code may use top-level `await`, so compile it as an async function.
    // eslint-disable-next-line no-new-func
    const fn = new AsyncFunction('root', 'api', view.code);
    // Async functions always return a promise; resolve it to get the optional
    // cleanup callback, and surface any rejection in the view itself.
    Promise.resolve(fn(root, api))
      .then((maybeCleanup) => {
        if (typeof maybeCleanup === 'function' && ctx.onCleanup) ctx.onCleanup(maybeCleanup);
      })
      .catch(fail);
  } catch (err) {
    fail(err);
  }
}
