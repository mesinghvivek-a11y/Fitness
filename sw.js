const CACHE_NAME = 'timely-fit-shell-v4-brand-autosync-workout-history';
const SUPABASE_SDK_URL = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';
const SHELL = ['./', './index.html', './styles.css', './app.js', './manifest.json', './icon.svg', './foods.json', './exercises.json', './supabase-config.js', './viewport-lock.js'];
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(SHELL);
    // Cache the Auth SDK for returning, previously signed-in users to reopen the PWA offline.
    // Failure to reach the CDN must not prevent installation of the local app shell.
    try {
      const response = await fetch(SUPABASE_SDK_URL, { mode: 'cors', cache: 'reload' });
      if (response.ok) await cache.put(SUPABASE_SDK_URL, response);
    } catch (_) {}
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const requestURL = new URL(event.request.url);
  if (event.request.url === SUPABASE_SDK_URL) {
    event.respondWith(caches.match(SUPABASE_SDK_URL).then(cached => cached || fetch(event.request).then(response => {
      if (response.ok) caches.open(CACHE_NAME).then(cache => cache.put(SUPABASE_SDK_URL, response.clone())).catch(() => {});
      return response;
    })));
    return;
  }
  if (requestURL.origin !== self.location.origin) return;
  // The public config must refresh on deploy; otherwise the old empty placeholder could remain cached.
  if (requestURL.pathname.endsWith('/supabase-config.js')) {
    event.respondWith(fetch(event.request).then(response => {
      if (response.ok) caches.open(CACHE_NAME).then(cache => cache.put(event.request, response.clone())).catch(() => {});
      return response;
    }).catch(() => caches.match(event.request)));
    return;
  }
  event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request).then(response => {
    if (response.ok) {
      const copy = response.clone();
      caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy)).catch(() => {});
    }
    return response;
  }).catch(() => caches.match('./index.html'))));
});
