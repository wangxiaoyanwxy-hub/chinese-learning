const prefix = `hanzi-island:${self.registration.scope}:`;
const version = prefix + "v2";
const shell = [
  "./", "./index.html", "./style.css", "./app.js", "./library.js", "./manifest.webmanifest",
  "./icon-180.png", "./icon-192.png", "./icon-512.png", "./icon-maskable.png", "./lesson-import.mjs"
];
const assetUrls = new Set(shell.map(path => new URL(path, self.registration.scope).href));
const importUrls = new Set([
  "tesseract.min.js", "worker.min.js", "tesseract-core-lstm.wasm.js", "tesseract-core-simd-lstm.wasm.js",
  "chi_sim.traineddata.gz", "eng.traineddata.gz", "pdf.min.mjs", "pdf.worker.min.mjs", "pdf-data.mjs"
].map(path => new URL(path, self.registration.scope).href));

self.addEventListener("install", event => {
  event.waitUntil(caches.open(version).then(cache => cache.addAll(
    shell.map(path => new Request(path, { cache: "reload" }))
  )));
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith(prefix) && key !== version)
      .map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  const scope = new URL(self.registration.scope);
  if (url.origin !== scope.origin) return;
  if (event.request.mode === "navigate" && (
    url.pathname === scope.pathname || url.pathname === new URL("index.html", scope).pathname
  )) {
    event.respondWith(caches.open(version).then(cache => cache.match("./index.html"))
      .then(cached => cached || fetch(event.request)));
  } else if (assetUrls.has(url.href)) {
    event.respondWith(caches.open(version).then(cache => cache.match(event.request))
      .then(cached => cached || fetch(event.request)));
  } else if (importUrls.has(url.href)) {
    event.respondWith((async () => {
      const cache = await caches.open(version);
      const cached = await cache.match(event.request);
      if (cached) return cached;
      const response = await fetch(event.request);
      if (response.ok) await cache.put(event.request, response.clone()).catch(() => {});
      return response;
    })());
  }
});

