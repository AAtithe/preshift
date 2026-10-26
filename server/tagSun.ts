import { createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto';

// Secure NFC tags (NXP NTAG 424 DNA) with Secure Unique NFC messages, as NXP's AN12196 describes.
// On every read the tag writes a fresh address: its serial number and a read counter, encrypted
// under one key, and a MAC over them under another. Only someone holding the keys can make an
// address the tag would have made, and the counter only goes up, so an address copied from a
// phone is worth nothing once the next read has been seen.

const ZERO = Buffer.alloc(16);
const RB = 0x87;

function aesEcb(key: Buffer, block: Buffer): Buffer {
  const c = createCipheriv('aes-128-ecb', key, null);
  c.setAutoPadding(false);
  return Buffer.concat([c.update(block), c.final()]);
}

function shiftLeft(b: Buffer): Buffer {
  const out = Buffer.alloc(b.length);
  for (let i = 0; i < b.length; i++) out[i] = ((b[i] << 1) | (i + 1 < b.length ? b[i + 1] >> 7 : 0)) & 0xff;
  return out;
}

function subkey(b: Buffer): Buffer {
  const k = shiftLeft(b);
  if (b[0] & 0x80) k[15] ^= RB;
  return k;
}

/** AES-CMAC (RFC 4493). */
export function aesCmac(key: Buffer, message: Buffer): Buffer {
  const k1 = subkey(aesEcb(key, ZERO));
  const k2 = subkey(k1);
  const blocks = Math.max(1, Math.ceil(message.length / 16));
  const complete = message.length > 0 && message.length % 16 === 0;
  const last = Buffer.alloc(16);
  message.copy(last, 0, (blocks - 1) * 16);
  if (!complete) last[message.length - (blocks - 1) * 16] = 0x80;
  const sub = complete ? k1 : k2;
  for (let i = 0; i < 16; i++) last[i] ^= sub[i];
  let x: Buffer = ZERO;
  for (let n = 0; n < blocks - 1; n++) {
    const y = Buffer.alloc(16);
    for (let i = 0; i < 16; i++) y[i] = x[i] ^ message[n * 16 + i];
    x = aesEcb(key, y);
  }
  const y = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) y[i] = x[i] ^ last[i];
  return aesEcb(key, y);
}

/** The tag's MAC: the CMAC under a session key worked from the serial and counter, every other byte kept. */
export function sunMac(fileKey: Buffer, uid: Buffer, counter: number): Buffer {
  const ctr = Buffer.from([counter & 0xff, (counter >> 8) & 0xff, (counter >> 16) & 0xff]);
  const sv2 = Buffer.concat([Buffer.from('3cc300010080', 'hex'), uid, ctr]);
  const full = aesCmac(aesCmac(fileKey, sv2), Buffer.alloc(0));
  return Buffer.from([1, 3, 5, 7, 9, 11, 13, 15].map((i) => full[i]));
}

/** Encrypted PICC data as a tag writes it, for testing and for checking a tag once programmed. */
export function sunPicc(metaKey: Buffer, uid: Buffer, counter: number): Buffer {
  const plain = Buffer.alloc(16);
  plain[0] = 0xc7;
  uid.copy(plain, 1);
  plain.writeUIntLE(counter, 8, 3);
  const c = createCipheriv('aes-128-cbc', metaKey, ZERO);
  c.setAutoPadding(false);
  return Buffer.concat([c.update(plain), c.final()]);
}

const HEX16 = /^[0-9a-f]{32}$/i;
const HEX8 = /^[0-9a-f]{16}$/i;

/**
 * Reads one address a tag wrote. Returns the tag's serial and read counter, or null when the
 * address was not made with these keys: a forged, mistyped or tampered link.
 */
export function readSun(metaKey: Buffer, fileKey: Buffer, piccHex: string, cmacHex: string): { uid: string; counter: number } | null {
  if (!HEX16.test(piccHex) || !HEX8.test(cmacHex)) return null;
  const d = createDecipheriv('aes-128-cbc', metaKey, ZERO);
  d.setAutoPadding(false);
  const plain = Buffer.concat([d.update(Buffer.from(piccHex, 'hex')), d.final()]);
  // 0xC7: the serial (7 bytes) and the counter (3) are both mirrored, as Preshift asks tags to be set up.
  if (plain[0] !== 0xc7) return null;
  const uid = plain.subarray(1, 8);
  const counter = plain.readUIntLE(8, 3);
  if (!timingSafeEqual(sunMac(fileKey, uid, counter), Buffer.from(cmacHex, 'hex'))) return null;
  return { uid: uid.toString('hex').toUpperCase(), counter };
}
