// relay-pool.bench.mjs — efficiency benchmark + regression test for the
// client-tag report view (examples/client-tag-report.view.js) and the relay
// pool it leans on (js/nostr.js).
//
// It stands up a SIMULATED network of ~180 relays over a mock WebSocket (no
// real sockets, fully deterministic), then runs the ACTUAL view body the same
// way the app does — new AsyncFunction('root','api', code) — with api.queryAt
// wired to the REAL js/nostr.js query(). So this exercises the whole stack:
// the view's self-expanding relay crawl + concurrency pool, and nostr.js's
// per-relay pagination, socket reuse, and cross-relay de-dup.
//
// The simulated network is built to STRESS the efficiency claims:
//   - POPULAR events live on EVERY relay, so the same event is delivered ~180
//     times and must be de-duped to one (heavy dedup load).
//   - each relay also has events unique to it (so totals are deterministic).
//   - a relay's page cap is below its event count, so each relay needs several
//     paginated REQs over ONE warm socket (socket-reuse check).
//   - two "connector" events on the seeds carry e-tag relay hints to every
//     other relay, so the crawl discovers the whole network from 2 seeds.
//
// It then ASSERTS the invariants that define "running efficiently" and prints a
// metrics report. Run: `npm test` (or `npm run bench` for heap numbers).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ---------------------------------------------------------------------------
// Simulated-network shape (deterministic)
// ---------------------------------------------------------------------------
const N_RELAYS = 180;   // total relays the crawl should reach (<= view MAX_RELAYS)
const POPULAR = 150;    // events present on EVERY relay (the cross-relay duplicates)
const PER_RELAY = 80;   // events unique to each relay
const PAGE_CAP = 100;   // relay page cap -> forces multi-round pagination per relay
// client name -> weight (out of 100); drives a non-uniform, deterministic mix.
const CLIENTS = [['amethyst', 40], ['damus', 25], ['primal', 18], ['nostur', 10], ['coracle', 5], ['snort', 2]];
const TOTAL_W = CLIENTS.reduce((s, [, w]) => s + w, 0);

// Deterministic weighted client assignment from an integer sequence number.
function clientFor(seq) {
  let p = ((seq * 2654435761) >>> 0) % TOTAL_W;
  for (const [name, w] of CLIENTS) { if (p < w) return name; p -= w; }
  return CLIENTS[CLIENTS.length - 1][0];
}

// ---------------------------------------------------------------------------
// Read the view under test + its tunables (so the test tracks the real file)
// ---------------------------------------------------------------------------
const viewPath = join(ROOT, 'examples', 'client-tag-report.view.js');
const viewSrc = readFileSync(viewPath, 'utf8');
const tunable = (name) => {
  const m = viewSrc.match(new RegExp('const\\s+' + name + '\\s*=\\s*(\\d+)'));
  assert(m, `tunable ${name} not found in ${viewPath}`);
  return Number(m[1]);
};
const CONCURRENCY = tunable('CONCURRENCY');
const MAX_RELAYS = tunable('MAX_RELAYS');
const DAYS = tunable('DAYS');
const TOP_CLIENTS = tunable('TOP_CLIENTS');
const TOP_RELAYS = tunable('TOP_RELAYS');
assert(N_RELAYS <= MAX_RELAYS, `bench N_RELAYS(${N_RELAYS}) exceeds view MAX_RELAYS(${MAX_RELAYS})`);

// ---------------------------------------------------------------------------
// Build the simulated relay datasets
// ---------------------------------------------------------------------------
const now = Math.floor(Date.now() / 1000);
const relayUrl = (i) => `wss://r${i}`;

// Each unique id gets ONE created_at, all globally distinct (avoids the dense-
// second pagination skip) and inside the DAYS window.
const ev = (id, created_at, client, hints) => {
  const tags = [];
  if (client) tags.push(['client', client]);
  for (const h of hints || []) tags.push(['e', `${id}-ref`, h]);
  return { id, pubkey: 'pk', kind: 1, created_at, tags, content: '', sig: '' };
};

const DB = new Map();
for (let r = 0; r < N_RELAYS; r++) {
  const arr = [];
  for (let j = 0; j < POPULAR; j++) arr.push(ev(`pop-${j}`, now - 1 - j, clientFor(j)));
  for (let i = 0; i < PER_RELAY; i++) {
    const seq = POPULAR + r * PER_RELAY + i;
    arr.push(ev(`u${r}-${i}`, now - 1 - seq, clientFor(seq)));
  }
  DB.set(relayUrl(r), arr);
}
// Connector events on the two seeds: e-tag relay hints to every other relay, so
// the crawl reaches all N_RELAYS from {r0, r1} within the view's wave budget.
// They carry NO client tag (kept out of the client distribution on purpose).
const connBase = POPULAR + N_RELAYS * PER_RELAY;
const half = Math.floor((N_RELAYS - 2) / 2);
const hintsA = []; for (let k = 2; k < 2 + half; k++) hintsA.push(relayUrl(k));
const hintsB = []; for (let k = 2 + half; k < N_RELAYS; k++) hintsB.push(relayUrl(k));
DB.get(relayUrl(0)).push(ev('conn-0', now - 1 - connBase, null, hintsA));
DB.get(relayUrl(1)).push(ev('conn-1', now - 2 - connBase, null, hintsB));

// ---------------------------------------------------------------------------
// Expected metrics (closed-form from the construction above)
// ---------------------------------------------------------------------------
const expUnique = POPULAR + N_RELAYS * PER_RELAY + 2;       // + 2 connectors
const expWithClient = POPULAR + N_RELAYS * PER_RELAY;        // connectors have none
const expClients = new Map();
const bump = (c) => expClients.set(c, (expClients.get(c) || 0) + 1);
for (let j = 0; j < POPULAR; j++) bump(clientFor(j));
for (let r = 0; r < N_RELAYS; r++) for (let i = 0; i < PER_RELAY; i++) bump(clientFor(POPULAR + r * PER_RELAY + i));
const expTopRelay = POPULAR + PER_RELAY + 1;                 // a seed: shared + own + connector

// ---------------------------------------------------------------------------
// Instrumented mock WebSocket
// ---------------------------------------------------------------------------
const M = {
  socketsOpened: 0, openSockets: 0, peakOpenSockets: 0,
  reqSent: 0, eoseSent: 0, closeSent: 0, eventSent: 0,
  inFlight: 0, peakInFlight: 0, relaysQueried: new Set(),
};

function matchPage(url, filter) {
  const f = filter || {};
  let evs = (DB.get(url) || []).filter((e) => {
    if (f.since !== undefined && !(e.created_at >= f.since)) return false;
    if (f.until !== undefined && !(e.created_at <= f.until)) return false;
    if (f.kinds && !f.kinds.includes(e.kind)) return false;
    return true;
  });
  evs.sort((a, b) => b.created_at - a.created_at);           // newest-first, like a real relay
  const lim = Math.min(typeof f.limit === 'number' ? f.limit : Infinity, PAGE_CAP);
  return evs.slice(0, lim);
}

class MockWebSocket {
  constructor(url) {
    this.url = url; this.readyState = 0; this._l = {};
    M.socketsOpened++; M.openSockets++;
    if (M.openSockets > M.peakOpenSockets) M.peakOpenSockets = M.openSockets;
    setTimeout(() => { this.readyState = 1; this._emit('open', {}); }, 0);
  }
  addEventListener(t, fn) { (this._l[t] || (this._l[t] = new Set())).add(fn); }
  removeEventListener(t, fn) { this._l[t] && this._l[t].delete(fn); }
  _emit(t, e) { if (this._l[t]) for (const fn of [...this._l[t]]) fn(e); }
  send(data) {
    let msg; try { msg = JSON.parse(data); } catch { return; }
    const [verb, subId, ...filters] = msg;
    if (verb === 'CLOSE') { M.closeSent++; return; }
    if (verb !== 'REQ') return;
    M.reqSent++; M.relaysQueried.add(this.url);
    M.inFlight++; if (M.inFlight > M.peakInFlight) M.peakInFlight = M.inFlight;
    const page = matchPage(this.url, filters[0]);
    setTimeout(() => {
      for (const e of page) { M.eventSent++; this._emit('message', { data: JSON.stringify(['EVENT', subId, e]) }); }
      M.eoseSent++; this._emit('message', { data: JSON.stringify(['EOSE', subId]) });
      M.inFlight--;
    }, 0);
  }
  close() { if (this.readyState !== 3) { this.readyState = 3; M.openSockets--; this._emit('close', {}); } }
}
MockWebSocket.CONNECTING = 0; MockWebSocket.OPEN = 1; MockWebSocket.CLOSING = 2; MockWebSocket.CLOSED = 3;
globalThis.WebSocket = MockWebSocket;

// Import the REAL relay pool AFTER the global WebSocket is in place.
const nostr = await import(pathToFileURL(join(ROOT, 'js', 'nostr.js')).href);

// ---------------------------------------------------------------------------
// Minimal DOM stub + api, matching what views.js hands a view
// ---------------------------------------------------------------------------
function node(tag) {
  return {
    tag, children: [], style: {}, _text: '',
    get textContent() { return this._text; }, set textContent(v) { this._text = String(v); },
    set innerHTML(_v) { this.children.length = 0; },
    append(...c) { for (const x of c) if (x != null) this.children.push(x); },
    querySelector() { return null; },
  };
}
function el(tag, props = {}, children = []) {
  const n = node(tag);
  if (props.style) n.style = { ...props.style };
  if (props.text !== undefined) n._text = String(props.text);
  if (props.title) n.title = props.title;
  for (const c of [].concat(children)) {
    if (c == null) continue;
    if (typeof c === 'object' && c.tag) n.children.push(c);
    else { const t = node('#text'); t._text = String(c); n.children.push(t); }
  }
  return n;
}

const root = node('root');
const api = {
  relays: [relayUrl(0), relayUrl(1)],
  el,
  queryAt: (relays, filters, opts) => nostr.query(relays, filters, opts),
};

// ---------------------------------------------------------------------------
// Run the actual view
// ---------------------------------------------------------------------------
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const render = new AsyncFunction('root', 'api', viewSrc);

if (global.gc) global.gc();
const heapBefore = process.memoryUsage().heapUsed;
const t0 = process.hrtime.bigint();
await render(root, api);
const t1 = process.hrtime.bigint();
if (global.gc) global.gc();
const heapAfter = process.memoryUsage().heapUsed;
const ms = Number(t1 - t0) / 1e6;

// ---------------------------------------------------------------------------
// Parse what the view rendered
// ---------------------------------------------------------------------------
function* walk(n) { if (!n) return; yield n; if (n.children) for (const c of n.children) yield* walk(c); }
let section = null;
const clientRows = [], relayRows = [];
let doneText = '', withClientText = '', reachText = '';
for (const n of walk(root)) {
  const txt = n._text || '';
  if (txt.startsWith('Events by client')) section = 'client';
  else if (txt.startsWith('Unique events per relay')) section = 'relay';
  if (txt.startsWith('Done ·')) doneText = txt;
  if (/unique events had a client tag/.test(txt)) withClientText = txt;
  if (/relays reached out to \(from/.test(txt)) reachText = txt;
  const gtc = n.style && n.style.gridTemplateColumns;
  if (typeof gtc === 'string' && gtc.startsWith('minmax')) {
    const label = (n.children[0] && n.children[0]._text) || '';
    const value = Number(((n.children[2] && n.children[2]._text) || '0').replace(/,/g, ''));
    (section === 'client' ? clientRows : relayRows).push({ label, value });
  }
}
const grab = (re, s) => { const m = (s || '').match(re); return m ? Number(m[1].replace(/,/g, '')) : NaN; };
const parsedReached = grab(/Done · ([\d,]+) relays reached out to/, doneText);
const parsedUnique = grab(/· ([\d,]+) unique events/, doneText);
const parsedWithClient = grab(/· ([\d,]+) carried a client tag/, doneText);

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const fmt = (n) => n.toLocaleString();
const roundsPerRelay = (M.reqSent / M.socketsOpened).toFixed(2);
const dedupRatio = (M.eventSent / parsedUnique).toFixed(2);
console.log(`
Relay-pool efficiency benchmark — client-tag report
───────────────────────────────────────────────────
Simulated network : ${N_RELAYS} relays · ${POPULAR} shared + ${PER_RELAY} unique events each · page cap ${PAGE_CAP}
View tunables      : CONCURRENCY=${CONCURRENCY} MAX_RELAYS=${MAX_RELAYS} DAYS=${DAYS}

Crawl / network
  relays reached         : ${M.relaysQueried.size}  (reported: ${parsedReached})
  sockets opened         : ${fmt(M.socketsOpened)}   ${M.socketsOpened === M.relaysQueried.size ? '(1 per relay — no reconnect churn)' : '(!! churn)'}
  REQs sent              : ${fmt(M.reqSent)}  (~${roundsPerRelay} paginated rounds/relay over warm sockets)
  peak concurrent REQs   : ${M.peakInFlight} / ${CONCURRENCY}  ${M.peakInFlight <= CONCURRENCY ? '(fan-out bounded)' : '(!! over budget)'}
  peak open sockets      : ${M.peakOpenSockets}  (warm-pooled; = relays reached)

De-dup / memory
  events delivered       : ${fmt(M.eventSent)}  (over the wire, incl. cross-relay dups)
  unique events          : ${fmt(parsedUnique)}  (after id de-dup)
  de-dup ratio           : ${dedupRatio}× delivered per retained
  retained footprint     : Set(${fmt(parsedUnique)} ids) + ${expClients.size}-entry client map + ${N_RELAYS} ints
  process heap Δ         : ${(heapAfter - heapBefore) >= 0 ? '+' : ''}${((heapAfter - heapBefore) / 1048576).toFixed(1)} MB${global.gc ? '' : '  (run `npm run bench` for a GC-stable number)'}

Result
  events / second        : ${fmt(Math.round(M.eventSent / (ms / 1000)))}
  wall time              : ${ms.toFixed(0)} ms
  clients ranked         : ${clientRows.map((r) => `${r.label}=${r.value}`).join('  ')}
`);

// ---------------------------------------------------------------------------
// Assertions — these define "efficient" and fail the build on regression
// ---------------------------------------------------------------------------
let failed = 0;
const check = (desc, fn) => { try { fn(); console.log(`  ✓ ${desc}`); } catch (e) { failed++; console.log(`  ✗ ${desc}\n      ${e.message}`); } };

console.log('Checks');
// Crawl correctness: the whole network is found from 2 seeds via e/a/p hints.
check('crawl reaches every relay from 2 seeds via relay hints', () => assert.equal(M.relaysQueried.size, N_RELAYS));
check('done summary reports the same reach', () => assert.equal(parsedReached, N_RELAYS));
check('chart-2 summary credits the 2 seeds', () => assert.match(reachText, /from 2 seeds/));

// Connection efficiency: one socket per relay, reused across paginated rounds.
check('one socket per relay (no reconnect churn)', () => assert.equal(M.socketsOpened, M.relaysQueried.size));
check('pagination reuses the warm socket (REQs > sockets)', () => assert.ok(M.reqSent > M.socketsOpened, `reqSent=${M.reqSent} sockets=${M.socketsOpened}`));

// Bounded, well-utilized fan-out.
check('in-flight REQs never exceed CONCURRENCY', () => assert.ok(M.peakInFlight <= CONCURRENCY, `peak=${M.peakInFlight}`));
check('fan-out fully utilizes CONCURRENCY', () => assert.equal(M.peakInFlight, Math.min(CONCURRENCY, N_RELAYS)));

// De-dup correctness + that dedup actually did work (dups were delivered).
check('cross-relay de-dup yields the exact unique count', () => assert.equal(parsedUnique, expUnique));
check('duplicates were delivered then discarded', () => assert.ok(M.eventSent > parsedUnique * 2, `delivered=${M.eventSent} unique=${parsedUnique}`));

// Counting correctness (grouped by first value of the client tag).
check('client-tagged event total is correct', () => assert.equal(parsedWithClient, expWithClient));
check('client chart matches expected distribution', () => {
  for (const [name, exp] of expClients) {
    const row = clientRows.find((r) => r.label === name);
    assert(row, `missing client ${name}`);
    assert.equal(row.value, exp, `client ${name}: ${row.value} != ${exp}`);
  }
  assert.equal(clientRows.reduce((s, r) => s + r.value, 0), expWithClient);
});
check('client chart sorted by count desc', () => {
  for (let i = 1; i < clientRows.length; i++) assert.ok(clientRows[i - 1].value >= clientRows[i].value);
});

// Per-relay chart: capped, sorted, top is a seed (its connector adds one).
check('relay chart capped at TOP_RELAYS', () => assert.equal(relayRows.length, Math.min(TOP_RELAYS, N_RELAYS)));
check('relay chart sorted by count desc', () => {
  for (let i = 1; i < relayRows.length; i++) assert.ok(relayRows[i - 1].value >= relayRows[i].value);
});
check('top relay unique-event count is exact', () => assert.equal(relayRows[0].value, expTopRelay));

if (failed) { console.log(`\n${failed} check(s) FAILED\n`); process.exit(1); }
console.log(`\nAll checks passed.\n`);
