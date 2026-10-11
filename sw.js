const CACHE_NAME = 'forma-shell-v2';
const SHELL = ['./', './index.html', './styles.css', './app.js', './manifest.json', './icon.svg', './foods.json', './exercises.json', './supabase-config.js'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const requestURL = new URL(event.request.url);
  if (requestURL.origin !== self.location.origin) return;
  event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request).then(response => {
    const copy = response.clone();
    caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy)).catch(() => {});
    return response;
  }).catch(() => caches.match('./index.html'))));
});
