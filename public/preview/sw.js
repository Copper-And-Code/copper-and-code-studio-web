// Serves the web versions the IDE builds (src/app/web.ts) under preview/<id>/, from the Cache
// Storage where the IDE's page put them: the desktop serves dist/<name>-web on 127.0.0.1 for the
// same reason, JavaScript modules do not load from files. Nothing here reaches the network.
const CACHE = 'lms-web-preview';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const scope = new URL(self.registration.scope);
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;
  const path = url.pathname.endsWith('/') ? `${url.pathname}index.html` : url.pathname;
  event.respondWith(
    caches
      .open(CACHE)
      .then((cache) => cache.match(url.origin + path))
      .then((found) => found ?? new Response('Not found', { status: 404 })),
  );
});
