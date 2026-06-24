# Example views

Reference views for Amy — each file is the literal **body of `render(root, api)`**
that `save_view` stores (see [`js/views.js`](../js/views.js) for the contract and
the `api` surface). They're not loaded by the app automatically; use them by:

- pasting the body into Amy's chat and asking her to "save this as a view", or
- as a standalone exercise of `js/nostr.js`'s `query` / `subscribe` primitives.

## `client-tag-report.view.js`

A 7-day report, built as a deliberate stress test of the relay pool:

1. Runs one "last 7 days" filter against every relay in a **self-expanding
   pool** — starting from the seed relays and growing as it parses the relay
   hints in each event's `e` / `a` / `p` tags (`tag[2]`) and adds those relays
   to the crawl.
2. De-dupes events across relays by `id`, then groups by the first value of the
   NIP-89 `client` tag and ranks clients by event count (bar chart, desc).
3. Below that, charts how many relays were reached and the count of unique
   events each relay returned (bar chart, desc).

It's designed to stay light across **hundreds of relays in a browser tab**:

- full events are never buffered — it keeps only a `Set` of seen ids, a small
  `client → count` map, and one integer per relay;
- a fixed-size concurrency pool keeps only ~10 relays in flight at a time;
- the crawl runs in bounded waves with a hard relay cap and a per-relay `limit`.

Tunables (window, per-relay limit, relay cap, crawl depth, concurrency, chart
sizes) are constants at the top of the file.

### Benchmark / regression test

[`bench/relay-pool.bench.mjs`](../bench/relay-pool.bench.mjs) runs this exact
view body over a simulated 180-relay network (mock WebSocket, no real sockets)
wired to the real [`js/nostr.js`](../js/nostr.js) `query()`. It asserts the
efficiency invariants — one warm socket per relay (no reconnect churn),
pagination reuse, in-flight REQs bounded by `CONCURRENCY`, exact cross-relay
de-dup, and bounded retained memory — and prints a metrics report:

```bash
npm test          # run the checks (exit non-zero on regression)
npm run bench     # same, with a GC-stable heap-delta number
```

### Are we missing events?

Efficiency is not completeness. Two things make this view silently *undercount*
on a real network, both confirmed against `js/nostr.js`:

1. **Per-relay `limit` (`PER_RELAY_LIMIT`)** — a relay with more in-window
   events than the limit returns only the newest `limit`; the rest are dropped.
   On a busy relay a 7-day window is far more than 400 events, so this is the
   dominant gap.
2. **Dense same-second skip** — pagination advances by whole seconds, so events
   sharing one `created_at` across a relay page boundary can be skipped.

The view answers "are we missing events?" at runtime with a **completeness
check** (third card): any relay that returns *exactly* the limit is the tell
that it was truncated, and the view confirms the gap size with a NIP-45 `COUNT`
probe on just those suspects. The result is shown as a ⚠ in the status line, a
lower-bound count of missed events, and a per-relay "missing events" chart.

[`bench/completeness.bench.mjs`](../bench/completeness.bench.mjs) verifies that
detection: it stands up relays bigger than the limit (some without `COUNT`
support) and asserts the check flags exactly the truncated ones, quantifies the
gap, leaves a fully-drained network unflagged, and it characterizes the
dense-second loss against the real `paginate()`.
