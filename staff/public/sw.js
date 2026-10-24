// The staff app's service worker: shows pushes from Preshift and opens the app when one is tapped.
// It caches nothing, so the app is always what the server last built.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let message = {};
  try {
    message = event.data ? event.data.json() : {};
  } catch {
    message = { body: event.data ? event.data.text() : '' };
  }
  const base = self.registration.scope;
  event.waitUntil(
    self.registration.showNotification(message.title || 'Preshift', {
      body: message.body || '',
      // One tag per kind: a newer rota change replaces the older one rather than stacking.
      tag: message.tag || undefined,
      renotify: Boolean(message.tag),
      icon: new URL('icon-192.png', base).href,
      badge: new URL('badge-96.png', base).href,
      data: { url: message.url || '/staff/' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || '/staff/', self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const open = windows.find((w) => new URL(w.url).pathname.startsWith('/staff'));
      if (open) {
        await open.focus();
        open.postMessage({ type: 'open', url });
        return;
      }
      await self.clients.openWindow(url);
    })(),
  );
});
