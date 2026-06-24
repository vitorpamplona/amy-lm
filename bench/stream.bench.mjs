// stream.bench.mjs — proves the streaming query family emits-and-discards.
//
// queryStream()/outboxQueryStream() are like query() but call onEvent(ev, url)
// for each event as it is de-duped across relays, retaining only ids — so a
// caller can process and throw each event away instead of holding the whole
// result set. This checks the three properties that matter:
//   1. PARITY     — it emits exactly the unique id set query() returns.
//   2. INCREMENTAL — events stream across pages (you don't wait for all pages).
//   3. MEMORY     — with a discarding callback it retains only ids, so its heap
//                   stays far below query()'s (which buffers every event).
// The memory check is real because nostr.js JSON.parses each incoming message
// into a FRESH object: query() keeps them all alive, queryStream() lets them GC.

import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const now = Math.floor(Date.now() / 1000);
const since = now - 7 * 86400;
const PAGE_CAP = 100;
const BIG = 'x'.repeat(2048); // ~2 KB content so retained events are measurable

// ---- network: N relays, POPULAR events on every relay (cross-relay dups) +
//      PER unique events each. Distinct seconds so pagination is clean. --------
const N = 30, POPULAR = 200, PER = 100;
const relays = Array.from({ length: N }, (_, i) => `wss://r${i}`);
const DB = new Map();
for (let r = 0; r < N; r++) {
  const arr = [];
  for (let j = 0; j < POPULAR; j++) arr.push({ id: `pop-${j}`, pubkey: 'p', kind: 1, created_at: now - 1 - j, tags: [], content: BIG, sig: '' });
  for (let i = 0; i < PER; i++) { const s = POPULAR + r * PER + i; arr.push({ id: `u${r}-${i}`, pubkey: 'p', kind: 1, created_at: now - 1 - s, tags: [], content: BIG, sig: '' }); }
  DB.set(relays[r], arr);
}
const EXPECT_UNIQUE = POPULAR + N * PER; // 200 + 30*100 = 3200

const reqsPerRelay = new Map();
class MockWebSocket {
  constructor(url) { this.url = url; this.readyState = 0; this._l = {}; setTimeout(() => { this.readyState = 1; this._emit('open', {}); }, 0); }
  addEventListener(t, fn) { (this._l[t] || (this._l[t] = new Set())).add(fn); }
  removeEventListener(t, fn) { this._l[t] && this._l[t].delete(fn); }
  _emit(t, e) { if (this._l[t]) for (const fn of [...this._l[t]]) fn(e); }
  send(data) {
    let msg; try { msg = JSON.parse(data); } catch { return; }
    const [verb, subId, ...filters] = msg;
    if (verb === 'CLOSE') return;
    if (verb !== 'REQ') return;
    reqsPerRelay.set(this.url, (reqsPerRelay.get(this.url) || 0) + 1);
    const f = filters[0] || {};
    let evs = (DB.get(this.url) || []).filter((e) => (f.since === undefined || e.created_at >= f.since) && (f.until === undefined || e.created_at <= f.until));
    evs.sort((a, b) => b.created_at - a.created_at);
    evs = evs.slice(0, Math.min(typeof f.limit === 'number' ? f.limit : Infinity, PAGE_CAP));
    setTimeout(() => { for (const e of evs) this._emit('message', { data: JSON.stringify(['EVENT', subId, e]) }); this._emit('message', { data: JSON.stringify(['EOSE', subId]) }); }, 0);
  }
  close() { this.readyState = 3; }
}
MockWebSocket.CONNECTING = 0; MockWebSocket.OPEN = 1; MockWebSocket.CLOSING = 2; MockWebSocket.CLOSED = 3;
globalThis.WebSocket = MockWebSocket;
const nostr = await import(pathToFileURL(join(ROOT, 'js', 'nostr.js')).href);

const filter = { since, limit: 100000 };
let failed = 0;
const check = (d, fn) => { try { fn(); console.log(`  ✓ ${d}`); } catch (e) { failed++; console.log(`  ✗ ${d}\n      ${e.message}`); } };
const heap = () => { if (global.gc) global.gc(); return process.memoryUsage().heapUsed; };

console.log('\nStreaming query — parity, incremental delivery, memory');

// 1) PARITY + dedup + count: queryStream emits exactly query()'s id set, once each.
const qIds = new Set((await nostr.query(relays, filter)).map((e) => e.id));
const seen = new Set(); let emitted = 0; let perRelaySample = 0;
const streamCount = await nostr.queryStream(relays, filter, (ev, url) => {
  emitted++; assert.ok(!seen.has(ev.id), 'emitted a duplicate'); seen.add(ev.id);
  if (url === relays[0]) perRelaySample++;
});
check('emits exactly query()\'s unique id set', () => { assert.equal(seen.size, qIds.size); for (const id of qIds) assert.ok(seen.has(id), `missing ${id}`); });
check('every emission is unique (de-duped across relays)', () => assert.equal(emitted, EXPECT_UNIQUE));
check('resolves with the unique count', () => assert.equal(streamCount, EXPECT_UNIQUE));
check('onEvent receives the source relay url', () => assert.ok(perRelaySample > 0));

// 2) INCREMENTAL: each relay holds POPULAR+PER (300) events with a 100 page cap,
// so events must have streamed across multiple paginated REQs — not buffered.
check('events streamed across multiple pages per relay', () => {
  const maxReqs = Math.max(...reqsPerRelay.values());
  assert.ok(maxReqs >= 3, `expected pagination, max REQs/relay was ${maxReqs}`);
});

// 3) MEMORY: query() retains every parsed event; queryStream() (discarding) keeps
// only ids. Measure the heap each path holds live.
const base1 = heap();
const buffered = await nostr.query(relays, filter); // held alive below
const qHeap = heap() - base1;
assert.equal(buffered.length, EXPECT_UNIQUE); // touch it so it can't be optimized away

const base2 = heap();
let n = 0;
await nostr.queryStream(relays, filter, () => { n++; }); // discard each event
const sHeap = heap() - base2;

const mb = (b) => (b / 1048576).toFixed(2);
console.log(`  buffered query() retained ~${mb(qHeap)} MB for ${buffered.length} events; queryStream() retained ~${mb(sHeap)} MB`);
if (global.gc) {
  check('streaming retains far less than buffering (< half)', () => assert.ok(sHeap < qHeap * 0.5, `stream ${mb(sHeap)}MB vs query ${mb(qHeap)}MB`));
  check('buffered query holds the bulk of the events (sanity)', () => assert.ok(qHeap > 2 * 1048576, `query retained only ${mb(qHeap)}MB`));
} else {
  console.log('  (run `npm run bench` with --expose-gc for the hard memory assertions)');
}

// 4) outboxQueryStream parity for an author-less filter (routes to the seeds).
const obSeen = new Set();
const obCount = await nostr.outboxQueryStream(relays, filter, (ev) => obSeen.add(ev.id));
check('outboxQueryStream streams the same unique set (author-less -> seeds)', () => { assert.equal(obCount, EXPECT_UNIQUE); assert.equal(obSeen.size, qIds.size); });

console.log(failed ? `\n${failed} check(s) FAILED\n` : '\nAll streaming checks passed.\n');
process.exit(failed ? 1 : 0);
