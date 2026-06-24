// client-tag-report.view.js
//
// A reference VIEW for Amy — the literal body of render(root, api) that
// save_view stores. Paste it into Amy's chat ("save this as a view") or use it
// as a query()/subscribe() stress test. It is intentionally demanding: it
// fans out across HUNDREDS of relays, so it doubles as a check that the relay
// pool stays correct and efficient under load.
//
// What it does
//   1. Builds one filter for "events in the last 7 days" and runs it against
//      every relay in a self-expanding pool, one relay at a time (api.queryAt)
//      so each event can be attributed to the relay it came from.
//   2. Parses every event's e / a / p tags for relay hints (tag[2]) and feeds
//      those relays back into the pool — the pool grows as the crawl runs.
//   3. De-dupes events across relays by id, then groups by the FIRST value of
//      the NIP-89 `client` tag (tag[1]) and ranks clients by event count.
//   4. Renders two bar charts: events-per-client (desc), then how many relays
//      were reached and unique-events-per-relay (desc).
//
// Efficiency (it must survive 100s of relays in a browser tab):
//   - Full events are NEVER buffered. We keep only a Set of seen ids (for
//     cross-relay dedup), a small client->count Map, and one integer per relay.
//     Each relay's events are processed as they land, then dropped.
//   - A fixed-size concurrency pool keeps only CONCURRENCY relays in flight at
//     once instead of opening hundreds of sockets simultaneously.
//   - The crawl runs in waves with a hard MAX_RELAYS cap and a per-relay
//     `limit`, so total work is bounded however many hints turn up.
//   - Client counting and hint harvesting happen only on an event's FIRST
//     sighting; charts render a capped number of bars to keep the DOM small.

const el = api.el;

// ---- tunables -------------------------------------------------------------
const DAYS = 7;              // window to report on
const PER_RELAY_LIMIT = 400; // events fetched per relay (query auto-paginates to fill)
const MAX_RELAYS = 200;      // hard cap on the self-expanding pool
const MAX_WAVES = 3;         // crawl depth: seeds -> their hints -> hints-of-hints
const CONCURRENCY = 10;      // relays queried at once (socket / memory budget)
const RELAY_TIMEOUT = 5000;  // per-relay idle timeout (ms)
const TOP_CLIENTS = 30;      // max client bars to draw
const TOP_RELAYS = 50;       // max relay bars to draw
const VERIFY = true;         // after the crawl, cross-check coverage: relays that
                             // returned the full limit are probed with NIP-45
                             // COUNT to estimate how many events we did NOT fetch
const TOP_GAPS = 20;         // max truncated-relay bars to draw

const now = Math.floor(Date.now() / 1000);
const since = now - DAYS * 86400;
// One filter, reused for every relay. No `authors` -> network-wide; the `since`
// window + `limit` bound each relay's payload. (Kinds left open so client tags
// on any kind are counted; set kinds here to narrow/speed up.)
const FILTER = { since, limit: PER_RELAY_LIMIT };

// ---- tiny style helpers ---------------------------------------------------
const card = (children) => el('div', { style: {
  background: 'var(--panel-2)', border: '1px solid var(--border)',
  borderRadius: 'var(--radius)', padding: '14px 16px', margin: '0 0 16px',
} }, children);
const heading = (t) => el('div', { style: { fontWeight: '600', margin: '0 0 12px', color: 'var(--text)' }, text: t });
const muted = (t) => el('div', { style: { color: 'var(--muted)', fontSize: '13px' }, text: t });

function barChart(rows) {
  if (!rows.length) return muted('No data.');
  const max = rows[0].value || 1;
  return el('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } }, rows.map((r) => {
    const pct = Math.max(2, Math.round((r.value / max) * 100));
    return el('div', { style: {
      display: 'grid', gridTemplateColumns: 'minmax(110px, 32%) 1fr auto', gap: '10px', alignItems: 'center',
    } }, [
      el('div', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '13px', color: 'var(--text)' }, title: r.label, text: r.label }),
      el('div', { style: { background: 'var(--panel-3)', borderRadius: '6px', overflow: 'hidden', height: '18px' } }, [
        el('div', { style: { width: pct + '%', height: '100%', background: 'var(--accent)' } }),
      ]),
      el('div', { style: { fontVariantNumeric: 'tabular-nums', fontSize: '13px', color: 'var(--muted)', minWidth: '52px', textAlign: 'right' }, text: r.value.toLocaleString() }),
    ]);
  }));
}

// ---- relay-hint parsing ---------------------------------------------------
function normalizeRelay(u) {
  if (typeof u !== 'string') return null;
  const s = u.trim();
  if (!/^wss?:\/\/.+/i.test(s)) return null; // only real ws/wss urls
  return s.replace(/\/+$/, '');               // drop trailing slash so variants dedupe
}

// ---- UI scaffold ----------------------------------------------------------
root.append(el('h2', { style: { margin: '0 0 4px', color: 'var(--text)' }, text: `Client-tag report · last ${DAYS} days` }));
const status = muted('Starting…');
root.append(el('div', { style: { margin: '0 0 16px' } }, status));
const out = el('div');
root.append(out);
const setStatus = (t) => { status.textContent = t; };

// ---- bounded-concurrency map over a fixed list ----------------------------
async function mapPool(items, concurrency, worker) {
  let i = 0;
  const run = async () => { while (i < items.length) { const idx = i++; await worker(items[idx], idx); } };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
}

try {
  // Accumulators — all O(unique events) or O(relays), never O(all events).
  const seen = new Set();          // event ids seen across ALL relays (dedup)
  const clientCounts = new Map();  // client name -> deduped event count
  const perRelay = new Map();      // relay url -> unique events it returned
  const queried = new Set();       // relays we've started a query against
  const hitLimit = new Set();      // relays that returned the FULL limit (suspect truncated)

  // Seed the pool, respecting the cap.
  let frontier = [];
  for (const u of (api.relays || [])) {
    const r = normalizeRelay(u);
    if (r && !queried.has(r) && queried.size < MAX_RELAYS) { queried.add(r); frontier.push(r); }
  }
  const seedCount = frontier.length;
  let doneRelays = 0;

  for (let wave = 0; wave < MAX_WAVES && frontier.length; wave++) {
    const discovered = new Set(); // relay hints found this wave -> next frontier

    await mapPool(frontier, CONCURRENCY, async (url) => {
      let evs;
      try {
        evs = await api.queryAt([url], FILTER, { timeout: RELAY_TIMEOUT });
      } catch {
        perRelay.set(url, 0); doneRelays++; return;
      }
      // queryAt already de-dupes by id within this relay, so evs.length is the
      // relay's unique-event count. Returning the FULL limit is the tell that
      // the relay had more in-window events than we fetched (see completeness).
      perRelay.set(url, evs.length);
      if (evs.length >= PER_RELAY_LIMIT) hitLimit.add(url);

      for (const ev of evs) {
        const id = ev && ev.id;
        if (!id || seen.has(id)) continue; // cross-relay dup: count once, parse once
        seen.add(id);
        const tags = ev.tags || [];
        let clientName = null;
        for (let t = 0; t < tags.length; t++) {
          const tag = tags[t];
          const name = tag[0];
          if (clientName === null && name === 'client' && tag[1]) clientName = String(tag[1]);
          else if ((name === 'e' || name === 'a' || name === 'p') && tag[2]) {
            const r = normalizeRelay(tag[2]);
            if (r && !queried.has(r)) discovered.add(r);
          }
        }
        if (clientName !== null) clientCounts.set(clientName, (clientCounts.get(clientName) || 0) + 1);
      }
      // evs goes out of scope here — nothing event-sized is retained.
      doneRelays++;
      setStatus(`Wave ${wave + 1}/${MAX_WAVES} · reached ${doneRelays}/${queried.size} relays · ${seen.size.toLocaleString()} unique events · ${clientCounts.size} clients…`);
    });

    // Promote this wave's discoveries to the next frontier, up to the cap.
    frontier = [];
    for (const r of discovered) {
      if (queried.size >= MAX_RELAYS) break;
      if (!queried.has(r)) { queried.add(r); frontier.push(r); }
    }
  }

  // ---- finalize -----------------------------------------------------------
  const clientRows = [...clientCounts.entries()]
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value);
  const withClient = clientRows.reduce((s, r) => s + r.value, 0);

  const relayRows = [...perRelay.entries()]
    .map(([url, value]) => ({ label: url.replace(/^wss?:\/\//, ''), value }))
    .sort((a, b) => b.value - a.value);

  // ---- completeness check -------------------------------------------------
  // Are we missing events? The per-relay `limit` (and a relay's own page cap)
  // mean a busy relay can hold MORE in-window events than we downloaded. A relay
  // that returned EXACTLY the limit is the tell. We confirm the gap with NIP-45
  // COUNT on just those suspects (cheap — COUNT reports a relay's total without
  // downloading it; relays that don't implement it simply can't be verified).
  const gaps = [];          // { url, downloaded, reported, missing }
  let unverifiable = 0;     // hit the limit but COUNT unsupported -> gap size unknown
  if (VERIFY && hitLimit.size) {
    const suspects = [...hitLimit];
    const reported = new Array(suspects.length).fill(0);
    setStatus(`Verifying coverage of ${suspects.length} relay(s) that returned the full limit…`);
    await mapPool(suspects, CONCURRENCY, async (url, i) => {
      try { reported[i] = await api.countAt([url], FILTER, { timeout: RELAY_TIMEOUT }); }
      catch { reported[i] = 0; }
    });
    suspects.forEach((url, i) => {
      const downloaded = perRelay.get(url) || 0;
      const rep = reported[i] || 0;
      if (rep > downloaded) gaps.push({ url, downloaded, reported: rep, missing: rep - downloaded });
      else if (rep === 0) unverifiable++;            // COUNT unsupported on this relay
    });
    gaps.sort((a, b) => b.missing - a.missing);
  }
  const missingTotal = gaps.reduce((s, g) => s + g.missing, 0);
  const verdict = hitLimit.size
    ? ` · ⚠ ${hitLimit.size} relay(s) likely truncated${missingTotal ? ` (≥${missingTotal.toLocaleString()} events missed)` : ''}`
    : '';

  out.innerHTML = '';
  setStatus(`Done · ${queried.size} relays reached out to · ${seen.size.toLocaleString()} unique events · ${withClient.toLocaleString()} carried a client tag${verdict}`);

  if (!seen.size) {
    out.append(card([
      heading('No events found'),
      muted('No relay returned events in this window. Some relays require NIP-42 auth — connect your signer and try again, or widen the window / kinds in the config.'),
    ]));
    return;
  }

  // Chart 1 — events per client, deduped network-wide, desc.
  const shownClients = clientRows.slice(0, TOP_CLIENTS);
  out.append(card([
    heading('Events by client (NIP-89 client tag)'),
    barChart(shownClients),
    el('div', { style: { marginTop: '12px' } }, muted(
      `${withClient.toLocaleString()} of ${seen.size.toLocaleString()} unique events had a client tag · ${clientRows.length} distinct client${clientRows.length === 1 ? '' : 's'}`
      + (clientRows.length > TOP_CLIENTS ? ` · showing top ${TOP_CLIENTS}` : ''),
    )),
  ]));

  // Chart 2 — relays reached + unique events per relay, desc.
  const shownRelays = relayRows.slice(0, TOP_RELAYS);
  const responded = relayRows.filter((r) => r.value > 0).length;
  out.append(card([
    heading('Unique events per relay'),
    el('div', { style: { marginBottom: '12px' } }, muted(
      `${queried.size} relays reached out to (from ${seedCount} seed${seedCount === 1 ? '' : 's'}, expanded via e/a/p relay hints) · ${responded} returned events`
      + (relayRows.length > TOP_RELAYS ? ` · showing top ${TOP_RELAYS}` : ''),
    )),
    barChart(shownRelays),
  ]));

  // Card 3 — completeness: did we actually get every event in the window?
  const complete = !hitLimit.size;
  out.append(card([
    heading('Completeness check — are we missing events?'),
    complete
      ? muted(`✓ No truncation detected. Every relay returned fewer than the per-relay limit (${PER_RELAY_LIMIT}), so the ${DAYS}-day window was fully drained on each — the counts above are complete (modulo any NIP-42 relays that returned nothing).`)
      : el('div', {}, [
          muted(`⚠ ${hitLimit.size} relay(s) returned the full per-relay limit (${PER_RELAY_LIMIT}) and almost certainly hold MORE in-window events than were counted.`),
          gaps.length
            ? el('div', { style: { marginTop: '6px' } }, muted(`NIP-45 COUNT confirms ≥ ${missingTotal.toLocaleString()} events were NOT downloaded across ${gaps.length} relay(s) — so every count above is a LOWER BOUND.`))
            : muted('Their COUNT support is missing, so the gap size could not be measured.'),
          unverifiable ? el('div', { style: { marginTop: '6px' } }, muted(`${unverifiable} suspect relay(s) don't support NIP-45 COUNT and couldn't be verified.`)) : null,
          el('div', { style: { marginTop: '8px' } }, muted('To close the gap: raise PER_RELAY_LIMIT, or drop the limit so the crawl pages the whole window by `since` (heavier, but complete).')),
          gaps.length ? el('div', { style: { marginTop: '10px' } }, barChart(gaps.slice(0, TOP_GAPS).map((g) => ({ label: g.url.replace(/^wss?:\/\//, ''), value: g.missing })))) : null,
        ]),
    el('div', { style: { marginTop: '10px' } }, muted('Caveat not covered by this check: events sharing one exact timestamp across a relay page boundary can also be skipped (pagination steps by whole seconds), so very high-rate relays may lose a few more.')),
  ]));
} catch (err) {
  out.innerHTML = '';
  out.append(card([heading('Report failed'), muted(String(err && err.stack || err))]));
}
