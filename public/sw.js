// Daily Board service worker — it only shows app notifications (Web Push).
// It deliberately caches nothing: the board is always live data.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil((async () => {
    await self.registration.showNotification(d.title || 'Daily Board', {
      body: d.body || '', icon: '/icon-192.png', badge: '/icon-192.png',
      tag: d.tag || undefined, renotify: !!d.tag, data: { url: d.url || '/' },
    });
    // A board that's open right now picks up the change straight away.
    for (const c of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) c.postMessage({ type: 'refresh' });
  })());
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) if ('focus' in c) { c.postMessage({ type: 'refresh' }); return c.focus(); }
    return self.clients.openWindow(url);
  }));
});
