// The site as an installable app that works offline (phase 8): registers the service worker that
// the build writes (src/pwa/sw.js, scripts/sw-plugin.mjs), and offers to reload when a new deploy
// has been cached. Only in the built site: the dev server has no sw.js.

export interface PwaHooks {
  /** A new version is cached and waiting: apply() reloads the page into it. */
  updateReady(apply: () => void): void;
  /** The first install finished: from now on the IDE opens without the network. */
  offlineReady(): void;
}

/** How often an open IDE asks the host for a new deploy. */
const CHECK_MS = 60 * 60 * 1000;

export async function registerApp(hooks: PwaHooks): Promise<ServiceWorkerRegistration | null> {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return null;
  const base = import.meta.env.BASE_URL;
  let registration: ServiceWorkerRegistration;
  try {
    registration = await navigator.serviceWorker.register(`${base}sw.js`, {
      scope: base,
      updateViaCache: 'none',
    });
  } catch {
    return null; // a private window, or service workers turned off: the IDE works online
  }
  const firstInstall = !navigator.serviceWorker.controller;
  let reloading = false;
  let asked = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // the first install takes the page over too; only a reload asked for reloads
    if (asked && !reloading) {
      reloading = true;
      location.reload();
    }
  });
  // a worker waits only behind an active one: the first install never asks
  const offer = (worker: ServiceWorker) => {
    hooks.updateReady(() => {
      asked = true;
      worker.postMessage('skip-waiting');
    });
  };
  const follow = (worker: ServiceWorker) => {
    worker.addEventListener('statechange', () => {
      if (worker.state === 'installed' && registration.active && registration.active !== worker) {
        offer(worker);
      } else if (worker.state === 'activated' && firstInstall && !asked) {
        hooks.offlineReady();
      }
    });
  };
  if (registration.waiting && registration.active) offer(registration.waiting);
  if (registration.installing) follow(registration.installing);
  registration.addEventListener('updatefound', () => {
    if (registration.installing) follow(registration.installing);
  });
  const check = () => void registration.update().catch(() => {});
  setInterval(check, CHECK_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') check();
  });
  return registration;
}
