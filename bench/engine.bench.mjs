// engine.bench.mjs — direct coverage for the core relay-pool primitives that
// the query/stream benches don't exercise: subscribe() (live + backfill), the
// trust boundary (relays are not trusted — junk must be filtered), count()
// (NIP-45 max semantics), the outbox model (routeByOutbox / parseRelayList /
// fallback / per-author cap), publish(), NIP-42 auth, and search routing.
//
// One flexible mock relay drives them all. State lives in NET, reset per
// scenario; a fake NIP-07 signer is installed on globalThis.window.

import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const now = Math.floor(Date.now() / 1000);

// ---------------------------------------------------------------------------
// Mutable network the scenarios configure.
// ---------------------------------------------------------------------------
const NET = {
  db: new Map(),          // url -> events[]
  count: new Map(),       // url -> number (absent = COUNT unsupported)
  authRequired: new Set(),// urls that demand NIP-42 before serving
  rejectPublish: new Set(),
  authed: new Set(),      // urls we've authenticated to (set by the mock)
  live: [],               // open live subs: { url, ws, subId, filter }
  reqLog: [],             // { url, filters } for every REQ that served data
};
function resetNet(over = {}) {
  NET.db = over.db || new Map();
  NET.count = over.count || new Map();
  NET.authRequired = over.authRequired || new Set();
  NET.rejectPublish = over.rejectPublish || new Set();
  NET.authed = new Set();
  NET.live = [];
  NET.reqLog = [];
}
function matches(f, ev) {
  if (f.ids && !f.ids.includes(ev.id)) return false;
  if (f.authors && !f.authors.includes(ev.pubkey)) return false;
  if (f.kinds && !f.kinds.includes(ev.kind)) return false;
  if (f.since !== undefined && !(ev.created_at >= f.since)) return false;
  if (f.until !== undefined && !(ev.created_at <= f.until)) return false;
  for (const k of Object.keys(f)) {
    if (k[0] === '#' && k.length === 2) {
      const want = f[k]; const letter = k[1];
      if (!(ev.tags || []).some((t) => t[0] === letter && want.includes(t[1]))) return false;
    }
  }
  return true;
}
const isLiveFilter = (f) => f.since !== undefined && f.until === undefined && f.limit === undefined;

// Push a future event to every open live sub it matches (for subscribe() tests).
function pushLive(ev) {
  if (!NET.db.has('__live__')) NET.db.set('__live__', []);
  for (const sub of NET.live) {
    if (NET.db.get(sub.url) && matches(sub.filter, ev)) {
      sub.ws._emit('message', { data: JSON.stringify(['EVENT', sub.subId, ev]) });
    }
  }
}

// ---------------------------------------------------------------------------
// Fake NIP-07 signer (for publish + NIP-42).
// ---------------------------------------------------------------------------
let sigCounter = 0;
globalThis.window = {
  nostr: {
    getPublicKey: async () => 'PUBKEY',
    signEvent: async (e) => ({ ...e, pubkey: e.pubkey || 'PUBKEY', id: 'evt' + (++sigCounter), sig: 'sig' }),
  },
};

// ---------------------------------------------------------------------------
// Mock WebSocket
// ---------------------------------------------------------------------------
class MockWebSocket {
  constructor(url) {
    this.url = url; this.readyState = 0; this._l = {};
    setTimeout(() => {
      this.readyState = 1; this._emit('open', {});
      if (NET.authRequired.has(url)) this._emit('message', { data: JSON.stringify(['AUTH', 'challenge-' + url]) });
    }, 0);
  }
  addEventListener(t, fn) { (this._l[t] || (this._l[t] = new Set())).add(fn); }
  removeEventListener(t, fn) { this._l[t] && this._l[t].delete(fn); }
  _emit(t, e) { if (this._l[t]) for (const fn of [...this._l[t]]) fn(e); }
  send(data) {
    let msg; try { msg = JSON.parse(data); } catch { return; }
    const [verb, a, ...rest] = msg;
    if (verb === 'CLOSE') { NET.live = NET.live.filter((s) => !(s.ws === this && s.subId === a)); return; }

    if (verb === 'AUTH') { // a is the signed kind-22242 event
      NET.authed.add(this.url);
      setTimeout(() => this._emit('message', { data: JSON.stringify(['OK', a.id, true]) }), 0);
      return;
    }

    if (verb === 'EVENT') { // publish
      const ev = a; const ok = !NET.rejectPublish.has(this.url);
      setTimeout(() => this._emit('message', { data: JSON.stringify(['OK', ev.id, ok, ok ? '' : 'blocked']) }), 0);
      return;
    }

    if (verb === 'COUNT') {
      const subId = a;
      setTimeout(() => {
        if (NET.count.has(this.url)) this._emit('message', { data: JSON.stringify(['COUNT', subId, { count: NET.count.get(this.url) }]) });
        else this._emit('message', { data: JSON.stringify(['CLOSED', subId, 'count: unsupported']) });
      }, 0);
      return;
    }

    if (verb === 'REQ') {
      const subId = a; const filters = rest;
      if (NET.authRequired.has(this.url) && !NET.authed.has(this.url)) {
        setTimeout(() => this._emit('message', { data: JSON.stringify(['CLOSED', subId, 'auth-required: please authenticate']) }), 0);
        return;
      }
      NET.reqLog.push({ url: this.url, filters });
      const all = NET.db.get(this.url) || [];
      const out = [];
      for (const f of filters) {
        if (isLiveFilter(f)) NET.live.push({ url: this.url, ws: this, subId, filter: f }); // keep open for pushLive
        for (const ev of all) if (matches(f, ev) && !out.includes(ev)) out.push(ev);
      }
      out.sort((x, y) => y.created_at - x.created_at);
      setTimeout(() => {
        for (const ev of out) this._emit('message', { data: JSON.stringify(['EVENT', subId, ev]) });
        this._emit('message', { data: JSON.stringify(['EOSE', subId]) });
      }, 0);
      return;
    }
  }
  close() { this.readyState = 3; NET.live = NET.live.filter((s) => s.ws !== this); }
}
MockWebSocket.CONNECTING = 0; MockWebSocket.OPEN = 1; MockWebSocket.CLOSING = 2; MockWebSocket.CLOSED = 3;
globalThis.WebSocket = MockWebSocket;

const nostr = await import(pathToFileURL(join(ROOT, 'js', 'nostr.js')).href);

const ev = (id, over = {}) => ({ id, pubkey: 'PUBKEY', kind: 1, created_at: now - 1000, tags: [], content: '', sig: '', ...over });
const tick = (n = 20) => new Promise((r) => setTimeout(r, n));

let failed = 0;
const acheck = async (d, fn) => { try { await fn(); console.log(`  ✓ ${d}`); } catch (e) { failed++; console.log(`  ✗ ${d}\n      ${e.message}`); } };
const check = (d, fn) => { try { fn(); console.log(`  ✓ ${d}`); } catch (e) { failed++; console.log(`  ✗ ${d}\n      ${e.message}`); } };

// ===========================================================================
// Trust boundary — relays are NOT trusted; events that don't match the REQ
// filter must be dropped (spam / leaked subs / over-broad indexes).
// ===========================================================================
console.log('\nTrust boundary (client-side re-validation)');
await acheck('query drops events that violate the filter', async () => {
  resetNet({ db: new Map([['wss://liar', [
    ev('good', { kind: 1, pubkey: 'ALICE' }),
    ev('wrongkind', { kind: 7, pubkey: 'ALICE' }),     // filter asks kind 1
    ev('wrongauthor', { kind: 1, pubkey: 'MALLORY' }), // filter asks author ALICE
    ev('tooold', { kind: 1, pubkey: 'ALICE', created_at: now - 99999 }),
  ]]]) });
  const got = await nostr.query(['wss://liar'], { kinds: [1], authors: ['ALICE'], since: now - 5000 });
  assert.deepEqual(got.map((e) => e.id), ['good']);
});

// ===========================================================================
// subscribe() — backfill the past + stream future + dedup + onEose + unsub.
// ===========================================================================
console.log('\nsubscribe() live + backfill');
await acheck('delivers backfill, fires onEose once, then streams live, and stops on unsubscribe', async () => {
  resetNet({ db: new Map([['wss://r', [ev('h1'), ev('h2'), ev('h3')]]]) });
  const seen = []; let eoseCount = 0;
  const unsub = nostr.subscribe(['wss://r'], { kinds: [1] }, (e) => seen.push(e.id), { onEose: () => eoseCount++ });
  await tick();
  assert.deepEqual(seen.slice().sort(), ['h1', 'h2', 'h3'], 'backfill not delivered');
  assert.equal(eoseCount, 1, 'onEose should fire exactly once');

  pushLive(ev('live1', { created_at: now + 5 }));
  await tick();
  assert.ok(seen.includes('live1'), 'live event not delivered');

  pushLive(ev('dup_h1_as_live', { id: 'h1', created_at: now + 6 })); // same id as backfill
  await tick();
  assert.equal(seen.filter((id) => id === 'h1').length, 1, 'duplicate id delivered twice');

  unsub();
  pushLive(ev('after_unsub', { created_at: now + 7 }));
  await tick();
  assert.ok(!seen.includes('after_unsub'), 'event delivered after unsubscribe');
});

// ===========================================================================
// count() — NIP-45: returns the LARGEST single-relay count (not additive);
// relays without COUNT support contribute nothing.
// ===========================================================================
console.log('\ncount() NIP-45');
await acheck('returns the max across relays, ignores unsupported relays', async () => {
  resetNet({ count: new Map([['wss://a', 10], ['wss://b', 25]]) }); // wss://c absent = unsupported
  const n = await nostr.count(['wss://a', 'wss://b', 'wss://c'], { kinds: [1] });
  assert.equal(n, 25);
});
await acheck('returns 0 when no relay supports COUNT', async () => {
  resetNet({});
  assert.equal(await nostr.count(['wss://x'], { kinds: [1] }), 0);
});

// ===========================================================================
// Outbox model — parseRelayList + routeByOutbox (via outboxQuery): each author
// is read from THEIR write relays, authors with no list fall back to seeds,
// and a single author is capped at maxRelaysPerAuthor write relays.
// ===========================================================================
console.log('\nOutbox routing');
check('parseRelayList splits read/write/both markers', () => {
  const list = nostr.parseRelayList({ tags: [
    ['r', 'wss://rw'],            // unmarked = both
    ['r', 'wss://ro', 'read'],
    ['r', 'wss://wo', 'write'],
    ['x', 'wss://ignored'],
  ] });
  assert.deepEqual(list.read.sort(), ['wss://ro', 'wss://rw']);
  assert.deepEqual(list.write.sort(), ['wss://rw', 'wss://wo']);
});
await acheck('routes each author to their write relays, falls back to seeds', async () => {
  const relayList = (write) => ev('rl', { kind: 10002, tags: write.map((u) => ['r', u, 'write']) });
  resetNet({ db: new Map([
    // seed serves the kind-10002 lists AND Bob's note (Bob has no list -> fallback)
    ['wss://seed', [{ ...relayList(['wss://alice-w']), pubkey: 'ALICE' }, ev('bobnote', { pubkey: 'BOB' })]],
    ['wss://alice-w', [ev('alicenote', { pubkey: 'ALICE' })]],
  ]) });
  const got = await nostr.outboxQuery(['wss://seed'], { kinds: [1], authors: ['ALICE', 'BOB'] });
  const ids = got.map((e) => e.id).sort();
  assert.deepEqual(ids, ['alicenote', 'bobnote'], 'outbox routing missed an author');
  assert.ok(NET.reqLog.some((r) => r.url === 'wss://alice-w'), "Alice not queried on her write relay");
});
await acheck('caps a single author at maxRelaysPerAuthor write relays', async () => {
  const writes = ['wss://w1', 'wss://w2', 'wss://w3', 'wss://w4', 'wss://w5'];
  const relayList = ev('rl', { kind: 10002, pubkey: 'ALICE', tags: writes.map((u) => ['r', u, 'write']) });
  const db = new Map([['wss://seed', [relayList]]]);
  for (const w of writes) db.set(w, [ev('n_' + w, { pubkey: 'ALICE' })]);
  resetNet({ db });
  await nostr.outboxQuery(['wss://seed'], { kinds: [1], authors: ['ALICE'] }, { force: true });
  const writeRelaysHit = new Set(NET.reqLog.map((r) => r.url).filter((u) => writes.includes(u)));
  assert.equal(writeRelaysHit.size, 3, `expected 3 write relays (default cap), hit ${writeRelaysHit.size}`);
});

// ===========================================================================
// publish() — signs via the NIP-07 signer and reports per-relay OK/failure.
// ===========================================================================
console.log('\npublish()');
await acheck('signs and reports success and failure per relay', async () => {
  resetNet({ rejectPublish: new Set(['wss://bad']) });
  const { event, results } = await nostr.publish(['wss://good', 'wss://bad'], { kind: 1, content: 'hi' });
  assert.equal(event.pubkey, 'PUBKEY');
  assert.ok(event.id, 'event not signed');
  const byUrl = Object.fromEntries(results.map((r) => [r.url, r.ok]));
  assert.equal(byUrl['wss://good'], true);
  assert.equal(byUrl['wss://bad'], false);
});

// ===========================================================================
// NIP-42 — a relay that withholds data until authenticated: the pool signs a
// kind-22242 challenge response and replays the REQ, then gets the events.
// ===========================================================================
console.log('\nNIP-42 auth replay');
await acheck('authenticates on auth-required, then receives the data', async () => {
  resetNet({ db: new Map([['wss://auth', [ev('secret')]]]), authRequired: new Set(['wss://auth']) });
  const got = await nostr.query(['wss://auth'], { kinds: [1] });
  assert.deepEqual(got.map((e) => e.id), ['secret'], 'auth replay did not deliver events');
  assert.ok(NET.authed.has('wss://auth'), 'relay was never authenticated');
});

// ===========================================================================
// Search routing — searchRelaysFor uses the user's kind-10007 list when present,
// else falls back to seeds + the well-known indexers.
// ===========================================================================
console.log('\nSearch relay routing');
await acheck('uses the kind-10007 list when present', async () => {
  const list = ev('sr', { kind: 10007, pubkey: 'ALICE', tags: [['relay', 'wss://search-a'], ['relay', 'wss://search-b']] });
  resetNet({ db: new Map([['wss://seed', [list]]]) });
  const relays = await nostr.searchRelaysFor('ALICE', ['wss://seed'], { force: true });
  assert.deepEqual(relays.sort(), ['wss://search-a', 'wss://search-b']);
});
await acheck('falls back to seeds + default indexers without a list', async () => {
  resetNet({});
  const relays = await nostr.searchRelaysFor(null, ['wss://seed'], { force: true });
  assert.ok(relays.includes('wss://seed'));
  for (const d of nostr.DEFAULT_SEARCH_RELAYS) assert.ok(relays.includes(d), `missing default ${d}`);
});

console.log(failed ? `\n${failed} engine check(s) FAILED\n` : '\nAll engine checks passed.\n');
process.exit(failed ? 1 : 0);
