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
