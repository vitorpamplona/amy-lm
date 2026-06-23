# Amy — a Nostr client that builds itself

Amy is a concept for a [Nostr](https://nostr.com) client with an LLM chat
(Claude) at its center. The app ships knowing only three things:

1. **Nostr** — NIP-01 events, relays, and how to read any NIP on demand.
2. **NIP-07 signers** — it talks to your browser's Nostr extension (Alby,
   nos2x, …) to sign and publish.
3. **How to reach Claude** — it calls the Anthropic API directly from the
   browser using your own key.

From there, *you* build the client. Tell the chat what you want to see —
"a feed of the latest notes", "a profile card", "a box to publish a note" —
and Claude writes a small live **view** that renders on the canvas. Your
project (views, chat, settings) is saved in the browser, so it loads right
back up when you return.

There is **no server**. Everything runs client-side; Nostr relays and the
Anthropic API are the only things it talks to.

## Run it

It's plain static files — no build step. Serve the folder over HTTP (ES
modules don't load from `file://`):

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

## First-time setup

1. Open **Settings** and paste your Anthropic API key. It is stored only in
   this browser's `localStorage`. Optionally set the model and relays.
2. (Optional) Click **Connect signer** to authorize your NIP-07 extension so
   views can read your pubkey and publish on your behalf.
3. Ask the chat to build something.

## How it works

| File             | Responsibility                                                        |
| ---------------- | --------------------------------------------------------------------- |
| `index.html`     | App shell: canvas (left) + chat (right) + settings dialog.            |
| `js/app.js`      | Orchestration, project state, the system prompt, and Claude's tools.  |
| `js/claude.js`   | Anthropic Messages API client + the tool-use loop.                    |
| `js/nostr.js`    | Relay pool (query/subscribe/publish), NIP-07 signer, NIP-19 bech32.   |
| `js/views.js`    | Runtime that executes a generated view into the page with an `api`.   |
| `js/storage.js`  | Persists the whole project to `localStorage`.                         |

### The tools Claude has

- `read_nip` — fetch any NIP's markdown from the `nostr-protocol/nips` repo.
- `query_relays` — run a one-shot Nostr query to inspect real data.
- `get_context` — read the connected pubkey and configured relays.
- `save_view` / `list_views` / `delete_view` — create and manage the live
  interfaces shown on the canvas.

### The view contract

Each view is JavaScript executed as `render(root, api)`. `root` is a fresh
element to populate; `api` exposes `query`, `subscribe`, `publish`, `signer`,
`nip19`, a tiny `el()` DOM helper, `timeAgo()`, and per-view `getState`/
`setState`. A view may return an unsubscribe function for live feeds, which
Amy calls when the view is closed.

## Security notes

This is a build-your-own-client concept, so it **executes model-generated
JavaScript in your page on purpose** — that is the feature, not a bug. The
code runs with your session's privileges and can sign events through your
NIP-07 extension (which still prompts you per signature). Your API key lives
in `localStorage`. Treat this as a personal, single-user tool; don't host a
shared instance with these trust assumptions.
