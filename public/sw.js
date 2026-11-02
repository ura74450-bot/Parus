// Service worker: показывает уведомления и открывает нужный чат по клику
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const d = e.notification.data || {};
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    const c = list[0];
    if (c) { c.focus(); c.postMessage({ type: 'open', key: d.key }); return; }
    return self.clients.openWindow('/');
  }));
});
