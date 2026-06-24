// view.bench.mjs — the client-tag report view as a first-class test case.
//
// The relay-pool / completeness benches drive this view to test the ENGINE; this
// file tests the VIEW's own contract and the branches those don't reach: e/a/p
// relay-hint harvesting, no-client / multi-client tag handling, trailing-slash
// relay dedup, the MAX_RELAYS / MAX_WAVES crawl bounds, the empty state, and the
// "COUNT unsupported" completeness path. It runs the real view body the way the
// app does (new AsyncFunction('root','api', src)) over a mock relay wired to the
// real js/nostr.js queryStream() + count().

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const viewSrc = readFileSync(join(ROOT, 'examples', 'client-tag-report.view.js'), 'utf8');
const tunable = (n) => { const m = viewSrc.match(new RegExp('const\\s+' + n + '\\s*=\\s*(\\d+)')); assert(m, `tunable ${n}`); return Number(m[1]); };
const PER_RELAY_LIMIT = tunable('PER_RELAY_LIMIT');
const MAX_RELAYS = tunable('MAX_RELAYS');
const MAX_WAVES = tunable('MAX_WAVES');
const now = Math.floor(Date.now() / 1000);
const PAGE_CAP = 100;

// ---- mock relay network (REQ stream + COUNT) -------------------------------
let DB = new Map();        // url -> events[]
let countable = new Map(); // url -> bool (answers COUNT?)
let reqLog = [];           // urls that received a REQ
const inWindow = (url, f) => (DB.get(url) || []).filter((e) =>
  (f.since === undefined || e.created_at >= f.since) && (f.until === undefined || e.created_at <= f.until));
class MockWebSocket {
  constructor(url) { this.url = url; this.readyState = 0; this._l = {}; setTimeout(() => { this.readyState = 1; this._emit('open', {}); }, 0); }
  addEventListener(t, fn) { (this._l[t] || (this._l[t] = new Set())).add(fn); }
  removeEventListener(t, fn) { this._l[t] && this._l[t].delete(fn); }
  _emit(t, e) { if (this._l[t]) for (const fn of [...this._l[t]]) fn(e); }
  send(data) {
    let msg; try { msg = JSON.parse(data); } catch { return; }
    const [verb, subId, ...filters] = msg;
    if (verb === 'CLOSE') return;
    const f = filters[0] || {};
    if (verb === 'COUNT') {
      setTimeout(() => countable.get(this.url)
        ? this._emit('message', { data: JSON.stringify(['COUNT', subId, { count: inWindow(this.url, f).length }]) })
        : this._emit('message', { data: JSON.stringify(['CLOSED', subId, 'count: unsupported']) }), 0);
      return;
    }
    if (verb !== 'REQ') return;
    reqLog.push(this.url);
    let evs = inWindow(this.url, f).sort((a, b) => b.created_at - a.created_at).slice(0, Math.min(typeof f.limit === 'number' ? f.limit : Infinity, PAGE_CAP));
    setTimeout(() => { for (const e of evs) this._emit('message', { data: JSON.stringify(['EVENT', subId, e]) }); this._emit('message', { data: JSON.stringify(['EOSE', subId]) }); }, 0);
  }
  close() { this.readyState = 3; }
}
MockWebSocket.CONNECTING = 0; MockWebSocket.OPEN = 1; MockWebSocket.CLOSING = 2; MockWebSocket.CLOSED = 3;
globalThis.WebSocket = MockWebSocket;
const nostr = await import(pathToFileURL(join(ROOT, 'js', 'nostr.js')).href);

// ---- DOM stub + view runner ------------------------------------------------
function node(tag) {
  return { tag, children: [], style: {}, _text: '',
    get textContent() { return this._text; }, set textContent(v) { this._text = String(v); },
    set innerHTML(_v) { this.children.length = 0; },
    append(...c) { for (const x of c) if (x != null) this.children.push(x); }, querySelector() { return null; } };
}
function el(tag, props = {}, children = []) {
  const n = node(tag);
  if (props.style) n.style = { ...props.style };
  if (props.text !== undefined) n._text = String(props.text);
  for (const c of [].concat(children)) {
    if (c == null) continue;
    if (typeof c === 'object' && c.tag) n.children.push(c);
    else { const t = node('#text'); t._text = String(c); n.children.push(t); }
  }
  return n;
}
function* walk(n) { if (!n) return; yield n; if (n.children) for (const c of n.children) yield* walk(c); }
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const ev = (id, client, hints = [], over = {}) => {
  const tags = [];
  if (Array.isArray(client)) for (const c of client) tags.push(['client', c]);
  else if (client) tags.push(['client', client]);
  for (const [t, url] of hints) tags.push([t, id + 'ref', url]);
  return { id, pubkey: 'p', kind: 1, created_at: now - 1000, tags, content: '', sig: '', ...over };
};

async function runView(seeds) {
  reqLog = [];
  const root = node('root');
  const api = { relays: seeds, el,
    queryStreamAt: (r, f, on, o) => nostr.queryStream(r, f, on, o),
    countAt: (r, f, o) => nostr.count(r, f, o) };
  await new AsyncFunction('root', 'api', viewSrc)(root, api);
  // Parse the report into sections.
  let section = null; const client = [], relay = [], gap = []; const texts = [];
  for (const n of walk(root)) {
    const txt = n._text || '';
    if (txt) texts.push(txt);
    if (txt.startsWith('Events by client')) section = 'client';
    else if (txt.startsWith('Unique events per relay')) section = 'relay';
    else if (txt.startsWith('Completeness check')) section = 'gap';
    const gtc = n.style && n.style.gridTemplateColumns;
    if (typeof gtc === 'string' && gtc.startsWith('minmax')) {
      const row = { label: (n.children[0] && n.children[0]._text) || '', value: Number(((n.children[2] && n.children[2]._text) || '0').replace(/,/g, '')) };
      (section === 'client' ? client : section === 'gap' ? gap : relay).push(row);
    }
  }
  const has = (re) => texts.some((t) => re.test(t));
  const done = texts.find((t) => t.startsWith('Done ·')) || '';
  return { root, client, relay, gap, texts, has, done };
}

let failed = 0;
const acheck = async (d, fn) => { try { await fn(); console.log(`  ✓ ${d}`); } catch (e) { failed++; console.log(`  ✗ ${d}\n      ${e.message}`); } };

// ===========================================================================
// Full contract: e/a/p hint harvesting, multi/no client tags, trailing-slash
// dedup, clean completeness, all sections rendered.
// ===========================================================================
console.log('\nFull contract — hints, client tagging, sections');
await acheck('harvests e/a/p hints, dedups relays, groups clients correctly', async () => {
  DB = new Map([
    ['wss://seed', [
      ev('e1', 'amethyst', [['e', 'wss://ehint']]),
      ev('e2', 'damus', [['a', 'wss://ahint']]),
      ev('e3', 'amethyst', [['p', 'wss://phint']]),
      ev('e4', null),                                  // no client tag
      ev('e5', ['first', 'second']),                   // multi: first wins
      ev('e6', 'damus', [['e', 'wss://ehint/']]),      // trailing slash -> same as ehint
    ]],
    ['wss://ehint', [ev('x1', 'damus')]],
    ['wss://ahint', [ev('x2', 'primal')]],
    ['wss://phint', [ev('x3', 'amethyst')]],
  ]);
  countable = new Map();
  const r = await runView(['wss://seed']);

  // Crawl reached EXACTLY the seed + the three e/a/p hint relays, with the
  // trailing-slash 'wss://ehint/' normalized onto 'wss://ehint' (no 5th relay).
  const distinct = [...new Set(reqLog)].sort();
  assert.deepEqual(distinct, ['wss://ahint', 'wss://ehint', 'wss://phint', 'wss://seed'], 'wrong set of relays crawled (hint harvest or slash dedup off)');

  // client distribution: amethyst e1,e3,x3 = 3; damus e2,e6,x1 = 3; primal x2 = 1; first e5 = 1.
  const counts = Object.fromEntries(r.client.map((c) => [c.label, c.value]));
  assert.deepEqual(counts, { amethyst: 3, damus: 3, primal: 1, first: 1 });
  assert.ok(!('second' in counts), 'second client tag should be ignored (first wins)');
  for (let i = 1; i < r.client.length; i++) assert.ok(r.client[i - 1].value >= r.client[i].value, 'clients not sorted desc');

  // 9 unique events, 8 carried a client tag (e4 had none); 4 relays reached.
  assert.match(r.done, /4 relays reached out to · 9 unique events · 8 carried a client tag/);
  assert.ok(r.has(/✓ No truncation detected/), 'expected a clean completeness verdict');
  assert.ok(r.has(/Events by client/) && r.has(/Unique events per relay/) && r.has(/Completeness check/), 'a section is missing');
});

// ===========================================================================
// Empty state.
// ===========================================================================
console.log('\nEmpty state');
await acheck('renders "No events found" and no charts when nothing returns', async () => {
  DB = new Map([['wss://seed', []]]); countable = new Map();
  const r = await runView(['wss://seed']);
  assert.ok(r.has(/No events found/));
  assert.equal(r.client.length, 0);
  assert.equal(r.relay.length, 0);
});

// ===========================================================================
// Completeness — truncated relay whose COUNT is unsupported (the unverifiable
// path, not covered elsewhere): warns, but reports no measured gap.
// ===========================================================================
console.log('\nCompleteness — unverifiable (no COUNT)');
await acheck('flags a limit-hitting relay it cannot verify', async () => {
  // distinct timestamps so pagination fills the full PER_RELAY_LIMIT (a single
  // shared second would instead trip the saturated-second cap below the limit).
  const many = Array.from({ length: PER_RELAY_LIMIT + 50 }, (_, i) => ev('m' + i, 'amethyst', [], { created_at: now - 1000 - i }));
  DB = new Map([['wss://busy', many]]);
  countable = new Map(); // COUNT unsupported everywhere
  const r = await runView(['wss://busy']);
  assert.match(r.done, /⚠ 1 relay\(s\) likely truncated/);
  assert.ok(!/events missed/.test(r.done), 'should not claim a measured miss count without COUNT');
  assert.ok(r.has(/could not be measured/) || r.has(/don't support NIP-45 COUNT/), 'expected an unverifiable note');
  assert.equal(r.gap.length, 0, 'no gap bars without a measured gap');
});

// ===========================================================================
// Crawl bounds — MAX_WAVES depth, and the reach count = relays actually queried
// (not relays merely discovered in the final wave).
// ===========================================================================
console.log('\nCrawl depth bound + accurate reach count');
await acheck(`stops after ${MAX_WAVES} waves and counts only queried relays`, async () => {
  // chain: seed -> r1 -> r2 -> r3 -> r4 (each hints the next). With MAX_WAVES=3,
  // seed/r1/r2 are queried; r3 is discovered in the last wave but never reached.
  DB = new Map([
    ['wss://seed', [ev('s', 'a', [['e', 'wss://r1']])]],
    ['wss://r1', [ev('n1', 'b', [['e', 'wss://r2']])]],
    ['wss://r2', [ev('n2', 'c', [['e', 'wss://r3']])]],
    ['wss://r3', [ev('n3', 'd', [['e', 'wss://r4']])]],
    ['wss://r4', [ev('n4', 'e')]],
  ]);
  countable = new Map();
  const r = await runView(['wss://seed']);
  const distinct = new Set(reqLog);
  assert.deepEqual([...distinct].sort(), ['wss://r1', 'wss://r2', 'wss://seed'], 'crawl depth not bounded to MAX_WAVES');
  assert.match(r.done, /3 relays reached out to/); // NOT 4 — r3 discovered but never queried
  const clients = r.client.map((c) => c.label).sort();
  assert.deepEqual(clients, ['a', 'b', 'c'], 'events past the wave bound leaked in');
});

// ===========================================================================
// MAX_RELAYS cap — a seed hinting more relays than the cap stops at the cap.
// ===========================================================================
console.log('\nMAX_RELAYS cap');
await acheck(`crawl stops at MAX_RELAYS (${MAX_RELAYS})`, async () => {
  const hints = [];
  const db = new Map();
  for (let i = 0; i < MAX_RELAYS + 60; i++) { const u = `wss://h${i}`; hints.push(['e', u]); db.set(u, [ev('h' + i + 'e', 'amethyst')]); }
  db.set('wss://seed', [ev('seed', 'amethyst', hints)]);
  DB = db; countable = new Map();
  const r = await runView(['wss://seed']);
  const distinct = new Set(reqLog).size;
  assert.equal(distinct, MAX_RELAYS, `queried ${distinct} relays, expected the cap ${MAX_RELAYS}`);
  assert.match(r.done, new RegExp(`${MAX_RELAYS} relays reached out to`));
});

console.log(failed ? `\n${failed} view check(s) FAILED\n` : '\nAll view checks passed.\n');
process.exit(failed ? 1 : 0);
