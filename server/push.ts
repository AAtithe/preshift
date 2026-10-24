// Web Push to the staff app on people's phones, with no third-party library: the message is
// encrypted for the one phone that subscribed (RFC 8291, aes128gcm), and each request carries a
// VAPID token signed with this server's own key (RFC 8292), so the push service knows who sent it.
// The push service (Apple, Google, Mozilla, Microsoft) only ever sees ciphertext.

import { createCipheriv, createECDH, createHmac, createPrivateKey, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import type { Store } from './store';

/** One phone (or browser) a person turned notifications on for. */
export interface PushDevice {
  endpoint: string;
  /** The phone's public key (P-256, uncompressed, base64url) and its auth secret (base64url). */
  p256dh: string;
  auth: string;
  addedAt: string;
  /** What the phone said it was, for the person and their manager: "iPhone", "Android". */
  label?: string;
}

/** A person may have it on a few phones and browsers; beyond that the oldest goes. */
export const MAX_PUSH_DEVICES = 5;
/** How long a push service keeps trying a phone that is off. A rota change is old news after a day. */
const TTL_SECONDS = 24 * 60 * 60;
const VAPID_SETTING = 'push:vapid';

/**
 * The only hosts a push may go to. The endpoint comes from a phone, so without this list the server
 * could be pointed at any address, inside its own network included.
 */
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)notify\.windows\.com$/];

export function validEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return url.protocol === 'https:' && !url.port && PUSH_HOSTS.some((h) => h.test(url.hostname));
  } catch {
    return false;
  }
}

const b64url = (b: Buffer) => b.toString('base64url');
const fromB64url = (s: string) => Buffer.from(s, 'base64url');

export interface VapidKeys {
  /** Uncompressed P-256 public key, base64url: what the phone subscribes with. */
  publicKey: string;
  privateKey: KeyObject;
}

/** This deployment's VAPID key pair, made once and kept in the store, so nothing needs setting up. */
export async function vapidKeys(store: Store): Promise<VapidKeys> {
  const stored = await store.settingOnce(VAPID_SETTING, () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    return JSON.stringify(privateKey.export({ format: 'jwk' }));
  });
  const jwk = JSON.parse(stored) as { x: string; y: string; d: string; kty: string; crv: string };
  const privateKey = createPrivateKey({ key: jwk, format: 'jwk' });
  const publicKey = b64url(Buffer.concat([Buffer.from([4]), fromB64url(jwk.x), fromB64url(jwk.y)]));
  return { publicKey, privateKey };
}

/** The VAPID token for one push service: who we are, for that service, for twelve hours. */
export function vapidAuthorisation(keys: VapidKeys, endpoint: string, subject: string, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const header = b64url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64url(Buffer.from(JSON.stringify({ aud: new URL(endpoint).origin, exp: nowSeconds + 12 * 60 * 60, sub: subject })));
  const signature = sign('sha256', Buffer.from(`${header}.${claims}`), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${claims}.${b64url(signature)}, k=${keys.publicKey}`;
}

const hmac = (key: Buffer, data: Buffer) => createHmac('sha256', key).update(data).digest();

/** Encrypts one message for one phone, as RFC 8291 sets out: the body of the push request. */
export function encryptPayload(device: Pick<PushDevice, 'p256dh' | 'auth'>, payload: Buffer, salt = randomBytes(16), senderPrivate?: Buffer): Buffer {
  const uaPublic = fromB64url(device.p256dh);
  const authSecret = fromB64url(device.auth);
  // A fresh key pair for every message; a fixed one only to check against the standard's worked example.
  const ecdh = createECDH('prime256v1');
  if (senderPrivate) ecdh.setPrivateKey(senderPrivate);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  // HKDF with a single block each time, which is all the lengths here need.
  const prkKey = hmac(authSecret, shared);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  // One record: the message, then the delimiter that says it is the last.
  const body = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

/** What the phone shows. Names and times only, as in the email: a lock screen is read by anyone nearby. */
export interface PushMessage {
  title: string;
  body: string;
  /** Where tapping it opens, within the staff app. */
  url: string;
  /** Same tag replaces the earlier one on the phone rather than stacking. */
  tag?: string;
}

export type PushResult = 'sent' | 'gone' | 'failed';

/**
 * Sends one message to one phone. `gone` means the phone has unsubscribed or the subscription
 * expired, and it should be forgotten; `failed` is anything else, kept for next time.
 */
export async function sendPush(keys: VapidKeys, device: PushDevice, message: PushMessage, subject: string, fetcher: typeof fetch = fetch): Promise<PushResult> {
  if (!validEndpoint(device.endpoint)) return 'gone';
  try {
    const res = await fetcher(device.endpoint, {
      method: 'POST',
      headers: {
        authorization: vapidAuthorisation(keys, device.endpoint, subject),
        'content-encoding': 'aes128gcm',
        'content-type': 'application/octet-stream',
        ttl: String(TTL_SECONDS),
        urgency: 'normal',
        ...(message.tag ? { topic: message.tag.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) } : {}),
      },
      body: encryptPayload(device, Buffer.from(JSON.stringify(message))),
      signal: AbortSignal.timeout(5000),
    });
    if (res.status === 404 || res.status === 410) return 'gone';
    return res.ok ? 'sent' : 'failed';
  } catch {
    return 'failed';
  }
}

/** Who the push services may contact about this server's pushes, as VAPID asks. */
export const pushSubject = (env: NodeJS.ProcessEnv = process.env) => env.PRESHIFT_PUSH_CONTACT || 'mailto:support@preshift.co.uk';
