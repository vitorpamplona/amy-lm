// nostr.js — a tiny, dependency-free Nostr toolkit for the browser.
// Relay pool (NIP-01 REQ/EVENT/EOSE over WebSocket), NIP-42 relay AUTH,
// NIP-07 signer access, and NIP-19 bech32 (npub/nsec/note) encode/decode helpers.

// ---------------------------------------------------------------------------
// NIP-07 signer (browser extension exposes window.nostr)
// ---------------------------------------------------------------------------

// Stamp every event we sign with a NIP-89 "client" tag identifying this app,
// unless the event already carries one. Returns a shallow copy so callers'
// drafts are left untouched.
const CLIENT_TAG = ['client', 'Amy-LLM'];
function withClientTag(event) {
  const tags = (event && event.tags) || [];
  if (tags.some((t) => t[0] === 'client')) return event;
  return { ...event, tags: [...tags, CLIENT_TAG] };
}

export const signer = {
  available() { return typeof window !== 'undefined' && !!window.nostr; },
  async getPublicKey() {
    if (!this.available()) throw new Error('No NIP-07 signer found (install a Nostr extension).');
    return window.nostr.getPublicKey();
  },
  async signEvent(event) {
    if (!this.available()) throw new Error('No NIP-07 signer found.');
    return window.nostr.signEvent(withClientTag(event));
  },
  // Optional NIP-07 relay hint: { [url]: { read, write } }. Returns {} if unsupported.
  async getRelays() {
    if (!this.available() || !window.nostr.getRelays) return {};
    return window.nostr.getRelays();
  },
  // NIP-44 encryption (the modern scheme; required to seal/unseal NIP-59 gift
  // wraps and NIP-17 DMs). Throws if the extension doesn't implement nip44.
  nip44: {
    async encrypt(pubkey, plaintext) {
      if (!signer.available()) throw new Error('No NIP-07 signer found.');
      if (!window.nostr.nip44) throw new Error('Signer does not support NIP-44 encryption.');
      return window.nostr.nip44.encrypt(pubkey, plaintext);
    },
    async decrypt(pubkey, ciphertext) {
      if (!signer.available()) throw new Error('No NIP-07 signer found.');
      if (!window.nostr.nip44) throw new Error('Signer does not support NIP-44 decryption.');
      return window.nostr.nip44.decrypt(pubkey, ciphertext);
    },
  },
  // NIP-04 encryption (legacy/deprecated DM scheme). Kept for older events.
  nip04: {
    async encrypt(pubkey, plaintext) {
      if (!signer.available()) throw new Error('No NIP-07 signer found.');
      if (!window.nostr.nip04) throw new Error('Signer does not support NIP-04 encryption.');
      return window.nostr.nip04.encrypt(pubkey, plaintext);
    },
    async decrypt(pubkey, ciphertext) {
      if (!signer.available()) throw new Error('No NIP-07 signer found.');
      if (!window.nostr.nip04) throw new Error('Signer does not support NIP-04 decryption.');
      return window.nostr.nip04.decrypt(pubkey, ciphertext);
    },
  },
};

// ---------------------------------------------------------------------------
// Relay pool
// ---------------------------------------------------------------------------
const sockets = new Map(); // url -> WebSocket (kept warm and reused)

// While a NIP-42 handshake is in flight a request's idle timer must not fire and
// tear the subscription down — signing the kind 22242 event usually pops a NIP-07
// approval prompt that takes longer than the normal idle window. Hold the sub
// open this long instead, so the post-auth REQ replay actually lands.
const AUTH_GRACE_MS = 30000;

function connect(url) {
  // Upgrade ws:// to wss:// on HTTPS pages to avoid mixed-content blocks.
  if (typeof location !== 'undefined' && location.protocol === 'https:' && url.startsWith('ws://'))
    url = 'wss://' + url.slice(5);
  let ws = sockets.get(url);
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return ws;
  ws = new WebSocket(url);
  ws._subs = new Map(); // subId -> { onEvent, onEose, filters }
  ws._authWaiters = new Map(); // auth event id -> { resolve, reject }
  ws._challenge = null; // latest NIP-42 challenge string, if the relay sent one
  ws.addEventListener('message', (m) => {
    let data;
    try { data = JSON.parse(m.data); } catch { return; }
    const [type, a, b] = data;
    if (type === 'EVENT') { const sub = ws._subs.get(a); if (sub) sub.onEvent(b); return; }
    if (type === 'EOSE') { const sub = ws._subs.get(a); if (sub && sub.onEose) sub.onEose(); return; }
    // NIP-45: relay reports how many events match -> { count, approximate? }.
    if (type === 'COUNT') { const sub = ws._subs.get(a); if (sub && sub.onCount) sub.onCount(b && b.count); return; }
    // NIP-42: relay is asking us to authenticate. Remember the challenge and, if a
    // signer is connected, answer it proactively — don't wait for a request to be
    // refused first. Many relays withhold events silently (no CLOSED), so a refusal
    // may never come; authenticating up front means later REQs hit an already-authed
    // socket, and the OK handler replays anything already in flight. With no signer
    // we can't answer, so we just keep the challenge for a later lazy attempt.
    if (type === 'AUTH') {
      ws._challenge = a;
      if (signer.available()) authenticate(ws, url).catch(() => {});
      return;
    }
    // OK for one of our AUTH events -> settle the pending authenticate() call. On
    // success replay every active subscription: the relay now accepts us, but not
    // all relays send a CLOSED to flag which subs they were withholding (some just
    // stay silent), so we can't rely on a per-sub trigger to know what to resend.
    // Re-issuing an existing subId simply restarts that sub relay-side, which is
    // harmless (we de-dupe events by id), so resending them all is safe.
    if (type === 'OK') {
      const w = ws._authWaiters.get(a);
      if (w) {
        ws._authWaiters.delete(a);
        if (b) { w.resolve(); resendActiveSubs(ws); }
        else w.reject(new Error(data[3] || 'relay rejected AUTH'));
      }
      return;
    }
    // CLOSED with "auth-required" means this request needs NIP-42 auth first. It
    // bootstraps the handshake; the OK handler above does the actual replay (for
    // this sub and any others the relay silently withheld). Hold this sub's idle
    // clock open across the signer prompt so it isn't torn down mid-handshake.
    // Anything else CLOSED is just the stream's end.
    if (type === 'CLOSED') {
      const sub = ws._subs.get(a);
      if (!sub) return;
      if (/^auth-required/i.test(String(b || '')) && ws._challenge && !sub._authTried) {
        sub._authTried = true;
        // Hold every sub's idle clock open across the signer prompt, not just this
        // one: the relay may be silently withholding the others too, and the OK
        // handler replays them all once we authenticate.
        for (const s of ws._subs.values()) s.bump && s.bump(AUTH_GRACE_MS);
        authenticate(ws, url).catch(() => sub.onEose && sub.onEose());
      } else if (sub.onEose) {
        sub.onEose();
      }
      return;
    }
  });
  ws.addEventListener('close', () => { if (sockets.get(url) === ws) sockets.delete(url); });
  sockets.set(url, ws);
  return ws;
}

/**
 * Replay every active subscription's request on `ws`. Called once a NIP-42 AUTH
 * succeeds: relays that gate reads don't re-run our REQ/COUNT on their own after
 * we authenticate (and many never send a CLOSED to tell us which subs they held
 * back), so they sit idle until we ask again. Re-sending an existing subId just
 * restarts that subscription relay-side — harmless for ones already streaming, as
 * we de-dupe by id — so we resend them all and (re)arm each one's idle window.
 */
function resendActiveSubs(ws) {
  for (const [subId, sub] of ws._subs) {
    if (!sub.filters) continue;
    try { ws.send(JSON.stringify([sub.verb || 'REQ', subId, ...sub.filters])); } catch {}
    sub.bump && sub.bump(); // events should flow now — back to the normal idle window
  }
}

/**
 * NIP-42: answer a relay's AUTH challenge. We sign an ephemeral kind 22242
 * event (tagging the relay url and the challenge) with the NIP-07 signer and
 * send it as ["AUTH", event]. Resolves once the relay replies OK, rejects if it
 * refuses, times out, or there is no signer to authenticate with. We answer
 * whenever the relay asks (a challenge, or a request refused with auth-required),
 * so only relays that actually request auth ever trigger a signature prompt.
 *
 * `ws._authInFlight` is true while the handshake runs so a request sent in that
 * window can hold its idle clock open instead of giving up before we're authed.
 */
function authenticate(ws, url) {
  const challenge = ws._challenge;
  if (!challenge) return Promise.reject(new Error('relay sent no AUTH challenge'));
  if (!signer.available()) return Promise.reject(new Error('relay requires NIP-42 auth but no signer is connected'));
  if (ws._authPromise && ws._authedChallenge === challenge) return ws._authPromise;
  ws._authedChallenge = challenge;
  ws._authInFlight = true;
  ws._authPromise = (async () => {
    const pubkey = await signer.getPublicKey();
    const event = await signer.signEvent({
      kind: 22242,
      content: '',
      tags: [['relay', url], ['challenge', challenge]],
      created_at: Math.floor(Date.now() / 1000),
      pubkey,
    });
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { if (ws._authWaiters.delete(event.id)) reject(new Error('relay AUTH timed out')); }, 5000);
      const settle = (fn) => (v) => { clearTimeout(t); fn(v); };
      ws._authWaiters.set(event.id, { resolve: settle(resolve), reject: settle(reject) });
      try { ws.send(JSON.stringify(['AUTH', event])); }
      catch (e) { clearTimeout(t); ws._authWaiters.delete(event.id); reject(e); }
    });
  })();
  const settled = () => { ws._authInFlight = false; };
  ws._authPromise.then(settled, settled);
  return ws._authPromise;
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
 * Compile a NIP-01 filter into a fast predicate `(ev) => boolean`. Relays are
 * not trusted to return only what we asked for — some send spam, leak events
 * from other subscriptions, or have over-broad indexes — so we re-check every
 * event ourselves. This is essential for pagination: junk must NOT count toward
 * the per-round tally (or a round of pure junk looks non-empty and the
 * until-cursor never terminates) nor feed the cursor, and it must never reach
 * the app. The `search` field is full-text and relay-defined, so only the
 * structured constraints are checked.
 *
 * The list fields (ids/authors/kinds and #tag values) are hoisted into Sets
 * ONCE here, so each event is an O(1) lookup instead of a linear scan — matching
 * runs per event on potentially thousands of events against filters that may
 * carry hundreds of authors (a follow feed), so this matters.
 */
function compileFilter(filter) {
  const ids = filter.ids ? new Set(filter.ids) : null;
  const authors = filter.authors ? new Set(filter.authors) : null;
  const kinds = filter.kinds ? new Set(filter.kinds) : null;
  const since = filter.since, until = filter.until;
  const tagSets = []; // [{ letter, values:Set }] for each #<letter> filter
  for (const key in filter) {
    if (key.length !== 2 || key[0] !== '#') continue;
    const want = filter[key];
    if (Array.isArray(want) && want.length) tagSets.push({ letter: key[1], values: new Set(want) });
  }
  return (ev) => {
    if (!ev || typeof ev !== 'object' || !ev.id) return false;
    if (ids && !ids.has(ev.id)) return false;
    if (authors && !authors.has(ev.pubkey)) return false;
    if (kinds && !kinds.has(ev.kind)) return false;
    if (since !== undefined && !(ev.created_at >= since)) return false;
    if (until !== undefined && !(ev.created_at <= until)) return false;
    for (let s = 0; s < tagSets.length; s++) {
      const { letter, values } = tagSets[s];
      const tags = ev.tags || [];
      let ok = false;
      for (let i = 0; i < tags.length; i++) { const t = tags[i]; if (t[0] === letter && values.has(t[1])) { ok = true; break; } }
      if (!ok) return false;
    }
    return true;
  };
}
/**
 * Compile a REQ's filter array into one predicate that is true when the event
 * satisfies AT LEAST ONE filter (NIP-01 OR). Compile once per subscription and
 * reuse it for every event — never per event.
 */
function compileMatcher(filterArr) {
  const fns = filterArr.map(compileFilter);
  if (fns.length === 1) return fns[0];
  return (ev) => { for (let i = 0; i < fns.length; i++) if (fns[i](ev)) return true; return false; };
}

/**
 * Low-level one-round primitive: a SINGLE REQ to ONE relay with the given
 * filter(s). Resolves with that relay's events once it sends EOSE or goes
 * silent for `timeout` ms.
 *
 * `timeout` is an IDLE window, not a wall-clock deadline: it is armed before
 * the socket opens (so a relay that never connects still resolves) and reset on
 * every incoming event, so a relay actively streaming a large backlog keeps
 * gathering until it actually stops (or sends EOSE) — only a genuine pause
 * longer than `timeout` ends it. De-dup and sorting are the caller's job; this
 * is the round that query() paginates over.
 */
function reqOnce(url, filterArr, opts = {}) {
  const idle = opts.timeout ?? 4000;
  const subId = nextSubId();
  const match = compileMatcher(filterArr); // compile once; run per event below
  const events = [];
  return new Promise((resolve) => {
    let done = false, idleTimer = null;
    const finish = () => { if (done) return; done = true; clearTimeout(idleTimer); cleanup(); resolve(events); };
    // (Re)start the idle countdown — on REQ send and on every event — so the
    // deadline only fires after a real pause in the stream.
    const bump = (ms = idle) => { if (done) return; clearTimeout(idleTimer); idleTimer = setTimeout(finish, ms); };
    let ws, cleanup = () => {};
    try {
      ws = connect(url);
    } catch { return finish(); }
    ws._subs.set(subId, {
      // Only keep events that actually match the REQ; a relay sending junk must
      // not pollute results or pagination. Still bump on any message — the relay
      // is alive and working, so don't let unmatched noise trip the idle timer.
      onEvent: (ev) => { if (match(ev)) events.push(ev); bump(); },
      // Some relays send a silent empty EOSE instead of CLOSED auth-required when
      // the client is not yet authenticated. If a NIP-42 handshake is in flight,
      // hold the sub open so resendActiveSubs() can replay it once OK arrives.
      onEose: () => { ws._authInFlight ? bump(AUTH_GRACE_MS) : finish(); },
      filters: filterArr, // kept so a NIP-42 auth-required REQ can be replayed
      bump,               // lets the NIP-42 handshake hold the idle clock open
    });
    cleanup = () => {
      ws._subs.delete(subId);
      try { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(['CLOSE', subId])); } catch {}
    };
    bump(); // arm now so a relay that never opens still resolves (no hang)
    whenOpen(ws)
      // Reset the idle clock once the REQ is actually out. If a NIP-42 handshake is
      // still running, hold open longer: the relay won't answer until we're authed,
      // and the AUTH OK will replay this REQ — don't give up before then.
      .then(() => { ws.send(JSON.stringify(['REQ', subId, ...filterArr])); bump(ws._authInFlight ? AUTH_GRACE_MS : idle); })
      .catch(finish);
  });
}

/**
 * Auto-paginate ONE filter against ONE relay, working around the relay's
 * internal page cap (relays silently return only N events even when you ask for
 * more, then EOSE). Apps just say `limit: 2000` or a `since`/`until` window and
 * expect it filled; they won't drive the cursor themselves, so we do it.
 *
 * We walk a `until` cursor backwards in time: fetch a round, set the next
 * `until` to the oldest event's created_at — INCLUSIVE — fetch again, and
 * accumulate de-duplicated events (by id). Paging inclusively re-requests the
 * boundary second, so events that share the page's oldest timestamp but spilled
 * just past the relay's page limit are still picked up next round; the id de-dup
 * drops the ones we re-see. Each round asks only for what's still needed
 * (limit = remaining), so a relay capping at 500 fills a limit:2000 request in
 * a few rounds. We stop when:
 *   - a round adds zero new events (the relay has nothing older to give), or
 *   - we've collected the filter's `limit`, or
 *   - the cursor drops below the filter's `since` (walked out the bottom of the
 *     requested window), or
 *   - a filter with neither limit nor since hits the `maxPages` safety cap
 *     (otherwise it would walk the relay's entire history) — we warn, not loop.
 *
 * NIP-50 search filters are relevance-ranked, not time-ranked, so until-paging
 * would scramble them; those (and opts.paginate === false) do a single round.
 *
 * Inclusive paging can't loop: whenever a whole page comes back at a SINGLE
 * second equal to the cursor — a second holding more events than the relay will
 * page at once, so re-requesting `<= until` just repeats it — we step the cursor
 * strictly below that second. This holds even against a relay that returns a
 * different page of same-second events each time (it would otherwise pin us),
 * because we step down on the shape of the page, not on whether it was new. Only
 * that second's overflow is lost — unreachable via NIP-01 time paging on that
 * relay (filters can't exclude seen ids), the one inherent gap.
 */
async function paginate(url, filter, opts = {}) {
  const singleRound = opts.paginate === false || !!filter.search;
  const maxPages = opts.maxPages ?? 25;
  const aborted = opts.aborted || (() => false); // lets subscribe() stop a backfill
  const onEvent = opts.onEvent;                  // each NEW (de-duped) event is pushed here as it lands
  const since = filter.since;
  const target = typeof filter.limit === 'number' ? filter.limit : Infinity;
  const unbounded = target === Infinity && since === undefined;
  // We keep only IDS for de-dup + cursor + limit accounting — never the events
  // themselves — so a deep backfill streams through onEvent without piling the
  // whole result up in memory. Callers that want the events collect them in
  // their onEvent (query does); streaming callers process and discard each one.
  const seenIds = new Set();
  let until = filter.until;
  for (let round = 0; ; round++) {
    if (aborted()) break;
    const remaining = target === Infinity ? undefined : target - seenIds.size;
    if (remaining !== undefined && remaining <= 0) break;
    const f = { ...filter };
    if (until === undefined) delete f.until; else f.until = until;
    if (remaining !== undefined) f.limit = remaining;
    const evs = await reqOnce(url, [f], opts);
    // Count NEWLY-SEEN events and track the time span of the WHOLE page (dups
    // included). The span reveals when a single saturated second is pinning the
    // inclusive cursor, so we can step past it instead of re-requesting forever.
    let added = 0, pageMin = Infinity, pageMax = -Infinity;
    for (const ev of evs) {
      const ts = ev && typeof ev.created_at === 'number' ? ev.created_at : undefined;
      if (ts !== undefined) { if (ts < pageMin) pageMin = ts; if (ts > pageMax) pageMax = ts; }
      if (ev && ev.id && !seenIds.has(ev.id)) {
        seenIds.add(ev.id); added++;
        if (onEvent && !aborted()) onEvent(ev);
      }
    }
    if (singleRound) break;

    // A page that is ENTIRELY one second, and that second is the cursor (or the
    // cursor is still open, so this is the newest second with nothing above it):
    // the relay has handed us its whole page for that second, so any remaining
    // events at it are beyond the page and unreachable (NIP-01 can't exclude ids
    // we've already seen), and nothing older came back. Step STRICTLY below it —
    // re-requesting the same second returns the same page, and a misbehaving
    // relay that returned a DIFFERENT page each time would otherwise pin the
    // cursor here forever. Checked before `added` so it holds even then.
    if (evs.length && pageMin === pageMax && (until === undefined || pageMin === until)) {
      until = pageMin - 1;
    } else if (added > 0) {
      // Otherwise walk to the page's oldest second INCLUSIVELY, so events
      // sharing that second that fell past the relay's page edge are recovered
      // next round (de-dup drops the repeats). A page with no usable timestamps
      // can't be paged further.
      if (!Number.isFinite(pageMin)) break;
      until = pageMin;
    } else {
      break; // no new events on a multi-second page -> relay exhausted (or re-sending)
    }

    if (since !== undefined && until < since) break;  // past the window's start
    if (unbounded && round + 1 >= maxPages) {         // safety net for "everything"
      console.warn(`nostr.query: stopped paginating ${url} after ${maxPages} pages; set a limit/since or raise opts.maxPages`);
      break;
    }
  }
  return seenIds.size; // unique events this relay yielded (events were streamed, not retained)
}

/** Sort newest-first (unless sortDesc is false) and, for a single limited
 *  non-search filter, cap the cross-relay union to that limit — so limit:2000
 *  yields ~2000, not 2000×(number of relays). */
function finalize(seen, filterArr, sortDesc) {
  let events = [...seen.values()];
  if (sortDesc) events = events.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  const only = filterArr.length === 1 ? filterArr[0] : null;
  if (only && typeof only.limit === 'number' && !only.search) events = events.slice(0, only.limit);
  return events;
}

/**
 * Shared fan-out core for query / outboxQuery (and their streaming forms).
 * Paginates every [url, filters[]] pair in parallel — each relay walks its own
 * cursor — de-dups across them by id, and runs every event through `emit`. Two
 * modes, picked by opts.buffer:
 *   - buffered (default): collect events into a Map, return finalize()'d array
 *     (sorted, union-capped). This is the classic query() result.
 *   - streaming (opts.buffer === false): keep only a Set of ids, never the
 *     events, and return the unique count — for emit-and-discard sweeps.
 * In BOTH modes, opts.onEvent(event, url) (if given) fires for each de-duped
 * event the moment it lands, so a caller can process incrementally; a throw
 * from it is swallowed so one bad event can't abort the run.
 * @param {Array<[string, object[]]>} pairs
 * @returns {Promise<object[]|number>} array when buffered, else the unique count
 */
async function fanout(pairs, filterArr, opts, sortDesc) {
  const buffer = opts.buffer !== false;
  const onEvent = opts.onEvent;
  const seenMap = buffer ? new Map() : null; // id -> event (buffered)
  const seenIds = buffer ? null : new Set(); // ids only (streaming)
  let count = 0;
  const emit = (ev, url) => {
    if (!ev || !ev.id) return;
    if (buffer) { if (seenMap.has(ev.id)) return; seenMap.set(ev.id, ev); }
    else { if (seenIds.has(ev.id)) return; seenIds.add(ev.id); }
    count++;
    if (onEvent) { try { onEvent(ev, url); } catch { /* a bad handler must not abort the run */ } }
  };
  await Promise.all(pairs.flatMap(([url, fs]) =>
    fs.map((filter) => paginate(url, filter, { ...opts, onEvent: (ev) => emit(ev, url) }))
  ));
  return buffer ? finalize(seenMap, filterArr, sortDesc) : count;
}

/**
 * One-shot query across relays, auto-paginated per relay (see paginate) so apps
 * get the `limit` / time window they asked for even when relays cap a single
 * REQ. Resolves with a de-duplicated array of events, sorted newest-first by
 * default (pass opts.sort === false to keep arrival order — NIP-50 search relays
 * return relevance order, which a time sort would lose).
 *
 * Streaming hooks (shared with outboxQuery): pass opts.onEvent(event, url) to
 * process each event as it is de-duped while STILL getting the final array; pass
 * opts.buffer === false to NOT retain events and resolve with the unique count
 * instead — the emit-and-discard mode (see queryStream for the tidy signature).
 * @param {string[]} relays
 * @param {object|object[]} filters - NIP-01 filter(s)
 * @param {object} [opts] - { timeout=4000 (idle ms), maxPages=25, paginate=true, sort, onEvent, buffer }
 * @returns {Promise<object[]|number>}
 */
export async function query(relays, filters, opts = {}) {
  const filterArr = Array.isArray(filters) ? filters : [filters];
  return fanout(relays.map((url) => [url, filterArr]), filterArr, opts, opts.sort !== false);
}

/**
 * Streaming one-shot query — the emit-and-discard shorthand for
 * query(relays, filters, { onEvent, buffer: false }). Calls onEvent(event, url)
 * for each event the moment it is de-duped across relays, holding only a Set of
 * ids (never the events), so a caller can process and discard each one without
 * the whole result set living in memory. Built for big network-wide sweeps over
 * hundreds of relays.
 *
 * Delivery is ARRIVAL order (not sorted), and each relay is still bounded by the
 * filter's `limit` / `since`/`until`, but there is NO cross-relay union cap —
 * every de-duplicated event is emitted, so bound the work with `since`/`limit`.
 * Resolves with the total unique-event count once every relay's pagination ends.
 * @param {string[]} relays
 * @param {object|object[]} filters - NIP-01 filter(s)
 * @param {(event: object, url: string) => void} onEvent
 * @param {object} [opts] - same as query(): { timeout, maxPages, paginate }
 * @returns {Promise<number>}
 */
export function queryStream(relays, filters, onEvent, opts = {}) {
  return query(relays, filters, { ...opts, onEvent, buffer: false });
}

/**
 * Live subscription with automatic historical backfill. Calls onEvent for each
 * event (incl. ones arriving after EOSE) and returns an unsubscribe function.
 *
 * Two parts run concurrently and feed the same de-duplicated onEvent, so the
 * caller sees one merged stream:
 *   - a LIVE sub per relay (the filter with `since` = now) that stays open and
 *     delivers FUTURE events as they are published, and
 *   - a BACKFILL that paginates the PAST (from `until` = now backwards) exactly
 *     like query() — walking an `until` cursor until the relay is exhausted, the
 *     filter's `limit` is reached, or the cursor passes its `since`.
 * So a large backlog loads page by page while new events still arrive live,
 * with no gap at the boundary: the two overlap only at `now` and dedupe by id.
 *
 * A filter whose `until` is already in the past is a closed historical window —
 * backfilled only, no live sub. NIP-50 search filters (and opts.paginate ===
 * false / opts.backfill === false) skip the split and open a single plain REQ,
 * since until-paging would scramble relevance order.
 *
 * opts.onEose (optional) fires once when the initial backfill across every relay
 * and filter has finished — the "history loaded" signal for a UI.
 */
export function subscribe(relays, filters, onEvent, opts = {}) {
  const filterArr = Array.isArray(filters) ? filters : [filters];
  const now = Math.floor(Date.now() / 1000);
  const seen = new Set();
  const deliver = (ev, url) => { if (ev && ev.id && !seen.has(ev.id)) { seen.add(ev.id); onEvent(ev, url); } };

  let stopped = false;
  const closers = [];

  // Open one long-lived REQ per relay for `liveFilters` (no idle timeout — it
  // stays open until unsubscribe and streams events as they arrive).
  const openLive = (liveFilters) => {
    const subId = nextSubId();
    const match = compileMatcher(liveFilters); // compile once, reuse across relays + events
    for (const url of relays) {
      let ws;
      try { ws = connect(url); } catch { continue; }
      ws._subs.set(subId, {
        // Validate live events too: a relay must not push events that don't
        // match (incl. old events on a since=now live sub — only future ones).
        onEvent: (ev) => { if (match(ev)) deliver(ev, url); },
        filters: liveFilters, // kept so a NIP-42 auth-required REQ can be replayed
      });
      whenOpen(ws).then(() => ws.send(JSON.stringify(['REQ', subId, ...liveFilters]))).catch(() => {});
      closers.push(() => {
        ws._subs.delete(subId);
        try { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(['CLOSE', subId])); } catch {}
      });
    }
  };

  const noSplit = (f) => f.search || opts.paginate === false || opts.backfill === false;

  // Search / opt-out filters: one plain open REQ, as-is (no since/until rewrite).
  const plain = filterArr.filter(noSplit);
  if (plain.length) openLive(plain);

  const split = filterArr.filter((f) => !noSplit(f));

  // Live part: future events only, and only for open-ended filters (a filter
  // with `until` in the past has no future to watch). Drop limit/until.
  const liveFilters = split
    .filter((f) => f.until === undefined || f.until >= now)
    .map((f) => { const g = { ...f, since: now }; delete g.until; delete g.limit; return g; });
  if (liveFilters.length) openLive(liveFilters);

  // Backfill part: paginate each split filter's past (until = now), streaming
  // events through `deliver` and bailing out promptly when unsubscribed.
  Promise.all(relays.flatMap((url) =>
    split.map((f) => paginate(url, { ...f, until: f.until ?? now },
      { ...opts, onEvent: (ev) => deliver(ev, url), aborted: () => stopped }))
  )).then(() => { if (!stopped && opts.onEose) opts.onEose(); }).catch(() => {});

  return () => { stopped = true; closers.forEach((c) => c()); };
}

/**
 * NIP-45 COUNT: ask relays how many events match the filter(s). Returns the
 * largest count any single relay reports — counts are per-relay and relays
 * overlap, so they are NOT additive; the max is the best single-number estimate.
 * Resolves once every relay answers or goes silent for `timeout` ms (an idle
 * window armed when the COUNT is sent, same as query()). Relays that don't
 * implement NIP-45 simply never answer (they're covered by the timeout), and
 * the count itself may be approximate, so treat it as a ballpark, not a total.
 * @param {string[]} relays
 * @param {object|object[]} filters - NIP-01 filter(s)
 * @param {object} [opts] - { timeout=4000 }
 * @returns {Promise<number>}
 */
export async function count(relays, filters, opts = {}) {
  const idle = opts.timeout ?? 4000;
  const filterArr = Array.isArray(filters) ? filters : [filters];
  const subId = nextSubId();
  let max = 0;

  const perRelay = relays.map((url) => new Promise((resolve) => {
    let done = false, idleTimer = null;
    const finish = () => { if (done) return; done = true; clearTimeout(idleTimer); ws && ws._subs.delete(subId); resolve(); };
    const bump = (ms = idle) => { if (done) return; clearTimeout(idleTimer); idleTimer = setTimeout(finish, ms); };
    let ws;
    try { ws = connect(url); } catch { return finish(); }
    ws._subs.set(subId, {
      onCount: (n) => { if (typeof n === 'number' && n > max) max = n; finish(); },
      // Same silent-EOSE guard as reqOnce: hold open if auth is in flight.
      onEose: () => { ws._authInFlight ? bump(AUTH_GRACE_MS) : finish(); },
      filters: filterArr, // kept so a NIP-42 auth-required COUNT can be replayed
      verb: 'COUNT',
      bump,               // lets the NIP-42 handshake hold the idle clock open
    });
    bump(); // arm now so a relay that never opens / never answers still finishes
    whenOpen(ws)
      // Hold open through an in-flight NIP-42 handshake — see reqOnce for why.
      .then(() => { ws.send(JSON.stringify(['COUNT', subId, ...filterArr])); bump(ws._authInFlight ? AUTH_GRACE_MS : idle); })
      .catch(finish);
  }));

  await Promise.all(perRelay);

  return max;
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
    let ws, retriedAuth = false;
    try { ws = connect(url); } catch { return resolve({ url, ok: false, error: 'connect failed' }); }
    const onMsg = (m) => {
      let d; try { d = JSON.parse(m.data); } catch { return; }
      if (d[0] === 'OK' && d[1] === event.id) {
        const ok = !!d[2], error = d[3] || null;
        // NIP-42: relay wants us authenticated before it will accept the event.
        if (!ok && /auth-required/i.test(error || '') && ws._challenge && !retriedAuth) {
          retriedAuth = true;
          authenticate(ws, url)
            .then(() => { try { ws.send(JSON.stringify(['EVENT', event])); } catch {} })
            .catch(() => { ws.removeEventListener('message', onMsg); resolve({ url, ok: false, error }); });
          return;
        }
        ws.removeEventListener('message', onMsg);
        resolve({ url, ok, error });
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
const namedListCache = new Map(); // `${kind}:${pubkey}` -> string[]

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

/**
 * Generic per-NIP relay-list resolver (cached). NIP-65 (kind 10002) is the
 * GENERAL outbox for notes/profiles/reactions, but it is not universal — many
 * features keep their own relay list under their own replaceable kind, e.g.
 * 10050 (NIP-17 DM relays), 10007 (search relays), 10063 (blossom media
 * servers), and NIP-51 relay sets. Those tag URLs with `relay` (or `r`) and
 * usually have no read/write markers. Use this to read any of them; use
 * relayListFor() for the markered NIP-65 outbox specifically.
 * @returns {Promise<string[]>}
 */
export async function relaysFromList(pubkey, kind, seedRelays, opts = {}) {
  const cacheKey = `${kind}:${pubkey}`;
  if (!opts.force && namedListCache.has(cacheKey)) return namedListCache.get(cacheKey);
  let urls = [];
  try {
    const evs = await query(seedRelays, { kinds: [kind], authors: [pubkey], limit: 1 }, { timeout: opts.timeout ?? 4000 });
    const ev = evs[0];
    if (ev) {
      const seen = new Set();
      for (const t of ev.tags || []) {
        if ((t[0] === 'relay' || t[0] === 'r') && t[1] && !seen.has(t[1])) { seen.add(t[1]); urls.push(t[1]); }
      }
    }
  } catch { /* fall through to empty */ }
  namedListCache.set(cacheKey, urls);
  return urls;
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

/**
 * Outbox-routed one-shot query. Routes the filter(s) to each author's write
 * relays (author-less filters go to the seeds), then runs the SAME fan-out core
 * as query(): every routed relay is auto-paginated, the union is de-duped by id,
 * and the result is capped to the original filter's limit (routing splits
 * authors across relays, so the union can otherwise exceed it). Resolves with a
 * de-duplicated array, newest-first.
 *
 * Same streaming hooks as query(): opts.onEvent(event, url) for incremental
 * processing, opts.buffer === false for ids-only emit-and-discard (returns the
 * unique count — see outboxQueryStream for the tidy signature).
 * @returns {Promise<object[]|number>}
 */
export async function outboxQuery(seedRelays, filters, opts = {}) {
  const filterArr = Array.isArray(filters) ? filters : [filters];
  const routed = await routeByOutbox(seedRelays, filterArr, opts);
  return fanout([...routed], filterArr, opts, true);
}

/**
 * Outbox-routed streaming query — the emit-and-discard shorthand for
 * outboxQuery(seeds, filters, { onEvent, buffer: false }). Routes like
 * outboxQuery, then calls onEvent(event, url) for each event as it is de-duped
 * across the routed relays, retaining only ids. Same streaming contract as
 * queryStream (arrival order, no cross-relay union cap). Resolves with the count.
 * @returns {Promise<number>}
 */
export function outboxQueryStream(seedRelays, filters, onEvent, opts = {}) {
  return outboxQuery(seedRelays, filters, { ...opts, onEvent, buffer: false });
}

/**
 * Outbox-routed NIP-45 COUNT. Routes the filter to each author's write relays
 * (author-less filters go to the seeds) and returns the largest count reported,
 * since per-relay counts are not additive. Approximate — see count().
 * @returns {Promise<number>}
 */
export async function outboxCount(seedRelays, filters, opts = {}) {
  const filterArr = Array.isArray(filters) ? filters : [filters];
  const routed = await routeByOutbox(seedRelays, filterArr, opts);
  const counts = await Promise.all([...routed].map(([url, fs]) => count([url], fs, opts)));
  return counts.reduce((m, n) => (n > m ? n : m), 0);
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
// NIP-50 (search) — send `search` filters to dedicated full-text relays
//
// Search is NOT an outbox concern: you usually search without knowing the
// author, and the `search` filter field is only honored by relays that index
// full text (most general relays ignore it). So search routes to dedicated
// search relays, resolved per-user from their NIP-51 search-relay list
// (kind 10007), and falls back to seeds + these well-known public indexers.
// ---------------------------------------------------------------------------
export const DEFAULT_SEARCH_RELAYS = [
  'wss://relay.nostr.band',
  'wss://search.nos.today',
  'wss://relay.noswhere.com',
];

/**
 * Decide which relays a NIP-50 search should go to. Preference order:
 * 1. the user's own kind 10007 search-relay list (if a pubkey is given),
 * 2. otherwise the seed/discovery relays plus the well-known indexers.
 * De-duplicated; always resolves to a non-empty list.
 * @param {string|null} pubkey - whose search-relay list to use (or null)
 * @param {string[]} seedRelays
 * @returns {Promise<string[]>}
 */
export async function searchRelaysFor(pubkey, seedRelays, opts = {}) {
  let urls = [];
  if (pubkey) { try { urls = await relaysFromList(pubkey, 10007, seedRelays, opts); } catch { /* fall through */ } }
  if (!urls.length) urls = [...(seedRelays || []), ...DEFAULT_SEARCH_RELAYS];
  return [...new Set(urls)];
}

/**
 * One-shot NIP-50 search. Merges `searchText` into the `search` field of each
 * filter and sends them to search relays (NOT outbox-routed). Results keep the
 * relays' relevance order rather than being re-sorted by time.
 * @param {string[]} seedRelays - discovery/fallback relays
 * @param {string} searchText - the human query (NIP-50 `search` field)
 * @param {object|object[]} [filters] - optional NIP-01 filter(s) to constrain it
 * @param {object} [opts] - { pubkey, relays, timeout, sort }. opts.relays forces
 *   explicit search relays (bypassing resolution); opts.pubkey picks whose
 *   kind 10007 list to use. sort defaults to false to preserve relevance order.
 * @returns {Promise<event[]>}
 */
export async function search(seedRelays, searchText, filters = {}, opts = {}) {
  const relays = (opts.relays && opts.relays.length)
    ? opts.relays
    : await searchRelaysFor(opts.pubkey || null, seedRelays, opts);
  const filterArr = (Array.isArray(filters) ? filters : [filters])
    .map((f) => ({ ...f, search: searchText }));
  return query(relays, filterArr, { sort: false, ...opts });
}

/**
 * Live NIP-50 search subscription. Same routing as search(); calls onEvent for
 * each match (incl. ones arriving after EOSE). Returns an unsubscribe function.
 * Resolution is async, so events start flowing once the relays are picked.
 */
export function searchSubscribe(seedRelays, searchText, filters = {}, onEvent, opts = {}) {
  const filterArr = (Array.isArray(filters) ? filters : [filters])
    .map((f) => ({ ...f, search: searchText }));
  let closer = () => {};
  let stopped = false;
  const ready = (opts.relays && opts.relays.length)
    ? Promise.resolve(opts.relays)
    : searchRelaysFor(opts.pubkey || null, seedRelays, opts);
  ready.then((relays) => {
    if (stopped) return;
    closer = subscribe(relays, filterArr, onEvent, opts);
  }).catch(() => {});
  return () => { stopped = true; closer(); };
}

// ---------------------------------------------------------------------------
// NIP-19 (bech32) — npub / nsec / note / nprofile / nevent / naddr / nrelay.
// The codec lives in nip19.js; re-exported here so `nostr.nip19` keeps working
// for importers.
// ---------------------------------------------------------------------------
export { nip19 } from './nip19.js';
