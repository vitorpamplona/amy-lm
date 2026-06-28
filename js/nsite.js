// nsite.js — export an Amy project as a NIP-5A static website ("nsite").
//
// A NIP-5A site is a signed manifest event whose `path` tags map absolute paths
// to the SHA-256 of files stored on Blossom. Hosts (e.g. <npub>.nsite.lol) read
// the manifest, fetch each blob by hash, and serve a normal website.
//
// Amy's "views" are JavaScript, not static HTML, so a faithful export ships the
// real view runtime (views.js/nostr.js/…) as part of the site plus a small
// bootstrap that renders the saved views — making the published nsite a working,
// self-contained client. We also generate the trimmings that make it look right
// when shared: a favicon, an Apple touch icon, and an OpenGraph preview image.
//
// Kinds (NIP-5A):
//   15128  root site   — one per pubkey (replaceable, no `d`)
//   35128  named site  — addressable under a short `d` id
// Tags: ["path", "/abs/path", "<sha256>"], ["x", "<aggregate>", "aggregate"],
//       ["server", url], ["title"|"description"|"source", value], ["d", id].

import * as nostr from './nostr.js';
import * as blossom from './blossom.js';

export const KIND_ROOT = 15128;
export const KIND_NAMED = 35128;
const SOURCE_URL = 'https://github.com/vitorpamplona/amy-lm';

// Runtime files copied verbatim from the running app into the published site.
// Keys are the absolute paths inside the nsite; the relative imports between
// these modules resolve identically there, so nothing needs rewriting.
const RUNTIME = {
  '/js/views.js': new URL('./views.js', import.meta.url),
  '/js/nostr.js': new URL('./nostr.js', import.meta.url),
  '/js/nip19.js': new URL('./nip19.js', import.meta.url),
  '/js/markdown.js': new URL('./markdown.js', import.meta.url),
  '/js/theme.js': new URL('./theme.js', import.meta.url),
  '/js/bootstrap.js': new URL('./nsite-bootstrap.js', import.meta.url),
  '/css/style.css': new URL('../css/style.css', import.meta.url),
};

const enc = (s) => new TextEncoder().encode(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------------------------------------------------------------------------
// Naming / addressing
// ---------------------------------------------------------------------------

/** Turn a project name into a valid named-site id: ^[a-z0-9-]{1,13}$. */
export function slugify(name) {
  const s = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 13).replace(/-+$/g, '');
  return s || 'site';
}

// base36 of a hex pubkey — the subdomain label NIP-5A uses for named sites.
function pubkeyB36(pubkeyHex) {
  return BigInt('0x' + pubkeyHex).toString(36);
}

/**
 * The canonical browse URL for a site on a given gateway host. Root sites get
 * the clean <npub>.<host>; named sites use <pubkeyB36><dTag>.<host> per NIP-5A.
 */
export function hostUrlFor({ kind, pubkey, dTag, host }) {
  const h = String(host || 'nsite.lol').replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (kind === KIND_NAMED) return `https://${pubkeyB36(pubkey)}${dTag}.${h}/`;
  return `https://${nostr.nip19.npubEncode(pubkey)}.${h}/`;
}

// ---------------------------------------------------------------------------
// NIP-5A aggregate hash
// ---------------------------------------------------------------------------

/**
 * The manifest's aggregate `x`: for each path tag form `<sha256> <path>\n`, sort
 * the lines lexicographically, concatenate, and SHA-256 the result. Two sites
 * with the same files share an aggregate regardless of author or metadata.
 */
export async function aggregateHash(pathTags) {
  const body = pathTags.map(([, path, hash]) => `${hash} ${path}\n`).sort().join('');
  return blossom.sha256Hex(enc(body));
}

// ---------------------------------------------------------------------------
// Generated site files
// ---------------------------------------------------------------------------

function indexHtml({ title, description, siteUrl, ogUrl }) {
  const t = esc(title);
  const d = esc(description || 'A Nostr client, built with Amy and published as an nsite.');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="color-scheme" content="dark light" />
<title>${t}</title>
<meta name="description" content="${d}" />
<meta name="theme-color" content="#f7931a" />
<link rel="icon" type="image/svg+xml" href="./favicon.svg" />
<link rel="apple-touch-icon" href="./apple-touch-icon.png" />
<meta property="og:type" content="website" />
<meta property="og:title" content="${t}" />
<meta property="og:description" content="${d}" />
<meta property="og:url" content="${esc(siteUrl)}" />
<meta property="og:image" content="${esc(ogUrl)}" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta property="og:image:alt" content="${t}" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${t}" />
<meta name="twitter:description" content="${d}" />
<meta name="twitter:image" content="${esc(ogUrl)}" />
<script>
(function(){try{var t=localStorage.getItem('amy.theme');if(t!=='light'&&t!=='dark'){t=matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';}document.documentElement.setAttribute('data-theme',t);}catch(e){document.documentElement.setAttribute('data-theme','dark');}})();
</script>
<link rel="stylesheet" href="./css/style.css" />
</head>
<body>
<noscript>This site is an interactive Nostr client and needs JavaScript enabled.</noscript>
<script type="module" src="./js/bootstrap.js"></script>
</body>
</html>
`;
}

function notFoundHtml({ title }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="color-scheme" content="dark light" />
<title>Not found — ${esc(title)}</title>
<script>(function(){try{var t=localStorage.getItem('amy.theme');document.documentElement.setAttribute('data-theme',t==='light'?'light':'dark');}catch(e){}})();</script>
<link rel="stylesheet" href="./css/style.css" />
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--text);font:15px/1.6 system-ui,sans-serif;text-align:center}a{color:var(--accent)}</style>
</head>
<body>
<div>
<h1 style="font-size:54px;margin:0;color:var(--accent)">404</h1>
<p>That page isn’t part of this nsite.</p>
<p><a href="./">← Back to ${esc(title)}</a></p>
</div>
</body>
</html>
`;
}

function projectJson({ name, description, key, relays, views }) {
  return JSON.stringify({
    name,
    description: description || '',
    key,
    builtWith: SOURCE_URL,
    generatedAt: Math.floor(Date.now() / 1000),
    relays: relays || [],
    views: views.map((v) => ({ id: v.id, title: v.title, lineage: v.lineage, version: v.version, code: v.code })),
  }, null, 2);
}

// ---------------------------------------------------------------------------
// Icons + OpenGraph image (drawn on a canvas so the site looks complete when
// shared, with no external assets).
// ---------------------------------------------------------------------------

// A lightning bolt in a 24×24 box — Amy's mark.
const BOLT = 'M13 2 L4 14 L11 14 L9 22 L20 10 L13 10 Z';

function canvasToPng(canvas) {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? b.arrayBuffer().then((a) => resolve(new Uint8Array(a))) : reject(new Error('PNG encode failed'))), 'image/png'));
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function drawBolt(ctx, size, color) {
  const s = (size / 24) * 0.62;
  ctx.save();
  ctx.translate(size / 2 - 12 * s, size / 2 - 12 * s);
  ctx.scale(s, s);
  ctx.fillStyle = color;
  ctx.fill(new Path2D(BOLT));
  ctx.restore();
}

// Rounded gradient tile with a white bolt — used for the favicon/touch icon.
async function iconPng(size) {
  const c = makeCanvas(size, size);
  const ctx = c.getContext('2d');
  const r = size * 0.22;
  ctx.beginPath();
  ctx.roundRect(0, 0, size, size, r);
  ctx.clip();
  const g = ctx.createLinearGradient(0, 0, size, size);
  g.addColorStop(0, '#f7931a');
  g.addColorStop(1, '#7c5cff');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  drawBolt(ctx, size, '#ffffff');
  return canvasToPng(c);
}

function faviconSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
<defs><linearGradient id="g" x1="0" y1="0" x2="24" y2="24" gradientUnits="userSpaceOnUse">
<stop stop-color="#f7931a"/><stop offset="1" stop-color="#7c5cff"/></linearGradient></defs>
<rect width="24" height="24" rx="5" fill="url(#g)"/>
<path d="${BOLT}" fill="#fff"/>
</svg>
`;
}

function wrapLines(ctx, text, maxWidth, maxLines) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    const next = line ? line + ' ' + w : w;
    if (ctx.measureText(next).width > maxWidth && line) { lines.push(line); line = w; }
    else line = next;
    if (lines.length === maxLines - 1 && ctx.measureText(line).width > maxWidth) break;
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) { lines.length = maxLines; lines[maxLines - 1] = lines[maxLines - 1].replace(/.{1}$/, '…'); }
  return lines;
}

// 1200×630 social card: dark brand background, the bolt badge, the site title,
// a tagline, and a footer noting the view count.
async function ogPng({ title, viewCount }) {
  const w = 1200, h = 630;
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#0e1014';
  ctx.fillRect(0, 0, w, h);
  const glow1 = ctx.createRadialGradient(w, 0, 0, w, 0, 900);
  glow1.addColorStop(0, 'rgba(247,147,26,0.22)'); glow1.addColorStop(1, 'transparent');
  ctx.fillStyle = glow1; ctx.fillRect(0, 0, w, h);
  const glow2 = ctx.createRadialGradient(0, h, 0, 0, h, 800);
  glow2.addColorStop(0, 'rgba(124,92,255,0.20)'); glow2.addColorStop(1, 'transparent');
  ctx.fillStyle = glow2; ctx.fillRect(0, 0, w, h);

  // Badge
  const bx = 90, by = 84, bs = 104;
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(bx, by, bs, bs, 24);
  ctx.clip();
  const bg = ctx.createLinearGradient(bx, by, bx + bs, by + bs);
  bg.addColorStop(0, '#f7931a'); bg.addColorStop(1, '#7c5cff');
  ctx.fillStyle = bg; ctx.fillRect(bx, by, bs, bs);
  ctx.translate(bx, by);
  drawBolt(ctx, bs, '#ffffff');
  ctx.restore();

  ctx.fillStyle = '#aab2c8';
  ctx.font = '600 30px system-ui, sans-serif';
  ctx.fillText('AMY · NOSTR NSITE', bx + bs + 28, by + 64);

  // Title
  ctx.fillStyle = '#e8eaf1';
  ctx.font = '700 84px system-ui, sans-serif';
  const lines = wrapLines(ctx, title, w - 180, 2);
  let ty = 320;
  for (const ln of lines) { ctx.fillText(ln, 90, ty); ty += 100; }

  // Tagline + footer
  ctx.fillStyle = '#aab2c8';
  ctx.font = '400 34px system-ui, sans-serif';
  ctx.fillText('A Nostr client this person built — and published on Nostr.', 90, Math.min(ty + 6, 540));
  ctx.fillStyle = '#f7931a';
  ctx.font = '600 28px system-ui, sans-serif';
  ctx.fillText(`${viewCount} view${viewCount === 1 ? '' : 's'} · runs entirely in your browser`, 90, 580);

  return canvasToPng(c);
}

// ---------------------------------------------------------------------------
// File assembly
// ---------------------------------------------------------------------------

function contentType(path) {
  if (path.endsWith('.html')) return 'text/html; charset=utf-8';
  if (path.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (path.endsWith('.css')) return 'text/css; charset=utf-8';
  if (path.endsWith('.json')) return 'application/json; charset=utf-8';
  if (path.endsWith('.svg')) return 'image/svg+xml';
  if (path.endsWith('.png')) return 'image/png';
  return 'application/octet-stream';
}

// Latest version of each lineage, in lineage order — the default the exporter
// publishes unless the user opts to include every version.
function latestPerLineage(allViews) {
  const order = [];
  const best = new Map();
  for (const v of allViews) {
    if (!best.has(v.lineage)) order.push(v.lineage);
    const cur = best.get(v.lineage);
    if (!cur || v.version > cur.version) best.set(v.lineage, v);
  }
  return order.map((l) => best.get(l));
}

/**
 * Build every file the nsite will contain as { path, bytes, type }. Fetches the
 * live runtime modules + stylesheet from the running app (so the published copy
 * matches exactly), generates the HTML/bootstrap data, and draws the icons.
 */
async function buildFiles({ title, description, key, relays, views, siteUrl, ogUrl }) {
  const files = [];
  const add = (path, bytes) => files.push({ path, bytes, type: contentType(path) });

  // Runtime modules + stylesheet, copied verbatim.
  for (const [path, url] of Object.entries(RUNTIME)) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Could not read runtime file ${path}`);
    add(path, enc(await res.text()));
  }

  // Generated pages + data.
  add('/index.html', enc(indexHtml({ title, description, siteUrl, ogUrl })));
  add('/404.html', enc(notFoundHtml({ title })));
  add('/project.json', enc(projectJson({ name: title, description, key, relays, views })));

  // Icons + social card.
  add('/favicon.svg', enc(faviconSvg()));
  add('/apple-touch-icon.png', await iconPng(180));
  add('/og.png', await ogPng({ title, viewCount: views.length }));

  return files;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Export a project as a NIP-5A nsite: build files, upload blobs to Blossom, and
 * publish the signed manifest to the author's relays.
 *
 * @param {object} project - the live Amy project (views + settings)
 * @param {object} opts - { kind, dTag, title, description, servers, host, includeAllVersions }
 * @param {object} hooks - { step(text), detail(text), progress(done, total) } progress callbacks
 * @returns {Promise<{ event, siteUrl, naddr, servers, relayResults }>}
 */
export async function exportNsite(project, opts, hooks = {}) {
  const step = hooks.step || (() => {});
  const detail = hooks.detail || (() => {});
  const progress = hooks.progress || (() => {});

  const pubkey = project.settings.pubkey;
  if (!pubkey) throw new Error('Connect your Nostr signer before exporting.');
  const seeds = project.settings.relays;
  const kind = opts.kind === KIND_ROOT ? KIND_ROOT : KIND_NAMED;
  const dTag = kind === KIND_NAMED ? slugify(opts.dTag || opts.title || project.name) : '';
  const title = (opts.title || project.name || 'Amy nsite').trim();
  const description = (opts.description || '').trim();
  const servers = (opts.servers || []).map((s) => s.trim()).filter(Boolean);
  if (!servers.length) throw new Error('Add at least one Blossom server to upload to.');

  step('Collecting views');
  const chosen = opts.includeAllVersions ? project.views.slice() : latestPerLineage(project.views);
  if (!chosen.length) throw new Error('There are no views to export yet.');

  const siteUrl = hostUrlFor({ kind, pubkey, dTag, host: opts.host });
  const ogUrl = siteUrl + 'og.png';

  step('Generating site files, icons & preview');
  const files = await buildFiles({
    title, description, key: dTag || 'root', relays: seeds, views: chosen, siteUrl, ogUrl,
  });

  step('Hashing files');
  for (const f of files) f.hash = await blossom.sha256Hex(f.bytes);

  step('Authorizing upload (approve in your signer)');
  const header = blossom.authHeader(await blossom.createUploadAuth(files.map((f) => f.hash)));

  // Upload every file to every server. A server "covers" the site only if it
  // accepted ALL files, so we intersect the per-file successes; the manifest's
  // `server` hints are the servers that hold the complete site.
  step('Uploading to Blossom');
  let covering = null;
  const total = files.length;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    detail(`${i + 1}/${total} ${f.path}`);
    const accepted = new Set();
    let lastErr;
    for (const server of servers) {
      try { accepted.add(await blossom.putBlob(server, f.bytes, f.type, header)); }
      catch (e) { lastErr = e; }
    }
    if (!accepted.size) throw new Error(`No Blossom server accepted ${f.path}: ${lastErr ? lastErr.message : 'unknown error'}`);
    covering = covering === null ? accepted : new Set([...covering].filter((s) => accepted.has(s)));
    progress(i + 1, total);
  }
  if (!covering || !covering.size) {
    throw new Error('No single Blossom server holds every file. Try one reliable server, or fewer servers.');
  }
  const serverHints = [...covering];

  step('Building manifest');
  const pathTags = files.map((f) => ['path', f.path, f.hash]).sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  const x = await aggregateHash(pathTags);
  const tags = [
    ...pathTags,
    ['x', x, 'aggregate'],
    ...serverHints.map((s) => ['server', s]),
    ['title', title],
  ];
  if (description) tags.push(['description', description]);
  tags.push(['source', SOURCE_URL]);
  if (kind === KIND_NAMED) tags.push(['d', dTag]);

  step('Publishing manifest to your relays (approve in your signer)');
  const { event, results } = await nostr.outboxPublish(seeds, { kind, content: '', tags });
  const okRelays = results.filter((r) => r.ok).map((r) => r.url);
  if (!okRelays.length) throw new Error('No relay accepted the manifest. Check your relay settings and try again.');

  const naddr = nostr.nip19.naddrEncode({ identifier: dTag, pubkey, kind, relays: okRelays.slice(0, 3) });
  return { event, siteUrl, naddr, servers: serverHints, relayResults: results };
}
