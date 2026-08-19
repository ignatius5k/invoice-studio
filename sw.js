const CACHE_PREFIX = "invoice-studio-";
const CACHE_NAME = `${CACHE_PREFIX}v29`;
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css?v=29",
  "./vendor/html2pdf.bundle.min.js?v=29",
  "./vendor/supabase.js?v=29",
  "./feature-flags.js?v=29",
  "./supabase-config.js?v=29",
  "./backend.js?v=29",
  "./outbox.js?v=29",
  "./app.js?v=29",
  "./manifest.webmanifest",
  "./eng-hoon-residences-logo.png",
  "./icon-192.png",
  "./icon-512.png"
];

function appUrl(relativePath) {
  return new URL(relativePath, self.registration.scope).href;
}

function isAppShellRequest(requestUrl) {
  return APP_SHELL.some((relativePath) => appUrl(relativePath) === requestUrl.href);
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
      const cache = await caches.open(CACHE_NAME);
      await cache.put(event.request, response.clone());
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
        const cache = await caches.open(CACHE_NAME);
        await cache.put(event.request, response.clone());
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

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME).map((key) => caches.delete(key))))
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
    // Authentication callbacks may carry credentials in the query string. They
    // must never become Cache Storage keys or fall back to a cached callback.
    event.respondWith(requestUrl.search ? fetch(event.request) : fetchNavigation(event));
    return;
  }

  if (!isAppShellRequest(requestUrl)) return;
  event.respondWith(fetchShellRequest(event));
});
