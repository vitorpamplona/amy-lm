// social.js — scope resolver + tag/filter/draft builders for the browser's
// social layer. Pure and dependency-free (no network): given something the
// browser is showing, it produces a single "scope" that downstream UI turns
// into queries, comments (NIP-22, kind 1111), and reactions (NIP-25, kind 7).
//
// The whole point is to MERGE three kinds of browsable content behind one
// comment/reaction UI:
//
//   • Web App  — a plain external URL. There is no Nostr event, so the social
//     layer is keyed off the URL via NIP-73 external content ids: an `i`/`I`
//     tag holding the URL plus a `k`/`K` tag holding the literal "web".
//   • nsite / nappet — the content IS a Nostr event, so we just comment on /
//     react to that event directly (NIP-22 `a`/`e` + NIP-25), the normal way.
//
// resolveScope() collapses both into { kind:'web', urls } or { kind:'nostr', … }.
// Everything below branches ONCE on scope.kind and is otherwise identical, so
// the bar/shade/composer/thread never has to know what it's looking at.
//
// NIP-22 tag shape recap: uppercase tags (I/K/A/E/P) pin the ROOT (the thing the
// whole thread is about); lowercase tags (i/k/a/e/p) point at the immediate
// PARENT. A top-level comment's parent == root; a reply's parent is the comment
// it answers, while the root stays pinned to the page/event.

// ---------------------------------------------------------------------------
// Web URL normalization — the join key
//
// A comment's `i` value is matched EXACTLY by relays (`#i` is not a prefix
// search), so the normalized string must be stable and match what other clients
// write, or threads silently fork. We keep this conservative: lowercase
// scheme+host, drop the fragment, strip well-known tracking params, and trim a
// lone trailing slash. We deliberately do NOT reorder or drop other query params
// (a naive writer wouldn't either), so our key stays predictable.
// ---------------------------------------------------------------------------

// Query keys that are pure click/campaign tracking — safe to strip everywhere.
const TRACKING_PARAMS = new Set([
  'gclid', 'fbclid', 'msclkid', 'yclid', 'dclid', 'gbraid', 'wbraid',
  'mc_eid', 'mc_cid', 'igshid', '_ga', '_gl', 'mkt_tok', '_hsenc', '_hsmi',
]);

function isTrackingParam(key) {
  const k = key.toLowerCase();
  return k.startsWith('utm_') || TRACKING_PARAMS.has(k);
}

/**
 * Normalize a web URL into a stable NIP-73 `i`/`I` value, or null if it isn't a
 * usable http(s) URL.
 */
export function normalizeWebUrl(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  u.hash = '';
  u.hostname = u.hostname.toLowerCase();
  // Re-emit the query with only the kept params, preserving their order.
  const kept = [...u.searchParams].filter(([k]) => !isTrackingParam(k));
  u.search = '';
  for (const [k, v] of kept) u.searchParams.append(k, v);
  // Trim a lone trailing slash on non-root paths so "/p/" and "/p" don't fork.
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.replace(/\/+$/, '');
  return u.toString();
}

/**
 * The three exact-URL "buckets" a web comment can be scoped to. These are
 * SEPARATE threads, not a hierarchy — relays only do exact `#i` matching, so
 * "whole site" is the bare-origin thread (a place for site-wide talk), NOT an
 * aggregate of every URL under the domain. Returns null for non-web URLs.
 *   page    — the full normalized URL (path + kept query)
 *   section — origin + path only (query dropped); equals `page` when no query
 *   site    — the origin root (scheme + host + "/")
 */
export function webUrlBuckets(raw) {
  const page = normalizeWebUrl(raw);
  if (!page) return null;
  const u = new URL(page);
  return {
    page,
    section: normalizeWebUrl(u.origin + u.pathname),
    site: normalizeWebUrl(u.origin),
  };
}

// ---------------------------------------------------------------------------
// Scope resolution
// ---------------------------------------------------------------------------

// Replaceable (0, 3, 1xxxx) and addressable (3xxxx) events are referenced by an
// `a` coordinate (`kind:pubkey:dtag`); everything else by its `e` event id.
function isAddressableKind(kind) {
  return (kind >= 30000 && kind < 40000) ||
         (kind >= 10000 && kind < 20000) ||
         kind === 0 || kind === 3;
}

function nostrScope(ev) {
  const author = ev.pubkey;
  const addressable = isAddressableKind(ev.kind);
  let addr = null;
  if (addressable) {
    const d = (ev.tags || []).find((t) => t[0] === 'd');
    addr = `${ev.kind}:${author}:${d ? d[1] : ''}`;
  }
  return { kind: 'nostr', event: ev, id: ev.id, author, eventKind: ev.kind, addressable, addr };
}

/**
 * Resolve whatever the browser is showing into a comment/reaction scope.
 *   - a URL string            -> { kind:'web',   urls:{page,section,site} }
 *   - a Nostr event object    -> { kind:'nostr', event, id, author, eventKind, addressable, addr }
 * Returns null if the target can't carry a social layer.
 */
export function resolveScope(target) {
  if (target == null) return null;
  if (typeof target === 'string') {
    const urls = webUrlBuckets(target);
    return urls ? { kind: 'web', urls } : null;
  }
  if (typeof target === 'object' && typeof target.kind === 'number' && target.id) return nostrScope(target);
  return null;
}

// ---------------------------------------------------------------------------
// Web bucket selection helpers
// ---------------------------------------------------------------------------

// Distinct bucket URLs in specificity order (page > section > site), de-duped —
// feed these to one `#i` subscription to populate all three counts at once.
export function webBucketUrls(scope) {
  if (!scope || scope.kind !== 'web') return [];
  const { page, section, site } = scope.urls;
  return [...new Set([page, section, site].filter(Boolean))];
}

// The single URL a given selection writes/reads. `sel` is 'page'|'section'|
// 'site'; anything else (or 'all') falls back to the most specific, 'page'.
function webSelUrl(scope, sel) {
  const u = scope.urls;
  return (sel === 'section' && u.section) || (sel === 'site' && u.site) || u.page;
}

// Which bucket an incoming web event belongs to, by its `i` tag — most specific
// match wins. Returns 'page'|'section'|'site'|null. Use to bin one multi-bucket
// subscription's events into per-bucket lists/counts.
export function webBucketOf(event, scope) {
  if (!scope || scope.kind !== 'web') return null;
  const i = (event.tags || []).find((t) => t[0] === 'i');
  if (!i) return null;
  const { page, section, site } = scope.urls;
  if (i[1] === page) return 'page';
  if (i[1] === section) return 'section';
  if (i[1] === site) return 'site';
  return null;
}

// ---------------------------------------------------------------------------
// Filters — kind 1111 comments + kind 7 reactions for a scope
// ---------------------------------------------------------------------------

/**
 * NIP-01 filter selecting comments (1111) and reactions (7) for a scope.
 * For web scopes, `sel` picks the bucket(s): 'page'|'section'|'site' for one,
 * or omitted/'all' for all three at once (the multi-bucket subscription).
 */
export function activityFilter(scope, sel) {
  if (!scope) return null;
  if (scope.kind === 'web') {
    const urls = (sel && sel !== 'all') ? [webSelUrl(scope, sel)] : webBucketUrls(scope);
    return { kinds: [1111, 7], '#i': urls, '#k': ['web'] };
  }
  return scope.addressable
    ? { kinds: [1111, 7], '#a': [scope.addr] }
    : { kinds: [1111, 7], '#e': [scope.id] };
}

// ---------------------------------------------------------------------------
// Draft builders — return { kind, content, tags } ready for api.publish()
// ---------------------------------------------------------------------------

// Root scope tags (uppercase) — the thing the whole thread is about.
function rootTags(scope, sel) {
  if (scope.kind === 'web') return [['I', webSelUrl(scope, sel)], ['K', 'web']];
  const k = String(scope.eventKind);
  return scope.addressable
    ? [['A', scope.addr], ['K', k], ['P', scope.author]]
    : [['E', scope.id, '', scope.author], ['K', k], ['P', scope.author]];
}

// Parent tags (lowercase) for a TOP-LEVEL comment — mirrors the root.
function topParentTags(scope, sel) {
  if (scope.kind === 'web') return [['i', webSelUrl(scope, sel)], ['k', 'web']];
  const k = String(scope.eventKind);
  return scope.addressable
    ? [['a', scope.addr], ['k', k], ['p', scope.author]]
    : [['e', scope.id, '', scope.author], ['k', k], ['p', scope.author]];
}

/**
 * A NIP-22 comment (kind 1111). `replyTo`, when given, is the kind-1111 comment
 * being answered: the root stays pinned to the page/event while the parent
 * points at that comment.
 */
export function draftComment(scope, sel, body, replyTo) {
  if (!scope) throw new Error('draftComment: no scope');
  const tags = [...rootTags(scope, sel)];
  if (replyTo) {
    tags.push(['e', replyTo.id, '', replyTo.pubkey], ['k', '1111']);
    if (replyTo.pubkey) tags.push(['p', replyTo.pubkey]);
  } else {
    tags.push(...topParentTags(scope, sel));
  }
  return { kind: 1111, content: body, tags };
}

/**
 * A NIP-25 reaction (kind 7) to the scope. `content` defaults to "+" (like);
 * pass "-" for a downvote or an emoji/shortcode for an emoji reaction.
 */
export function draftReaction(scope, sel, content = '+') {
  if (!scope) throw new Error('draftReaction: no scope');
  let tags;
  if (scope.kind === 'web') {
    tags = [['i', webSelUrl(scope, sel)], ['k', 'web']];
  } else if (scope.addressable) {
    tags = [['a', scope.addr], ['k', String(scope.eventKind)], ['p', scope.author]];
  } else {
    tags = [['e', scope.id, '', scope.author], ['k', String(scope.eventKind)], ['p', scope.author]];
  }
  return { kind: 7, content, tags };
}
