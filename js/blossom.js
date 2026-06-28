// blossom.js — the minimal Blossom client the nsite exporter uses to store a
// site's files. NIP-5A keeps the *manifest* on relays but the actual bytes live
// on Blossom servers, addressed by SHA-256. So exporting a site means: hash each
// file, upload the blobs, then publish a manifest that points at those hashes.
//
// We implement just enough of the Blossom spec for that: BUD-02 uploads
// (`PUT /upload`) authorized by a BUD-01 `kind:24242` event, and reading a
// user's own server list (NIP "media servers", kind 10063).

import { signer, query } from './nostr.js';

// Public Blossom servers used when the user has no kind 10063 list of their own.
// The exporter still lets them edit the list before uploading.
export const DEFAULT_BLOSSOM_SERVERS = [
  'https://blossom.primal.net',
  'https://nostr.download',
  'https://blossom.band',
];

/** SHA-256 of a byte buffer, lowercase hex — the address of a Blossom blob. */
export async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// UTF-8-safe base64 for the Authorization header (btoa alone mangles non-ASCII).
function toBase64(str) {
  let bin = '';
  for (const b of new TextEncoder().encode(str)) bin += String.fromCharCode(b);
  return btoa(bin);
}

/**
 * Sign ONE BUD-01 upload-authorization event covering every blob in the export.
 * Listing all hashes as `x` tags lets us reuse the same signed token for every
 * PUT, so the user's signer prompts once instead of once per file.
 * @param {string[]} hashes - sha256 hex of every blob to be uploaded
 * @returns {Promise<object>} the signed kind:24242 event
 */
export async function createUploadAuth(hashes, message = 'Upload Amy nsite') {
  const now = Math.floor(Date.now() / 1000);
  return signer.signEvent({
    kind: 24242,
    content: message,
    created_at: now,
    tags: [
      ['t', 'upload'],
      ['expiration', String(now + 3600)],
      ...hashes.map((h) => ['x', h]),
    ],
  });
}

/** Build the `Authorization` header value from a signed auth event. */
export function authHeader(authEvent) {
  return 'Nostr ' + toBase64(JSON.stringify(authEvent));
}

/**
 * PUT a single blob to one server. Resolves with the normalized server base on
 * success; throws with the server's reason on failure so the caller can decide
 * whether another server still covers this blob.
 */
export async function putBlob(server, bytes, type, header) {
  const base = server.replace(/\/+$/, '');
  const res = await fetch(base + '/upload', {
    method: 'PUT',
    headers: { Authorization: header, 'Content-Type': type || 'application/octet-stream' },
    body: bytes,
  });
  if (!res.ok) {
    const reason = res.headers.get('X-Reason') || (await res.text().catch(() => '')) || res.statusText;
    throw new Error(`${res.status} ${String(reason).slice(0, 160)}`);
  }
  return base;
}

/**
 * Read a user's Blossom server list (kind 10063) — the `server` tags name where
 * they keep their media. Returns [] if they have none.
 * @returns {Promise<string[]>}
 */
export async function userBlossomServers(pubkey, seedRelays, opts = {}) {
  try {
    const evs = await query(seedRelays, { kinds: [10063], authors: [pubkey], limit: 1 }, { timeout: opts.timeout ?? 4000 });
    const urls = [];
    const seen = new Set();
    for (const t of evs[0]?.tags || []) {
      if (t[0] === 'server' && t[1] && !seen.has(t[1])) { seen.add(t[1]); urls.push(t[1]); }
    }
    return urls;
  } catch {
    return [];
  }
}
