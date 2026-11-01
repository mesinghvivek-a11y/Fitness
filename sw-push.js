/* sw-push.js — Web Push handlers for the rest timer.
 * Add ONE line near the top of your existing sw.js:   importScripts('./sw-push.js');
 * (or paste this file's contents into sw.js). */

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) { data = { body: event.data && event.data.text() }; }

  const title = data.title || 'Break time has ended!';
  const options = {
    body: data.body || 'Time for your next set.',
    // The existing PWA ships icon.svg; do not reference PNG paths that may 404.
    icon: './icon.svg',
    tag: data.tag || 'rest-timer',        // one rest notification at a time...
    renotify: true,                       // ...but still alert again if it is replaced
    requireInteraction: true,             // honoured on Android/desktop; iOS ignores it
    vibrate: [200, 100, 200, 100, 200],   // Android only; iOS ignores it
    silent: false,                        // never mute: the OS default sound is what wakes the iOS lock screen
    timestamp: data.endsAt || Date.now(),
    data: { url: data.url || '/', restId: data.restId || null },
  };

  // iOS requires every push to show a notification (no silent pushes). Always call showNotification.
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const requested = new URL((event.notification.data && event.notification.data.url) || './', self.registration.scope);
  const target = requested.origin === self.location.origin ? requested.href : self.registration.scope;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const sameApp = wins.find(w => w.url.startsWith(self.registration.scope));
    if (sameApp && 'focus' in sameApp) {
      await sameApp.focus();
      if ('navigate' in sameApp && sameApp.url !== target) await sameApp.navigate(target);
      return;
    }
    await self.clients.openWindow(target);
  })());
});

// The push service rotated the subscription: tell the page so it can re-save it.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(self.clients.matchAll({ includeUncontrolled: true }).then((cs) => cs.forEach((c) => c.postMessage({ type: 'push-resubscribe' }))));
});
