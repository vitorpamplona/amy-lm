// nip19.js — NIP-19 bech32-encoded entities: encode & decode.
//
// A self-contained codec with no dependency on the relay pool — split out of
// nostr.js so the networking code stays focused on the wire protocol. nostr.js
// re-exports `nip19` from here, so importers don't change.
//
// Covers the full NIP-19 surface:
//   bare (32-byte payload):  npub, nsec, note
//   TLV (shareable):         nprofile, nevent, naddr, nrelay
//
// Everything is hex in / hex out (matching the rest of the codebase), with the
// TLV pointer types decoding to plain objects:
//   nprofile -> { pubkey, relays }
//   nevent   -> { id, relays, author, kind }
//   naddr    -> { identifier, pubkey, kind, relays }
//   nrelay   -> url (string)

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

function polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= GEN[i];
  }
  return chk;
}
function hrpExpand(hrp) {
  const out = [];
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
  return out;
}
function convertBits(data, from, to, pad) {
  let acc = 0, bits = 0;
  const out = [];
  const maxv = (1 << to) - 1;
  for (const value of data) {
    if (value < 0 || value >> from !== 0) throw new Error('invalid data range in bech32 payload');
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) { bits -= to; out.push((acc >> bits) & maxv); }
  }
  if (pad) {
    if (bits > 0) out.push((acc << (to - bits)) & maxv);
  } else if (bits >= from || ((acc << (to - bits)) & maxv)) {
    throw new Error('invalid padding in bech32 payload');
  }
  return out;
}
function checksum(hrp, data) {
  const values = hrpExpand(hrp).concat(data).concat([0, 0, 0, 0, 0, 0]);
  const mod = polymod(values) ^ 1;
  const out = [];
  for (let i = 0; i < 6; i++) out.push((mod >> (5 * (5 - i))) & 31);
  return out;
}
function bech32Encode(hrp, data) {
  const combined = data.concat(checksum(hrp, data));
  let s = hrp + '1';
  for (const d of combined) s += CHARSET[d];
  return s;
}
function bech32Decode(str) {
  const lower = str.toLowerCase();
  if (lower !== str && str.toUpperCase() !== str) throw new Error('mixed-case bech32 string');
  const pos = lower.lastIndexOf('1');
  if (pos < 1 || pos + 7 > lower.length) throw new Error('not a valid bech32 string');
  const hrp = lower.slice(0, pos);
  const data = [];
  for (const ch of lower.slice(pos + 1)) {
    const v = CHARSET.indexOf(ch);
    if (v === -1) throw new Error(`invalid bech32 character "${ch}"`);
    data.push(v);
  }
  if (polymod(hrpExpand(hrp).concat(data)) !== 1) throw new Error('invalid bech32 checksum');
  return { hrp, data: data.slice(0, -6) };
}

function bytesToHex(bytes) { return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(''); }
function hexToBytes(hex) {
  if (typeof hex !== 'string' || hex.length % 2 !== 0) throw new Error('invalid hex string');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
function concatBytes(arrays) {
  let len = 0;
  for (const a of arrays) len += a.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}
function utf8Encode(str) { return new TextEncoder().encode(str); }
function utf8Decode(bytes) { return new TextDecoder().decode(bytes); }
function integerToUint8Array(n) {
  const a = new Uint8Array(4);
  a[0] = (n >> 24) & 0xff;
  a[1] = (n >> 16) & 0xff;
  a[2] = (n >> 8) & 0xff;
  a[3] = n & 0xff;
  return a;
}

// --- bech32 <-> bytes helpers (8-bit payload) ------------------------------
function encodeBytes(hrp, bytes) { return bech32Encode(hrp, convertBits(bytes, 8, 5, true)); }
function decodeToBytes(str) {
  const { hrp, data } = bech32Decode(str);
  return { hrp, bytes: Uint8Array.from(convertBits(data, 5, 8, false)) };
}

// --- TLV (Type-Length-Value) for the shareable identifiers -----------------
// tlv: { [type:number]: Uint8Array[] } — each type maps to one or more values.
function encodeTLV(tlv) {
  const entries = [];
  for (const [t, values] of Object.entries(tlv)) {
    for (const value of values) {
      if (value.length > 255) throw new Error('TLV value too long (max 255 bytes)');
      const entry = new Uint8Array(value.length + 2);
      entry[0] = Number(t);
      entry[1] = value.length;
      entry.set(value, 2);
      entries.push(entry);
    }
  }
  return concatBytes(entries);
}
function parseTLV(data) {
  const result = {};
  let rest = data;
  while (rest.length > 0) {
    const t = rest[0];
    const l = rest[1];
    const v = rest.slice(2, 2 + l);
    if (v.length < l) throw new Error('malformed TLV: not enough data');
    rest = rest.slice(2 + l);
    (result[t] ||= []).push(v);
  }
  return result;
}

function require32(bytes, label) {
  if (!bytes || bytes.length !== 32) throw new Error(`${label} must be 32 bytes`);
  return bytesToHex(bytes);
}

export const nip19 = {
  // --- bare encoders (32-byte hex payload) ---------------------------------
  npubEncode(hex) { return encodeBytes('npub', hexToBytes(hex)); },
  nsecEncode(hex) { return encodeBytes('nsec', hexToBytes(hex)); },
  noteEncode(hex) { return encodeBytes('note', hexToBytes(hex)); },

  // --- TLV encoders --------------------------------------------------------
  // { pubkey (hex), relays?: string[] } -> nprofile
  nprofileEncode({ pubkey, relays = [] }) {
    return encodeBytes('nprofile', encodeTLV({
      0: [hexToBytes(pubkey)],
      1: relays.map(utf8Encode),
    }));
  },
  // { id (hex), relays?: string[], author?: hex, kind?: number } -> nevent
  neventEncode({ id, relays = [], author, kind }) {
    const tlv = { 0: [hexToBytes(id)], 1: relays.map(utf8Encode) };
    if (author) tlv[2] = [hexToBytes(author)];
    if (kind !== undefined && kind !== null) tlv[3] = [integerToUint8Array(kind)];
    return encodeBytes('nevent', encodeTLV(tlv));
  },
  // { identifier (d-tag), pubkey (hex), kind (number), relays?: string[] } -> naddr
  naddrEncode({ identifier, pubkey, kind, relays = [] }) {
    return encodeBytes('naddr', encodeTLV({
      0: [utf8Encode(identifier)],
      1: relays.map(utf8Encode),
      2: [hexToBytes(pubkey)],
      3: [integerToUint8Array(kind)],
    }));
  },
  // relay url -> nrelay (deprecated by NIP-19 but kept for completeness)
  nrelayEncode(url) {
    return encodeBytes('nrelay', encodeTLV({ 1: [utf8Encode(url)] }));
  },

  // --- decoder -------------------------------------------------------------
  // Returns { type, data } where data is a hex string for bare types and a
  // pointer object for the TLV types. Accepts an optional "nostr:" URI prefix.
  decode(input) {
    let str = (input || '').trim();
    if (str.toLowerCase().startsWith('nostr:')) str = str.slice(6);
    const { hrp, bytes } = decodeToBytes(str);
    switch (hrp) {
      case 'npub':
      case 'nsec':
      case 'note':
        return { type: hrp, data: require32(bytes, hrp) };
      case 'nprofile': {
        const tlv = parseTLV(bytes);
        return { type: hrp, data: {
          pubkey: require32(tlv[0]?.[0], 'nprofile pubkey'),
          relays: (tlv[1] || []).map(utf8Decode),
        } };
      }
      case 'nevent': {
        const tlv = parseTLV(bytes);
        const data = {
          id: require32(tlv[0]?.[0], 'nevent id'),
          relays: (tlv[1] || []).map(utf8Decode),
          author: tlv[2]?.[0] ? require32(tlv[2][0], 'nevent author') : undefined,
          kind: tlv[3]?.[0] ? parseKind(tlv[3][0]) : undefined,
        };
        return { type: hrp, data };
      }
      case 'naddr': {
        const tlv = parseTLV(bytes);
        if (!tlv[0]?.[0]) throw new Error('naddr is missing the identifier');
        if (!tlv[3]?.[0]) throw new Error('naddr is missing the kind');
        return { type: hrp, data: {
          identifier: utf8Decode(tlv[0][0]),
          pubkey: require32(tlv[2]?.[0], 'naddr author'),
          kind: parseKind(tlv[3][0]),
          relays: (tlv[1] || []).map(utf8Decode),
        } };
      }
      case 'nrelay': {
        const tlv = parseTLV(bytes);
        if (!tlv[1]?.[0]) throw new Error('nrelay is missing the relay url');
        return { type: hrp, data: utf8Decode(tlv[1][0]) };
      }
      default:
        throw new Error(`unknown NIP-19 prefix "${hrp}"`);
    }
  },

  // Accepts npub / nprofile / nostr: URI / bare hex; always returns a hex pubkey.
  toHexPubkey(input) {
    const s = (input || '').trim();
    const bare = s.toLowerCase().startsWith('nostr:') ? s.slice(6) : s;
    if (bare.startsWith('npub')) return this.decode(bare).data;
    if (bare.startsWith('nprofile')) return this.decode(bare).data.pubkey;
    return s;
  },
};

function parseKind(bytes) {
  if (bytes.length !== 4) throw new Error('kind must be a 32-bit integer');
  return ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
}
