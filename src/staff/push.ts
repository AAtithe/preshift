// Phone notifications for the staff app: the service worker, the browser's push subscription, and
// telling the server about it. Every step can be refused by the phone, so each says why it stopped.

/** Built, the worker sits beside the app at /staff/sw.js and covers all of /staff/. In development it is served from staff/public. */
const env = (import.meta as unknown as { env: Record<string, string | boolean | undefined> }).env;
const WORKER = env.DEV ? '/staff/public/sw.js' : '/staff/sw.js';
const SCOPE = env.DEV ? '/staff/public/' : '/staff/';

export type PushState =
  | { kind: 'unsupported' }
  /** iPhones allow notifications only for apps added to the home screen. */
  | { kind: 'install-first' }
  | { kind: 'blocked' }
  | { kind: 'off' }
  | { kind: 'on'; endpoint: string };

const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isInstalled = () => window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
const supported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

/** Registers the worker when the app opens, so a tapped notification has something to open it with. */
export function registerWorker() {
  if ('serviceWorker' in navigator) void navigator.serviceWorker.register(WORKER, { scope: SCOPE }).catch(() => undefined);
}

/** The worker's registration once it is active, which subscribing needs. Not serviceWorker.ready: that waits for one covering this page. */
async function registration() {
  const reg = await navigator.serviceWorker.register(WORKER, { scope: SCOPE });
  const worker = reg.installing ?? reg.waiting;
  if (worker && !reg.active) {
    await new Promise<void>((resolve) => worker.addEventListener('statechange', () => worker.state === 'activated' && resolve()));
  }
  return reg;
}

/** Where this phone stands, including whether the server knows its subscription. */
export async function pushState(knownEndpoints: string[]): Promise<PushState> {
  if (!supported()) return isIos() && !isInstalled() ? { kind: 'install-first' } : { kind: 'unsupported' };
  if (Notification.permission === 'denied') return { kind: 'blocked' };
  const reg = await navigator.serviceWorker.getRegistration(SCOPE);
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  return sub && knownEndpoints.includes(sub.endpoint) ? { kind: 'on', endpoint: sub.endpoint } : { kind: 'off' };
}

function keyBytes(base64url: string): Uint8Array {
  const padded = base64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (base64url.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

/** What the person will recognise the phone as in their list: "iPhone, Safari". */
export function deviceLabel(): string {
  const ua = navigator.userAgent;
  const device = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) || isIos() ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : 'Browser';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
  return browser ? `${device}, ${browser}` : device;
}

/** Asks the phone, subscribes, and hands the subscription to the server. Returns why not, or null. */
export async function turnOn(publicKey: string, send: (body: unknown) => Promise<unknown>): Promise<string | null> {
  if (!supported()) return 'This phone or browser cannot show notifications from a web app.';
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return 'Notifications were not allowed. You can allow them for Preshift in your phone settings.';
  const reg = await registration();
  const existing = await reg.pushManager.getSubscription();
  // The phone asks its own notification service (Apple's, Google's) for an address, which can hang on a weak signal.
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 15_000));
  let sub: PushSubscription | null;
  try {
    sub = existing ?? (await Promise.race([reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) as BufferSource }), timeout]));
  } catch {
    return 'Your phone would not set up notifications for Preshift. Try again, or open the staff app in Safari on an iPhone or Chrome on Android.';
  }
  if (!sub) return 'Your phone could not reach its notification service. Check your signal and try again.';
  const json = sub.toJSON() as { endpoint: string; keys?: { p256dh: string; auth: string } };
  await send({ endpoint: json.endpoint, keys: json.keys, label: deviceLabel() });
  return null;
}

/** Stops this phone, on the phone and on the server. Best effort: signing out must not wait on it. */
export async function turnOff(send: (body: unknown) => Promise<unknown>) {
  if (!supported()) return;
  const reg = await navigator.serviceWorker.getRegistration(SCOPE);
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  if (!sub) return;
  await send({ endpoint: sub.endpoint }).catch(() => undefined);
  await sub.unsubscribe().catch(() => undefined);
}
