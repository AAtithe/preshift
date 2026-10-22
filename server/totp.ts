// Time-based one-time passwords (RFC 6238 over RFC 4226): SHA-1, 30 second steps, 6 digits.
// That is what every authenticator app produces, so nobody needs a particular one.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const STEP_SECONDS = 30;
export const DIGITS = 6;
/** Codes either side of now are accepted, for a phone clock a little out. */
const DRIFT = 1;

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s=-]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error('Not base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new secret: 160 bits, the size RFC 4226 recommends for SHA-1. */
export function newSecret(): string {
  return base32Encode(randomBytes(20));
}

export const stepAt = (ms: number) => Math.floor(ms / 1000 / STEP_SECONDS);

/** The code for one time step. */
export function codeAt(secret: string, step: number, digits = DIGITS): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const n = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return String(n).padStart(digits, '0');
}

/**
 * The step a code belongs to, or null. A step at or before `lastStep` is refused, so a code
 * that has been used, or read over someone's shoulder after use, never works twice.
 */
export function verifyCode(secret: string, code: string, now: number, lastStep = -1): number | null {
  const given = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(given)) return null;
  const here = stepAt(now);
  for (let step = here - DRIFT; step <= here + DRIFT; step++) {
    if (step <= lastStep) continue;
    if (timingSafeEqual(Buffer.from(codeAt(secret, step)), Buffer.from(given))) return step;
  }
  return null;
}

/** The address an authenticator app reads from the QR code. */
export function otpauthUrl(secret: string, account: string, issuer = 'Preshift'): string {
  // A literal colon between issuer and account: the form every authenticator app reads.
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: String(DIGITS), period: String(STEP_SECONDS) });
  return `otpauth://totp/${label}?${params}`;
}

/** Ten single-use recovery codes, in groups people can read out: xxxx-xxxx. */
export function newRecoveryCodes(n = 10): string[] {
  const letters = 'abcdefghjkmnpqrstuvwxyz23456789';
  return Array.from({ length: n }, () => {
    const raw = randomBytes(8);
    const chars = [...raw].map((b) => letters[b % letters.length]).join('');
    return `${chars.slice(0, 4)}-${chars.slice(4, 8)}`;
  });
}

export const normaliseRecovery = (code: string) => code.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
