/* manager app: the page always comes fresh (falls back to this device's copy offline); fonts and the image maker come from the copy */
const C = "gt-app-v1";
self.addEventListener("install", e => { self.skipWaiting(); e.waitUntil(caches.open(C).then(c => c.addAll(["/app/", "/app/manifest.json"].map(u => new Request(u, { cache: "reload" })))).catch(() => {})); });
self.addEventListener("activate", e => e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x.startsWith("gt-app-") && x !== C).map(x => caches.delete(x)))).then(() => self.clients.claim())));
self.addEventListener("fetch", e => {
  const r = e.request; if (r.method !== "GET") return;
  const u = new URL(r.url), same = u.origin === location.origin, lib = /(^|\.)fonts\.(googleapis|gstatic)\.com$/.test(u.hostname) || u.hostname === "cdnjs.cloudflare.com";
  if (same && (r.mode === "navigate" || u.pathname === "/app/" || u.pathname === "/app/index.html")) {
    e.respondWith(caches.open(C).then(c => fetch(r.url, { cache: "no-store" }).then(res => { if (res && res.ok) c.put("/app/", res.clone()); return res; }).catch(async () => (await c.match("/app/")) || new Response("No internet. Try again.", { headers: { "Content-Type": "text/plain" } }))));
    return;
  }
  if (lib) e.respondWith(caches.open(C).then(async c => (await c.match(r)) || fetch(r).then(res => { if (res && (res.ok || res.type === "opaque")) c.put(r, res.clone()); return res; })));
});
