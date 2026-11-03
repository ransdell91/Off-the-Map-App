// This app moved into the R&A app. Clear the old offline copy and step aside so the redirect page loads.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys(); await Promise.all(keys.map((k) => caches.delete(k)));
    await self.registration.unregister();
    const all = await self.clients.matchAll({ type: 'window' }); all.forEach((c) => c.navigate(c.url));
  })());
});
