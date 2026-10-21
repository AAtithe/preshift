// Sealing for secrets the server must read back, such as authenticator secrets: AES-256-GCM
// under PRESHIFT_SECRET_KEY (64 hex characters). A hash would not do: checking a code needs
// the secret itself.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const PREFIX = 'v1';

/**
 * The sealing key, or null when none is configured in production, in which case nothing
 * secret is stored. Outside production a fixed development key keeps the demo working.
 */
export function sealingKey(env: Record<string, string | undefined> = process.env): Buffer | null {
  const hex = env.PRESHIFT_SECRET_KEY;
  if (hex && /^[0-9a-fA-F]{64}$/.test(hex)) return Buffer.from(hex, 'hex');
  if (env.NODE_ENV === 'production' || env.VERCEL === '1') return null;
  return createHash('sha256').update('preshift development sealing key, never for real data').digest();
}

export function seal(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [PREFIX, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
}

/** The plain text, or null if the value was not sealed with this key or has been altered. */
export function unseal(sealed: string, key: Buffer): string | null {
  const [prefix, iv, tag, body] = sealed.split('.');
  if (prefix !== PREFIX || !iv || !tag || !body) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
