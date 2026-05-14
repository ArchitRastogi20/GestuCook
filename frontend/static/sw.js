// frontend/static/sw.js
// Caches big static assets so repeat loads are instant.

const CACHE = "gestucook-v1";
const PRECACHE = [
  "/static/vendor/mediapipe/gesture_recognizer.task",
  "/static/vendor/mediapipe/vision_bundle.mjs",
  "/static/vendor/mediapipe/wasm/vision_wasm_internal.js",
  "/static/vendor/mediapipe/wasm/vision_wasm_internal.wasm",
  "/static/vendor/mediapipe/wasm/vision_wasm_nosimd_internal.js",
  "/static/vendor/mediapipe/wasm/vision_wasm_nosimd_internal.wasm",
  "/static/fonts/fraunces-variable.woff2",
  "/static/fonts/fraunces-variable-italic.woff2",
  "/static/fonts/geist-variable.woff2",
  "/static/fonts/geist-mono-variable.woff2",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(PRECACHE)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (PRECACHE.some(p => url.pathname === p)) {
    e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
  }
});
