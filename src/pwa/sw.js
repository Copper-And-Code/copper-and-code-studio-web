/* global __LMS_FILES__, __LMS_VERSION__ */
// The IDE's service worker (phase 8). The build (scripts/sw-plugin.mjs) puts the list of every file
// of the deploy, each with its sha256, in place of __LMS_FILES__, and writes this file as sw.js at
// the site's root. Every file goes into a cache of the deploy, so the IDE opens, opens projects and
// runs the simulator without the network. A file whose sha256 did not change since the deploy
// cached before is taken from that cache instead of being downloaded again: Pyodide, the runtime
// and the upstream bundle change only with their pins.
//
// A new deploy installs beside the old one and waits; the page offers to reload (src/pwa/pwa.ts)
// and asks it to take over with the message 'skip-waiting'.

/** @type {Record<string, string>} path under the site → sha256 */
const FILES = __LMS_FILES__;
const VERSION = __LMS_VERSION__;
const PREFIX = 'lms-app-';
const CACHE = PREFIX + VERSION;
const HASH = 'x-lms-sha256';
const SCOPE = new URL(self.registration.scope);
/** Downloads at once while installing. */
const PARALLEL = 6;

const urlOf = (path) => new URL(path, SCOPE).href;

async function sha256(buffer) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', buffer));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The same file in the cache of an earlier deploy. */
async function previous(url, hash) {
  for (const name of await caches.keys()) {
    if (!name.startsWith(PREFIX) || name === CACHE) continue;
    const response = await (await caches.open(name)).match(url);
    if (response && response.headers.get(HASH) === hash) return response;
  }
  return null;
}

/**
 * The file of this deploy: from the HTTP cache when it is the right one (the page has usually just
 * loaded it), from the server otherwise. A host still serving another deploy fails the install,
 * which the browser tries again later.
 */
async function download(url, hash) {
  for (const cache of ['default', 'no-cache']) {
    const response = await fetch(url, { cache });
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    const body = await response.arrayBuffer();
    if ((await sha256(body)) !== hash) continue;
    const headers = new Headers({ [HASH]: hash });
    const type = response.headers.get('Content-Type');
    if (type) headers.set('Content-Type', type);
    return new Response(body, { status: 200, headers });
  }
  throw new Error(`${url}: the server has another version of this file`);
}

async function install() {
  const cache = await caches.open(CACHE);
  const entries = Object.entries(FILES);
  let next = 0;
  const worker = async () => {
    while (next < entries.length) {
      const [path, hash] = entries[next++];
      const url = urlOf(path);
      if (await cache.match(url)) continue; // an install that stopped half-way
      await cache.put(url, (await previous(url, hash)) ?? (await download(url, hash)));
    }
  };
  await Promise.all(Array.from({ length: PARALLEL }, worker));
}

self.addEventListener('install', (event) => event.waitUntil(install()));

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name.startsWith(PREFIX) && name !== CACHE) await caches.delete(name);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') void self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== SCOPE.origin || !url.pathname.startsWith(SCOPE.pathname)) return;
  let path;
  try {
    path = decodeURIComponent(url.pathname.slice(SCOPE.pathname.length));
  } catch {
    return;
  }
  if (path === '' || (request.mode === 'navigate' && path === 'index.html')) path = 'index.html';
  // the web versions opened from the IDE have their own worker (public/preview/sw.js)
  if (path.startsWith('preview/') || !(path in FILES)) return;
  event.respondWith(
    (async () => (await (await caches.open(CACHE)).match(urlOf(path))) ?? fetch(request))(),
  );
});
