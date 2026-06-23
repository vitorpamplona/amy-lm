// nostr.js — a tiny, dependency-free Nostr toolkit for the browser.
// Relay pool (NIP-01 REQ/EVENT/EOSE over WebSocket), NIP-07 signer access,
// and NIP-19 bech32 (npub/nsec/note) encode/decode helpers.

// ---------------------------------------------------------------------------
// NIP-07 signer (browser extension exposes window.nostr)
// ---------------------------------------------------------------------------
export const signer = {
  available() { return typeof window !== 'undefined' && !!window.nostr; },
  async getPublicKey() {
    if (!this.available()) throw new Error('No NIP-07 signer found (install a Nostr extension).');
    return window.nostr.getPublicKey();
  },
  async signEvent(event) {
    if (!this.available()) throw new Error('No NIP-07 signer found.');
    return window.nostr.signEvent(event);
  },
};

// ---------------------------------------------------------------------------
// Relay pool
// ---------------------------------------------------------------------------
const sockets = new Map(); // url -> WebSocket (kept warm and reused)

function connect(url) {
  let ws = sockets.get(url);
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return ws;
  ws = new WebSocket(url);
  ws._subs = new Map(); // subId -> { onEvent, onEose }
  ws.addEventListener('message', (m) => {
    let data;
    try { data = JSON.parse(m.data); } catch { return; }
    const [type, subId, payload] = data;
    const sub = ws._subs.get(subId);
    if (!sub) return;
    if (type === 'EVENT') sub.onEvent(payload);
    else if (type === 'EOSE') sub.onEose && sub.onEose();
  });
  ws.addEventListener('close', () => { if (sockets.get(url) === ws) sockets.delete(url); });
  sockets.set(url, ws);
  return ws;
}

function whenOpen(ws) {
  if (ws.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const ok = () => { cleanup(); resolve(); };
    const err = () => { cleanup(); reject(new Error('relay connection failed')); };
    const cleanup = () => { ws.removeEventListener('open', ok); ws.removeEventListener('error', err); };
    ws.addEventListener('open', ok);
    ws.addEventListener('error', err);
  });
}

let subCounter = 0;
function nextSubId() { return 'amy' + (++subCounter); }

/**
 * One-shot query across relays. Resolves with a de-duplicated, newest-first
 * array of events once every relay sends EOSE or `timeout` ms elapses.
 * @param {string[]} relays
 * @param {object|object[]} filters - NIP-01 filter(s)
 * @param {object} [opts] - { timeout=4000 }
 */
export async function query(relays, filters, opts = {}) {
  const timeout = opts.timeout ?? 4000;
  const filterArr = Array.isArray(filters) ? filters : [filters];
  const seen = new Map(); // id -> event
  const subId = nextSubId();

  const perRelay = relays.map((url) => new Promise((resolve) => {
    let done = false;
    const finish = () => { if (done) return; done = true; cleanup(); resolve(); };
    let ws, cleanup = () => {};
    try {
      ws = connect(url);
    } catch { return finish(); }
    ws._subs.set(subId, {
      onEvent: (ev) => { if (ev && ev.id && !seen.has(ev.id)) seen.set(ev.id, ev); },
      onEose: finish,
    });
    cleanup = () => {
      ws._subs.delete(subId);
      try { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(['CLOSE', subId])); } catch {}
    };
    whenOpen(ws)
      .then(() => ws.send(JSON.stringify(['REQ', subId, ...filterArr])))
      .catch(finish);
  }));

  await Promise.race([
    Promise.all(perRelay),
    new Promise((r) => setTimeout(r, timeout)),
  ]);

  return [...seen.values()].sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
}

/**
 * Live subscription. Calls onEvent for each event (incl. ones arriving after EOSE).
 * Returns an unsubscribe function.
 */
export function subscribe(relays, filters, onEvent, opts = {}) {
  const filterArr = Array.isArray(filters) ? filters : [filters];
  const subId = nextSubId();
  const seen = new Set();
  const closers = [];
  for (const url of relays) {
    let ws;
    try { ws = connect(url); } catch { continue; }
    ws._subs.set(subId, {
      onEvent: (ev) => { if (ev && ev.id && !seen.has(ev.id)) { seen.add(ev.id); onEvent(ev, url); } },
      onEose: opts.onEose,
    });
    whenOpen(ws).then(() => ws.send(JSON.stringify(['REQ', subId, ...filterArr]))).catch(() => {});
    closers.push(() => {
      ws._subs.delete(subId);
      try { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(['CLOSE', subId])); } catch {}
    });
  }
  return () => closers.forEach((c) => c());
}

/**
 * Sign (via NIP-07) and publish an event to the relays.
 * @param {string[]} relays
 * @param {object} draft - { kind, content, tags?, created_at? } (no id/sig/pubkey needed)
 * @returns {Promise<{event: object, results: Array}>}
 */
export async function publish(relays, draft) {
  const pubkey = await signer.getPublicKey();
  const unsigned = {
    kind: draft.kind,
    content: draft.content ?? '',
    tags: draft.tags || [],
    created_at: draft.created_at || Math.floor(Date.now() / 1000),
    pubkey,
  };
  const event = await signer.signEvent(unsigned);

  const results = await Promise.all(relays.map((url) => new Promise((resolve) => {
    let ws;
    try { ws = connect(url); } catch { return resolve({ url, ok: false, error: 'connect failed' }); }
    const onMsg = (m) => {
      let d; try { d = JSON.parse(m.data); } catch { return; }
      if (d[0] === 'OK' && d[1] === event.id) {
        ws.removeEventListener('message', onMsg);
        resolve({ url, ok: !!d[2], error: d[3] || null });
      }
    };
    ws.addEventListener('message', onMsg);
    whenOpen(ws)
      .then(() => ws.send(JSON.stringify(['EVENT', event])))
      .catch(() => resolve({ url, ok: false, error: 'connect failed' }));
    setTimeout(() => { ws.removeEventListener('message', onMsg); resolve({ url, ok: false, error: 'timeout' }); }, 5000);
  })));

  return { event, results };
}

// ---------------------------------------------------------------------------
// Outbox model (NIP-65) — route reads/writes to each user's own relays
//
// The "seed" relays passed in act as discovery/indexer relays: we ask them for
// a user's kind 10002 relay list, then talk to the relays that user actually
// uses. Seeds are only the fallback for users who have no relay list anywhere.
// ---------------------------------------------------------------------------
const relayListCache = new Map(); // pubkey -> { read: string[], write: string[] }

/** Parse a NIP-65 (kind 10002) event into { read, write } relay URL lists. */
export function parseRelayList(ev) {
  const read = [], write = [];
  for (const t of (ev && ev.tags) || []) {
    if (t[0] !== 'r' || !t[1]) continue;
    const marker = t[2];
    if (marker === 'read') read.push(t[1]);
    else if (marker === 'write') write.push(t[1]);
    else { read.push(t[1]); write.push(t[1]); } // unmarked = both
  }
  return { read, write };
}

/**
 * Resolve a user's NIP-65 relay list (cached). Bootstraps the lookup from the
 * seed relays. Always resolves — returns empty lists if none is found.
 * @returns {Promise<{read: string[], write: string[]}>}
 */
export async function relayListFor(pubkey, seedRelays, opts = {}) {
  if (!opts.force && relayListCache.has(pubkey)) return relayListCache.get(pubkey);
  let list = { read: [], write: [] };
  try {
    const evs = await query(seedRelays, { kinds: [10002], authors: [pubkey], limit: 1 }, { timeout: opts.timeout ?? 4000 });
    if (evs[0]) list = parseRelayList(evs[0]);
  } catch { /* fall through to empty */ }
  relayListCache.set(pubkey, list);
  return list;
}

// Build a Map<relayUrl, filters[]> by routing each author to their write
// relays (where they publish). Author-less filters and authors with no relay
// list fall back to the seeds.
async function routeByOutbox(seedRelays, filterArr, opts = {}) {
  const maxPerAuthor = opts.maxRelaysPerAuthor ?? 3;
  const routed = new Map();
  const add = (url, filter) => {
    if (!routed.has(url)) routed.set(url, []);
    routed.get(url).push(filter);
  };
  for (const filter of filterArr) {
    const authors = filter.authors;
    if (!authors || !authors.length) {
      for (const url of seedRelays) add(url, filter); // can't route without authors
      continue;
    }
    const lists = await Promise.all(authors.map((pk) => relayListFor(pk, seedRelays, opts)));
    const byRelay = new Map(); // url -> Set(pubkey)
    authors.forEach((pk, i) => {
      let write = lists[i].write;
      if (write.length > maxPerAuthor) write = write.slice(0, maxPerAuthor);
      if (!write.length) write = seedRelays; // no outbox anywhere -> fallback
      for (const url of write) {
        if (!byRelay.has(url)) byRelay.set(url, new Set());
        byRelay.get(url).add(pk);
      }
    });
    for (const [url, set] of byRelay) add(url, { ...filter, authors: [...set] });
  }
  return routed;
}

/** Outbox-routed one-shot query. Same return shape as query(). */
export async function outboxQuery(seedRelays, filters, opts = {}) {
  const filterArr = Array.isArray(filters) ? filters : [filters];
  const routed = await routeByOutbox(seedRelays, filterArr, opts);
  const seen = new Map();
  await Promise.all([...routed].map(async ([url, fs]) => {
    const evs = await query([url], fs, opts);
    for (const ev of evs) if (ev && ev.id && !seen.has(ev.id)) seen.set(ev.id, ev);
  }));
  return [...seen.values()].sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
}

/** Outbox-routed live subscription. Returns an unsubscribe function. */
export function outboxSubscribe(seedRelays, filters, onEvent, opts = {}) {
  const filterArr = Array.isArray(filters) ? filters : [filters];
  const seen = new Set();
  const wrapped = (ev, url) => { if (ev && ev.id && !seen.has(ev.id)) { seen.add(ev.id); onEvent(ev, url); } };
  let closers = [];
  let stopped = false;
  routeByOutbox(seedRelays, filterArr, opts).then((routed) => {
    if (stopped) return;
    for (const [url, fs] of routed) closers.push(subscribe([url], fs, wrapped, opts));
  }).catch(() => {});
  return () => { stopped = true; closers.forEach((c) => c()); };
}

/**
 * Outbox-aware publish: sign and send to the author's own write relays so the
 * wider network can find the event. Falls back to seeds if the author has no
 * relay list yet.
 */
export async function outboxPublish(seedRelays, draft, opts = {}) {
  const pubkey = await signer.getPublicKey();
  const list = await relayListFor(pubkey, seedRelays, opts);
  const targets = list.write.length ? list.write : seedRelays;
  return publish(targets, draft);
}

// ---------------------------------------------------------------------------
// NIP-19 (bech32) — npub / nsec / note encode & decode
// ---------------------------------------------------------------------------
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

function polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= GEN[i];
  }
  return chk;
}
function hrpExpand(hrp) {
  const out = [];
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
  return out;
}
function convertBits(data, from, to, pad) {
  let acc = 0, bits = 0;
  const out = [];
  const maxv = (1 << to) - 1;
  for (const value of data) {
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) { bits -= to; out.push((acc >> bits) & maxv); }
  }
  if (pad && bits > 0) out.push((acc << (to - bits)) & maxv);
  return out;
}
function bech32Encode(hrp, data) {
  const combined = data.concat(checksum(hrp, data));
  let s = hrp + '1';
  for (const d of combined) s += CHARSET[d];
  return s;
}
function checksum(hrp, data) {
  const values = hrpExpand(hrp).concat(data).concat([0, 0, 0, 0, 0, 0]);
  const mod = polymod(values) ^ 1;
  const out = [];
  for (let i = 0; i < 6; i++) out.push((mod >> (5 * (5 - i))) & 31);
  return out;
}
function bech32Decode(str) {
  const lower = str.toLowerCase();
  const pos = lower.lastIndexOf('1');
  const hrp = lower.slice(0, pos);
  const data = [];
  for (const ch of lower.slice(pos + 1)) data.push(CHARSET.indexOf(ch));
  return { hrp, data: data.slice(0, -6) };
}
function bytesToHex(bytes) { return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(''); }
function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

export const nip19 = {
  // hex -> npub
  npubEncode(hex) { return bech32Encode('npub', convertBits(hexToBytes(hex), 8, 5, true)); },
  noteEncode(hex) { return bech32Encode('note', convertBits(hexToBytes(hex), 8, 5, true)); },
  // npub/note/nsec -> { type, data (hex) }
  decode(str) {
    const { hrp, data } = bech32Decode(str.trim());
    const bytes = convertBits(data, 5, 8, false);
    return { type: hrp, data: bytesToHex(bytes) };
  },
  // Accepts npub or hex; always returns hex pubkey
  toHexPubkey(input) {
    const s = (input || '').trim();
    if (s.startsWith('npub')) return this.decode(s).data;
    return s;
  },
};
