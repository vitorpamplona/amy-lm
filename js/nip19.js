// nip19.js — NIP-19 bech32 (npub / nsec / note) encode & decode.
//
// A self-contained codec with no dependency on the relay pool — split out of
// nostr.js so the networking code stays focused on the wire protocol. nostr.js
// re-exports `nip19` from here, so importers don't change.

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
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) { bits -= to; out.push((acc >> bits) & maxv); }
  }
  if (pad && bits > 0) out.push((acc << (to - bits)) & maxv);
  return out;
}
function bech32Encode(hrp, data) {
  const combined = data.concat(checksum(hrp, data));
  let s = hrp + '1';
  for (const d of combined) s += CHARSET[d];
  return s;
}
function checksum(hrp, data) {
  const values = hrpExpand(hrp).concat(data).concat([0, 0, 0, 0, 0, 0]);
  const mod = polymod(values) ^ 1;
  const out = [];
  for (let i = 0; i < 6; i++) out.push((mod >> (5 * (5 - i))) & 31);
  return out;
}
function bech32Decode(str) {
  const lower = str.toLowerCase();
  const pos = lower.lastIndexOf('1');
  const hrp = lower.slice(0, pos);
  const data = [];
  for (const ch of lower.slice(pos + 1)) data.push(CHARSET.indexOf(ch));
  return { hrp, data: data.slice(0, -6) };
}
function bytesToHex(bytes) { return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(''); }
function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

export const nip19 = {
  // hex -> npub
  npubEncode(hex) { return bech32Encode('npub', convertBits(hexToBytes(hex), 8, 5, true)); },
  noteEncode(hex) { return bech32Encode('note', convertBits(hexToBytes(hex), 8, 5, true)); },
  // npub/note/nsec -> { type, data (hex) }
  decode(str) {
    const { hrp, data } = bech32Decode(str.trim());
    const bytes = convertBits(data, 5, 8, false);
    return { type: hrp, data: bytesToHex(bytes) };
  },
  // Accepts npub or hex; always returns hex pubkey
  toHexPubkey(input) {
    const s = (input || '').trim();
    if (s.startsWith('npub')) return this.decode(s).data;
    return s;
  },
};
