import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { HttpError } from './context';

// Stored files are AES-256-GCM encrypted with a key held outside the database (PRESHIFT_DOCUMENT_KEY),
// so a copy of the database alone never yields a passport scan. Layout of a stored file:
//   "PSD1" | key id (4 bytes) | IV (12) | auth tag (16) | ciphertext
// The organisation and file id are bound in as associated data, so a file cannot be moved to
// another record or organisation and still decrypt.

const MAGIC = Buffer.from('PSD1');
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.length + 4 + IV_BYTES + TAG_BYTES;

export class DocumentCipher {
  private readonly keyId: Buffer;

  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error('A document key must be 32 bytes');
    // Identifies the key without revealing it, so a file sealed with another key fails clearly.
    this.keyId = createHash('sha256').update(key).digest().subarray(0, 4);
  }

  /** The key's public fingerprint, for the health check and the access log. */
  get fingerprint() {
    return this.keyId.toString('hex');
  }

  seal(orgId: string, id: string, data: Buffer): Buffer {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(aad(orgId, id));
    const body = Buffer.concat([cipher.update(data), cipher.final()]);
    return Buffer.concat([MAGIC, this.keyId, iv, cipher.getAuthTag(), body]);
  }

  open(orgId: string, id: string, sealed: Buffer): Buffer {
    if (sealed.length < HEADER_BYTES || !sealed.subarray(0, 4).equals(MAGIC)) {
      throw new HttpError(500, 'document_unreadable', 'This file is not in the encrypted format and cannot be shown.');
    }
    if (!sealed.subarray(4, 8).equals(this.keyId)) {
      throw new HttpError(500, 'document_key_mismatch', 'This file was encrypted with a different document key.');
    }
    const iv = sealed.subarray(8, 8 + IV_BYTES);
    const tag = sealed.subarray(8 + IV_BYTES, HEADER_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAAD(aad(orgId, id));
    decipher.setAuthTag(tag);
    try {
      return Buffer.concat([decipher.update(sealed.subarray(HEADER_BYTES)), decipher.final()]);
    } catch {
      throw new HttpError(500, 'document_tampered', 'This file failed its integrity check and will not be shown.');
    }
  }
}

const aad = (orgId: string, id: string) => Buffer.from(`${orgId}/${id}`);

export type DocumentKeyStatus = 'encrypted' | 'no key' | 'invalid key';

/**
 * The cipher from PRESHIFT_DOCUMENT_KEY (32 random bytes, base64: `openssl rand -base64 32`).
 * Without one, an in-memory demo gets a throwaway key, as its files vanish on restart anyway;
 * a database never does, and uploads and views are refused until the key is set.
 */
export function documentCipherFromEnv(env: NodeJS.ProcessEnv, persistent: boolean): { cipher: DocumentCipher | null; status: DocumentKeyStatus } {
  const raw = env.PRESHIFT_DOCUMENT_KEY;
  if (!raw) return persistent ? { cipher: null, status: 'no key' } : { cipher: new DocumentCipher(randomBytes(32)), status: 'encrypted' };
  const key = Buffer.from(raw.trim(), 'base64');
  if (key.length !== 32) return { cipher: null, status: 'invalid key' };
  return { cipher: new DocumentCipher(key), status: 'encrypted' };
}
