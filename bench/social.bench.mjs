// social.bench.mjs — covers js/social.js, the pure scope/tag/filter/draft logic
// behind the browser's social layer (NIP-22 comments + NIP-25 reactions keyed
// off NIP-73 external ids). No network: every function is deterministic, so
// these pin the wire shape that other clients have to interoperate with.

import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(join(ROOT, p)).href);

let failed = 0;
const check = (d, fn) => { try { fn(); console.log(`  ✓ ${d}`); } catch (e) { failed++; console.log(`  ✗ ${d}\n      ${e.message}`); } };

const s = await imp('js/social.js');

// ===========================================================================
// URL normalization — the join key other clients must match exactly
// ===========================================================================
console.log('\nWeb URL normalization');
{
  check('lowercases scheme+host, strips default port, fragment, utm, trailing /', () =>
    assert.equal(
      s.normalizeWebUrl('HTTPS://App.Example.com:443/U/Vitor/?utm_source=x&ref=y#frag'),
      'https://app.example.com/U/Vitor?ref=y'));
  check('keeps a non-default port and meaningful query', () =>
    assert.equal(s.normalizeWebUrl('http://x.com:8080/a?b=1'), 'http://x.com:8080/a?b=1'));
  check('preserves path case (paths are case-sensitive)', () =>
    assert.equal(s.normalizeWebUrl('https://x.com/A/B'), 'https://x.com/A/B'));
  check('root path keeps its single slash', () =>
    assert.equal(s.normalizeWebUrl('https://x.com'), 'https://x.com/'));
  check('rejects non-http(s) and garbage', () => {
    assert.equal(s.normalizeWebUrl('ftp://x.com'), null);
    assert.equal(s.normalizeWebUrl('mailto:a@b.com'), null);
    assert.equal(s.normalizeWebUrl('not a url'), null);
  });
}

// ===========================================================================
// Buckets — three EXACT-match threads (relays don't prefix-match #i)
// ===========================================================================
console.log('\nWeb buckets');
{
  check('splits a URL into page / section / site', () =>
    assert.deepEqual(s.webUrlBuckets('https://app.example.com/u/vitor?tab=posts'), {
      page: 'https://app.example.com/u/vitor?tab=posts',
      section: 'https://app.example.com/u/vitor',
      site: 'https://app.example.com/',
    }));
  check('page == section when there is no query', () => {
    const b = s.webUrlBuckets('https://x.com/post/1');
    assert.equal(b.page, b.section);
  });
  check('webBucketUrls de-dupes collapsed buckets', () =>
    assert.deepEqual(s.webBucketUrls(s.resolveScope('https://x.com/')), ['https://x.com/']));
}

// ===========================================================================
// Scope resolution
// ===========================================================================
console.log('\nScope resolution');
{
  check('a URL string resolves to a web scope', () => {
    const sc = s.resolveScope('https://x.com/a');
    assert.equal(sc.kind, 'web');
    assert.equal(sc.urls.page, 'https://x.com/a');
  });
  check('an addressable event resolves to an #a coordinate (nsite kind 34128)', () => {
    const sc = s.resolveScope({ id: 'eeee', pubkey: 'aaaa', kind: 34128, tags: [['d', 'index.html']] });
    assert.equal(sc.kind, 'nostr');
    assert.equal(sc.addressable, true);
    assert.equal(sc.addr, '34128:aaaa:index.html');
  });
  check('a regular event resolves by event id (no addr)', () => {
    const sc = s.resolveScope({ id: 'ffff', pubkey: 'bbbb', kind: 1 });
    assert.equal(sc.addressable, false);
    assert.equal(sc.addr, null);
  });
  check('non-resolvable targets return null', () => {
    assert.equal(s.resolveScope(null), null);
    assert.equal(s.resolveScope('ftp://x.com'), null);
    assert.equal(s.resolveScope({ kind: 1 }), null); // no id
  });
}

// ===========================================================================
// Activity filters (kinds 1111 + 7)
// ===========================================================================
console.log('\nActivity filters');
{
  const web = s.resolveScope('https://app.example.com/u/vitor?tab=posts');
  check('web scope, no selection -> all three buckets via #i', () =>
    assert.deepEqual(s.activityFilter(web), {
      kinds: [1111, 7],
      '#i': ['https://app.example.com/u/vitor?tab=posts', 'https://app.example.com/u/vitor', 'https://app.example.com/'],
      '#k': ['web'],
    }));
  check('web scope, one bucket -> just that URL', () =>
    assert.deepEqual(s.activityFilter(web, 'site'), { kinds: [1111, 7], '#i': ['https://app.example.com/'], '#k': ['web'] }));
  check('addressable scope -> #a', () =>
    assert.deepEqual(
      s.activityFilter(s.resolveScope({ id: 'eeee', pubkey: 'aaaa', kind: 34128, tags: [['d', 'index.html']] })),
      { kinds: [1111, 7], '#a': ['34128:aaaa:index.html'] }));
  check('regular scope -> #e', () =>
    assert.deepEqual(
      s.activityFilter(s.resolveScope({ id: 'ffff', pubkey: 'bbbb', kind: 1 })),
      { kinds: [1111, 7], '#e': ['ffff'] }));
}

// ===========================================================================
// Draft builders — the NIP-22 / NIP-25 wire shape
// ===========================================================================
console.log('\nComment + reaction drafts');
{
  const web = s.resolveScope('https://app.example.com/u/vitor?tab=posts');
  check('web top-level comment: root I/K + parent i/k mirror', () => {
    const d = s.draftComment(web, 'page', 'hi');
    assert.equal(d.kind, 1111);
    assert.equal(d.content, 'hi');
    assert.deepEqual(d.tags, [
      ['I', 'https://app.example.com/u/vitor?tab=posts'], ['K', 'web'],
      ['i', 'https://app.example.com/u/vitor?tab=posts'], ['k', 'web'],
    ]);
  });
  check('web reply: root stays pinned, parent points at the comment', () => {
    const d = s.draftComment(web, 'page', 're', { id: 'cccc', pubkey: 'pppp', kind: 1111 });
    assert.deepEqual(d.tags, [
      ['I', 'https://app.example.com/u/vitor?tab=posts'], ['K', 'web'],
      ['e', 'cccc', '', 'pppp'], ['k', '1111'], ['p', 'pppp'],
    ]);
  });
  check('web reaction targets the selected bucket', () =>
    assert.deepEqual(s.draftReaction(web, 'section'), { kind: 7, content: '+', tags: [['i', 'https://app.example.com/u/vitor'], ['k', 'web']] }));

  const nsite = s.resolveScope({ id: 'eeee', pubkey: 'aaaa', kind: 34128, tags: [['d', 'index.html']] });
  check('addressable comment: A/K/P root + a/k/p parent', () =>
    assert.deepEqual(s.draftComment(nsite, null, 'hi').tags, [
      ['A', '34128:aaaa:index.html'], ['K', '34128'], ['P', 'aaaa'],
      ['a', '34128:aaaa:index.html'], ['k', '34128'], ['p', 'aaaa'],
    ]));
  check('addressable reaction: a/k/p', () =>
    assert.deepEqual(s.draftReaction(nsite, null), { kind: 7, content: '+', tags: [['a', '34128:aaaa:index.html'], ['k', '34128'], ['p', 'aaaa']] }));

  const reg = s.resolveScope({ id: 'ffff', pubkey: 'bbbb', kind: 1 });
  check('regular comment: E/K/P root + e/k/p parent', () =>
    assert.deepEqual(s.draftComment(reg, null, 'hi').tags, [
      ['E', 'ffff', '', 'bbbb'], ['K', '1'], ['P', 'bbbb'],
      ['e', 'ffff', '', 'bbbb'], ['k', '1'], ['p', 'bbbb'],
    ]));
  check('custom reaction content (emoji / downvote) is preserved', () =>
    assert.equal(s.draftReaction(reg, null, '🤙').content, '🤙'));
}

// ===========================================================================
// Binning incoming web events by their i tag
// ===========================================================================
console.log('\nEvent binning');
{
  const web = s.resolveScope('https://app.example.com/u/vitor?tab=posts');
  check('most specific bucket wins', () => {
    assert.equal(s.webBucketOf({ tags: [['i', 'https://app.example.com/u/vitor?tab=posts']] }, web), 'page');
    assert.equal(s.webBucketOf({ tags: [['i', 'https://app.example.com/u/vitor']] }, web), 'section');
    assert.equal(s.webBucketOf({ tags: [['i', 'https://app.example.com/']] }, web), 'site');
  });
  check('an unrelated or tagless event bins to null', () => {
    assert.equal(s.webBucketOf({ tags: [['i', 'https://other.com/']] }, web), null);
    assert.equal(s.webBucketOf({ tags: [] }, web), null);
  });
}

console.log(failed ? `\n${failed} social check(s) FAILED\n` : '\nAll social checks passed.\n');
process.exit(failed ? 1 : 0);
