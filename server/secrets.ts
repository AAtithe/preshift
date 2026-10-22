// Sealing for secrets the server must read back, such as authenticator secrets: AES-256-GCM.
// A hash would not do: checking a code needs the secret itself.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const PREFIX = 'v1';

const SETTING = 'sealing_key';

/** Deployed: on Vercel or in production. The fixed development key is never used there. */
const deployed = (env: Record<string, string | undefined>) => env.NODE_ENV === 'production' || env.VERCEL === '1';

/**
 * The key set in PRESHIFT_SECRET_KEY, else outside a deployment a fixed development key, else
 * null: a deployment without the variable keeps its key in the database (sealingKeyFor).
 */
export function sealingKey(env: Record<string, string | undefined> = process.env): Buffer | null {
  const hex = env.PRESHIFT_SECRET_KEY;
  if (hex && /^[0-9a-fA-F]{64}$/.test(hex)) return Buffer.from(hex, 'hex');
  if (deployed(env)) return null;
  return createHash('sha256').update('preshift development sealing key, never for real data').digest();
}

/**
 * The key for sealing, following the rest of sign-in: nothing has to be set outside the app.
 * PRESHIFT_SECRET_KEY, if set, is stronger, as the key then never sits in the database it
 * protects; otherwise a key is made once and kept in the settings table, apart from the data.
 */
export async function sealingKeyFor(settings: { settingOnce(key: string, make: () => string): Promise<string> }, env: Record<string, string | undefined> = process.env): Promise<Buffer> {
  const fixed = sealingKey(env);
  if (fixed) return fixed;
  return Buffer.from(await settings.settingOnce(SETTING, () => randomBytes(32).toString('hex')), 'hex');
}

/** Where the key comes from, for the screens: never the key. */
export const sealingSource = (env: Record<string, string | undefined> = process.env) =>
  env.PRESHIFT_SECRET_KEY && /^[0-9a-fA-F]{64}$/.test(env.PRESHIFT_SECRET_KEY) ? 'environment' : deployed(env) ? 'database' : 'development';

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
