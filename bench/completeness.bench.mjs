// completeness.bench.mjs — "are we missing events?" regression test.
//
// The efficiency benchmark (relay-pool.bench.mjs) proves the plumbing, but by
// construction every simulated relay was small enough to be fully drained, so
// it can't tell us whether the report MISSES events on a busy relay. It does —
// two ways, both confirmed against the real js/nostr.js:
//
//   1. per-relay `limit` (PER_RELAY_LIMIT): a relay with more in-window events
//      than the limit returns only the newest `limit`; the rest are never seen.
//   2. dense same-second skip: pagination advances by whole seconds, so events
//      sharing one created_at across a relay page boundary get skipped.
//
// This test stands up relays that are deliberately bigger than the limit and
// verifies the view's COMPLETENESS self-check (the "Completeness" card): it must
// (a) flag exactly the truncated relays, (b) use NIP-45 COUNT to report the
// lower-bound number of missed events, and (c) leave a clean run unflagged. It
// also characterizes the dense-second loss against the real paginate() so a
// future fix is noticed.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const viewSrc = readFileSync(join(ROOT, 'examples', 'client-tag-report.view.js'), 'utf8');
const tunable = (n) => { const m = viewSrc.match(new RegExp('const\\s+' + n + '\\s*=\\s*(\\d+)')); assert(m, `tunable ${n} missing`); return Number(m[1]); };
const PER_RELAY_LIMIT = tunable('PER_RELAY_LIMIT');
const CONCURRENCY = tunable('CONCURRENCY');
const DAYS = tunable('DAYS');

const now = Math.floor(Date.now() / 1000);
const since = now - DAYS * 86400;
const PAGE_CAP = 100;

// ---------------------------------------------------------------------------
// Mock relay network with REQ pagination AND NIP-45 COUNT.
//   DB:        url -> events (newest-first not required; mock sorts)
//   countable: url -> bool (does this relay answer COUNT?)
// COUNT reports the TRUE in-window total (ignoring `limit`, like a real relay).
// ---------------------------------------------------------------------------
let DB = new Map();
let countable = new Map();

function inWindow(url, f) {
  return (DB.get(url) || []).filter((e) =>
    (f.since === undefined || e.created_at >= f.since) &&
    (f.until === undefined || e.created_at <= f.until) &&
    (!f.kinds || f.kinds.includes(e.kind)));
}

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
      setTimeout(() => {
        if (countable.get(this.url)) this._emit('message', { data: JSON.stringify(['COUNT', subId, { count: inWindow(this.url, f).length }]) });
        else this._emit('message', { data: JSON.stringify(['CLOSED', subId, 'unsupported: count']) }); // resolves to 0 fast
      }, 0);
      return;
    }
    if (verb !== 'REQ') return;
    let evs = inWindow(this.url, f).sort((a, b) => b.created_at - a.created_at);
    evs = evs.slice(0, Math.min(typeof f.limit === 'number' ? f.limit : Infinity, PAGE_CAP));
    setTimeout(() => {
      for (const e of evs) this._emit('message', { data: JSON.stringify(['EVENT', subId, e]) });
      this._emit('message', { data: JSON.stringify(['EOSE', subId]) });
    }, 0);
  }
  close() { this.readyState = 3; }
}
MockWebSocket.CONNECTING = 0; MockWebSocket.OPEN = 1; MockWebSocket.CLOSING = 2; MockWebSocket.CLOSED = 3;
globalThis.WebSocket = MockWebSocket;
const nostr = await import(pathToFileURL(join(ROOT, 'js', 'nostr.js')).href);

// ---------------------------------------------------------------------------
// DOM stub + view runner (same shape views.js uses)
// ---------------------------------------------------------------------------
function node(tag) {
  return {
    tag, children: [], style: {}, _text: '',
    get textContent() { return this._text; }, set textContent(v) { this._text = String(v); },
    set innerHTML(_v) { this.children.length = 0; },
    append(...c) { for (const x of c) if (x != null) this.children.push(x); }, querySelector() { return null; },
  };
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

async function runView(seeds) {
  const root = node('root');
  const api = { relays: seeds, el, queryAt: (r, f, o) => nostr.query(r, f, o), countAt: (r, f, o) => nostr.count(r, f, o) };
  await new AsyncFunction('root', 'api', viewSrc)(root, api);
  // Parse the rendered report.
  let section = null; const gapRows = []; const texts = []; let doneText = '';
  for (const n of walk(root)) {
    const txt = n._text || '';
    if (txt) texts.push(txt);
    if (txt.startsWith('Completeness check')) section = 'gap';
    else if (txt.startsWith('Events by client') || txt.startsWith('Unique events per relay')) section = null;
    if (txt.startsWith('Done ·')) doneText = txt;
    const gtc = n.style && n.style.gridTemplateColumns;
    if (section === 'gap' && typeof gtc === 'string' && gtc.startsWith('minmax')) {
      gapRows.push({ label: (n.children[0] && n.children[0]._text) || '', value: Number(((n.children[2] && n.children[2]._text) || '0').replace(/,/g, '')) });
    }
  }
  const has = (re) => texts.some((t) => re.test(t));
  return { gapRows, texts, doneText, has };
}

const mkEvents = (prefix, count, baseOffset) =>
  Array.from({ length: count }, (_, i) => ({ id: `${prefix}-${i}`, pubkey: 'p', kind: 1, created_at: now - 1 - baseOffset - i, tags: [['client', 'amethyst']], content: '', sig: '' }));

let failed = 0;
const check = (desc, fn) => { try { fn(); console.log(`  ✓ ${desc}`); } catch (e) { failed++; console.log(`  ✗ ${desc}\n      ${e.message}`); } };

// ===========================================================================
// Scenario A — busy relays exceed the limit; the check must detect & quantify.
// ===========================================================================
console.log('\nScenario A — truncated relays are flagged and quantified');
{
  const OVER1 = PER_RELAY_LIMIT + 600;  // -> miss 600 (countable)
  const OVER2 = PER_RELAY_LIMIT + 250;  // -> miss 250 (countable)
  const SMALL = PER_RELAY_LIMIT - 150;  // fully drained -> not flagged
  const NOCNT = PER_RELAY_LIMIT + 300;  // truncated but COUNT unsupported
  DB = new Map([
    ['wss://big1', mkEvents('big1', OVER1, 0)],
    ['wss://big2', mkEvents('big2', OVER2, 100000)],
    ['wss://small', mkEvents('small', SMALL, 200000)],
    ['wss://nocount', mkEvents('nocount', NOCNT, 300000)],
  ]);
  countable = new Map([['wss://big1', true], ['wss://big2', true], ['wss://small', true], ['wss://nocount', false]]);
  const expMissing = (OVER1 - PER_RELAY_LIMIT) + (OVER2 - PER_RELAY_LIMIT); // 600 + 250

  const r = await runView([...DB.keys()]);
  console.log('  done:', r.doneText);
  console.log('  gap bars:', r.gapRows.map((g) => `${g.label}=${g.value}`).join('  ') || '(none)');

  check('done status warns about likely-truncated relays', () => assert.match(r.doneText, /⚠ 3 relay\(s\) likely truncated/));
  check('done status reports the lower-bound missed total', () => assert.match(r.doneText, new RegExp(`≥${expMissing.toLocaleString()} events missed`)));
  check('COUNT-confirmed gap is reported on the card', () => assert.ok(r.has(new RegExp(`≥ ${expMissing.toLocaleString()} events were NOT downloaded across 2 relay`))));
  check('the COUNT-less suspect is reported as unverifiable', () => assert.ok(r.has(/1 suspect relay\(s\) don't support NIP-45 COUNT/)));
  check('gap chart lists exactly the two confirmed relays, sorted desc', () => {
    assert.equal(r.gapRows.length, 2);
    assert.deepEqual(r.gapRows.map((g) => g.label), ['big1', 'big2']);
    assert.deepEqual(r.gapRows.map((g) => g.value), [OVER1 - PER_RELAY_LIMIT, OVER2 - PER_RELAY_LIMIT]);
  });
  check('the fully-drained relay is NOT flagged', () => assert.ok(!r.gapRows.some((g) => g.label === 'small')));
}

// ===========================================================================
// Scenario B — every relay under the limit; the check must report clean.
// ===========================================================================
console.log('\nScenario B — a fully-drained network reports complete');
{
  DB = new Map([
    ['wss://a', mkEvents('a', PER_RELAY_LIMIT - 1, 0)],
    ['wss://b', mkEvents('b', 50, 50000)],
  ]);
  countable = new Map([['wss://a', true], ['wss://b', true]]);
  const r = await runView([...DB.keys()]);
  console.log('  done:', r.doneText);
  check('done status has no truncation warning', () => assert.ok(!/⚠/.test(r.doneText)));
  check('card states no truncation detected', () => assert.ok(r.has(/✓ No truncation detected/)));
  check('no gap bars drawn', () => assert.equal(r.gapRows.length, 0));
}

// ===========================================================================
// Scenario C — page-boundary events at a shared second are RECOVERED.
// A second whose events straddle the relay's page edge used to be skipped
// (until = oldest - 1). Inclusive paging must now recover them in full.
// ===========================================================================
console.log('\nScenario C — boundary-straddling same-second events are recovered');
{
  const evs = [];
  // 96 events at distinct seconds (fill most of the first page)…
  for (let i = 0; i < 96; i++) evs.push({ id: `s-${i}`, pubkey: 'p', kind: 1, created_at: now - 1 - i, tags: [], content: '', sig: '' });
  // …then 8 events sharing ONE second that the 100-event page cap cuts through…
  const B = now - 1 - 96;
  for (let i = 0; i < 8; i++) evs.push({ id: `b-${i}`, pubkey: 'p', kind: 1, created_at: B, tags: [], content: '', sig: '' });
  // …then 50 older distinct-second events.
  for (let i = 0; i < 50; i++) evs.push({ id: `o-${i}`, pubkey: 'p', kind: 1, created_at: B - 1 - i, tags: [], content: '', sig: '' });
  const TOTAL = 96 + 8 + 50; // 154
  DB = new Map([['wss://straddle', evs]]); countable = new Map();

  const got = await nostr.query(['wss://straddle'], { since, limit: 100000 });
  const ids = new Set(got.map((e) => e.id));
  const boundaryGot = [...Array(8).keys()].filter((i) => ids.has(`b-${i}`)).length;
  console.log(`  ${TOTAL} events (8 share one second across the page edge), page cap ${PAGE_CAP} -> downloaded ${got.length}, boundary-second got ${boundaryGot}/8`);
  check('every event is recovered (no boundary skip)', () => assert.equal(got.length, TOTAL));
  check('all 8 boundary-second events present', () => assert.equal(boundaryGot, 8));
}

// ===========================================================================
// Scenario D — inherent NIP-01 limit: a single second denser than the relay's
// page cap can't be fully paged by ANY until-cursor. The fix must still
// terminate (not loop) and surface exactly one page from that second.
// ===========================================================================
console.log('\nScenario D — a single over-full second is bounded, not looping');
{
  const TOTAL = 250; // all sharing ONE timestamp; page cap 100
  DB = new Map([['wss://dense', Array.from({ length: TOTAL }, (_, i) => ({ id: `d-${i}`, pubkey: 'p', kind: 1, created_at: now - 100, tags: [], content: '', sig: '' }))]]);
  countable = new Map();
  const got = await nostr.query(['wss://dense'], { since, limit: 100000 });
  console.log(`  ${TOTAL} events at one timestamp, page cap ${PAGE_CAP} -> downloaded ${got.length} (overflow of ${TOTAL - got.length} is unreachable via NIP-01)`);
  check('terminates with exactly one page from the saturated second', () => {
    assert.equal(got.length, PAGE_CAP);
  });
}

console.log(failed ? `\n${failed} check(s) FAILED\n` : '\nAll completeness checks passed.\n');
process.exit(failed ? 1 : 0);
