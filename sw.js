// Service worker for Voice Notes.
// Strategy:
//  - App shell (local files): cache-first, so the app opens instantly and offline.
//  - Transformers.js library + Whisper model files (CDN/HF hub): stale-while-revalidate
//    runtime caching, so after the first successful online run they are available offline.

const SHELL_CACHE = "voice-notes-shell-v8";
const RUNTIME_CACHE = "voice-notes-runtime-v8";

const SHELL_ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./collab-core.js",
  "./collab-store.js",
  "./collab.js",
  "./md-render.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== SHELL_CACHE && k !== RUNTIME_CACHE)
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  const isShell = url.origin === self.location.origin;

  if (isShell) {
    // Cache-first for the local app shell.
    event.respondWith(
      caches.match(request).then((cached) => cached || fetchAndCache(request, SHELL_CACHE))
    );
  } else {
    // Stale-while-revalidate for CDN library + model files (large, immutable-ish).
    event.respondWith(
      caches.open(RUNTIME_CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        const network = fetch(request)
          .then((res) => {
            if (res && res.status === 200) cache.put(request, res.clone());
            return res;
          })
          .catch(() => cached);
        return cached || network;
      })
    );
  }
});

function fetchAndCache(request, cacheName) {
  return fetch(request).then((res) => {
    if (res && res.status === 200) {
      const copy = res.clone();
      caches.open(cacheName).then((cache) => cache.put(request, copy));
    }
    return res;
  });
}
