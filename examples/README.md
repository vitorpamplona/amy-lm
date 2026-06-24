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
