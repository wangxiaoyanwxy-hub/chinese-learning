const prefix = `hanzi-island:${self.registration.scope}:`;
const version = prefix + "v1";
const shell = [
  "./", "./index.html", "./style.css", "./app.js", "./library.js", "./manifest.webmanifest",
  "./icon-180.png", "./icon-192.png", "./icon-512.png", "./icon-maskable.png"
];
const assetUrls = new Set(shell.map(path => new URL(path, self.registration.scope).href));

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
  }
});

