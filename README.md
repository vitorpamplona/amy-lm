# Amy — a Nostr client that builds itself

Amy is a concept for a [Nostr](https://nostr.com) client with an LLM chat
(Claude) at its center. The app ships knowing only three things:

1. **Nostr** — NIP-01 events, relays, and how to read any NIP on demand.
2. **NIP-07 signers** — it talks to your browser's Nostr extension (Alby,
   nos2x, …) to sign and publish.
3. **How to reach an LLM** — it calls **Claude (Anthropic)**, **OpenAI**, or
   **Gemini (Google)** directly from the browser using your own key. Paste any
   of them; Amy detects which one it is.

From there, *you* build the client. Tell the chat what you want to see —
"a feed of the latest notes", "a profile card", "a box to publish a note" —
and Claude writes a small live **view** that renders on the canvas. Your
project (views, chat, settings) is saved in the browser, so it loads right
back up when you return.

There is **no server**. Everything runs client-side; Nostr relays and your
chosen LLM API (Anthropic, OpenAI, or Google) are the only things it talks to.

The UI ships with **light and dark themes** — use the ☀/☾ button in the top
bar to switch. Your choice is remembered (and defaults to your system
preference). Themes are driven by CSS variables on `:root`, which the views
Amy builds inherit, so generated interfaces restyle to match automatically.

## Run it

It's plain static files — no build step. Serve the folder over HTTP (ES
modules don't load from `file://`):

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

## First-time setup

1. Click **Log in** (top right). The guided dialog links you to the
   [Anthropic Console](https://console.anthropic.com/settings/keys) (Claude),
   [OpenAI Platform](https://platform.openai.com/api-keys) (OpenAI), and
   [Google AI Studio](https://aistudio.google.com/apikey) (Gemini) to create an
   API key. Paste any one — Amy detects the provider from the key
   (`sk-ant-…` → Claude, `sk-…` → OpenAI, `AIza…`/`AQ.…` → Gemini) and verifies
   it live before connecting. The key is stored only in this browser's
   `localStorage` and sent directly to that provider's API. (Model and relays
   live in **Settings**.)
2. (Optional) Click **Connect signer** to authorize your NIP-07 extension so
   views can read your pubkey and publish on your behalf. If a Nostr extension
   is detected, Amy prompts you to do this right after you log in. **No
   extension yet?** The same dialog walks you through installing one — it
   suggests [Alby](https://getalby.com/products/browser-extension) (or nos2x),
   where you create a fresh Nostr key (or import an existing `nsec`), then hit
   **Retry**. Connecting **imports your own relays** (NIP-65) so the outbox
   model routes through the network you actually use — no manual relay setup —
   and **remembers you**: on your next visit your profile loads automatically,
   no reconnect needed. (Use the menu's **Disconnect signer** to forget it.)
3. Ask the chat to build something.

> **Why paste a key instead of "Sign in"?** Amy has no server to hold a
> session, so it authenticates with a key you own, kept entirely in your
> browser. All three providers' inference endpoints allow direct browser access
> (CORS), so a verified key works immediately.

## How it works

| File             | Responsibility                                                        |
| ---------------- | --------------------------------------------------------------------- |
| `index.html`     | App shell: canvas (left) + chat (right) + settings dialog.            |
| `js/app.js`      | Orchestration, project state, the system prompt, and the model's tools.|
| `js/auth.js`     | Detects the provider from a pasted key and verifies it live.          |
| `js/llm.js`      | Claude, OpenAI **and** Gemini API client + the shared tool-use loop.   |
| `js/nostr.js`    | Relay pool (query/subscribe/publish/count), NIP-42 relay AUTH, NIP-45 counts, NIP-07 signer, NIP-19 bech32. |
| `js/views.js`    | Runtime that executes a generated view into the page with an `api`.   |
| `js/storage.js`  | Persists the whole project to `localStorage`.                         |
| `js/theme.js`    | Light/dark theme preference (persisted separately, survives reset).   |

### The tools the model has

- `read_nip` — fetch any NIP's markdown from the `nostr-protocol/nips` repo.
- `query_relays` — run a one-shot Nostr query to inspect real data.
- `get_context` — read the connected pubkey and configured relays.
- `save_view` / `list_views` / `delete_view` — create and manage the live
  interfaces shown on the canvas.

### The view contract

Each view is JavaScript executed as `render(root, api)`. `root` is a fresh
element to populate; `api` exposes `query`, `subscribe`, `publish`, `count`,
`signer`, `nip19`, a tiny `el()` DOM helper, `timeAgo()`, and per-view `getState`/
`setState`. A view may return an unsubscribe function for live feeds, which
Amy calls when the view is closed.

## Security notes

This is a build-your-own-client concept, so it **executes model-generated
JavaScript in your page on purpose** — that is the feature, not a bug. The
code runs with your session's privileges and can sign events through your
NIP-07 extension (which still prompts you per signature). Your API key lives
in `localStorage`. Treat this as a personal, single-user tool; don't host a
shared instance with these trust assumptions.
