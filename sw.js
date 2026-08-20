const CACHE_PREFIX = "invoice-studio-";
const CACHE_NAME = `${CACHE_PREFIX}v36`;
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css?v=36",
  "./redesign.css?v=36",
  "./backend.js?v=36",
  "./outbox.js?v=36",
  "./app.js?v=36",
  "./manifest.webmanifest",
  "./eng-hoon-residences-logo.png",
  "./icon-192.png",
  "./icon-512.png"
];
const RUNTIME_ASSETS = ["./vendor/html2pdf.bundle.min.js?v=32"];

function appUrl(relativePath) {
  return new URL(relativePath, self.registration.scope).href;
}

function isAppShellRequest(requestUrl) {
  return APP_SHELL.some((relativePath) => appUrl(relativePath) === requestUrl.href);
}

function isManagedAssetRequest(requestUrl) {
  return isAppShellRequest(requestUrl)
    || RUNTIME_ASSETS.some((relativePath) => appUrl(relativePath) === requestUrl.href);
}

function isCacheableResponse(response) {
  return Boolean(response && response.ok && response.type !== "opaque");
}

async function namedCacheMatch(request) {
  const cache = await caches.open(CACHE_NAME);
  return cache.match(request);
}

async function fetchShellRequest(event) {
  const networkRequest = fetch(event.request);
  const cacheWrite = networkRequest
    .then(async (response) => {
      if (!isCacheableResponse(response)) return;
      const responseForCache = response.clone();
      const cache = await caches.open(CACHE_NAME);
      await cache.put(event.request, responseForCache);
    })
    .catch(() => {});
  event.waitUntil(cacheWrite);

  try {
    return await networkRequest;
  } catch {
    return (await namedCacheMatch(event.request)) || Response.error();
  }
}

async function fetchNavigation(event) {
  const requestUrl = new URL(event.request.url);
  const shellNavigation = requestUrl.href === appUrl("./") || requestUrl.href === appUrl("./index.html");
  const networkRequest = fetch(event.request);
  if (shellNavigation) {
    const cacheWrite = networkRequest
      .then(async (response) => {
        if (!isCacheableResponse(response)) return;
        const responseForCache = response.clone();
        const cache = await caches.open(CACHE_NAME);
        await cache.put(event.request, responseForCache);
      })
      .catch(() => {});
    event.waitUntil(cacheWrite);
  }

  try {
    return await networkRequest;
  } catch {
    return (await namedCacheMatch(appUrl("./index.html"))) || Response.error();
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  // A first installation has no active worker to protect. Updates remain in
  // waiting until the app explicitly requests activation.
  if (!self.registration.active) self.skipWaiting();
});

async function migrateRuntimeAssets(cacheKeys) {
  const targetCache = await caches.open(CACHE_NAME);
  const previousCaches = cacheKeys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME);
  for (const relativePath of RUNTIME_ASSETS) {
    const requestUrl = appUrl(relativePath);
    if (await targetCache.match(requestUrl)) continue;
    for (const cacheName of previousCaches) {
      const cached = await (await caches.open(cacheName)).match(requestUrl);
      if (!cached) continue;
      await targetCache.put(requestUrl, cached);
      break;
    }
  }
}

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then(async (keys) => {
        await migrateRuntimeAssets(keys);
        await Promise.all(keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME).map((key) => caches.delete(key)));
      })
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  const requestUrl = new URL(event.request.url);
  if (requestUrl.origin !== self.location.origin) return;

  if (event.request.mode === "navigate") {
    event.respondWith(fetchNavigation(event));
    return;
  }

  if (!isManagedAssetRequest(requestUrl)) return;
  event.respondWith(fetchShellRequest(event));
});
