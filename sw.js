/* Green Trends app: the page always comes fresh (falls back to this device's copy offline); icons, fonts and the image maker come from the copy */
const C = "gt-root-v1";
self.addEventListener("install", e => { self.skipWaiting(); e.waitUntil(caches.open(C).then(c => c.addAll(["/", "/manifest.json", "/icon-96.png", "/icon-192.png", "/icon-512.png"].map(u => new Request(u, { cache: "reload" })))).catch(() => {})); });
self.addEventListener("activate", e => e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x !== C).map(x => caches.delete(x)))).then(() => self.clients.claim())));
const OFF = () => new Response('<meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#0A1A2B;color:#fff;font:16px system-ui">No internet. Try again.</body>', { headers: { "Content-Type": "text/html" } });
self.addEventListener("fetch", e => {
  const r = e.request; if (r.method !== "GET") return;
  const u = new URL(r.url), same = u.origin === location.origin, lib = /(^|\.)fonts\.(googleapis|gstatic)\.com$/.test(u.hostname) || u.hostname === "cdnjs.cloudflare.com";
  if (same && (u.pathname === "/" || u.pathname === "/index.html")) {
    e.respondWith(caches.open(C).then(c => fetch(r.url, { cache: "no-store" }).then(res => { if (res && res.ok) c.put("/", res.clone()); return res; }).catch(async () => (await c.match("/")) || OFF())));
    return;
  }
  if (same && r.mode === "navigate") return;
  if (same && /\.(png|json)$/.test(u.pathname) || lib) e.respondWith(caches.open(C).then(async c => { const hit = await c.match(r, { ignoreSearch: same }); const net = fetch(r).then(res => { if (res && (res.ok || res.type === "opaque")) c.put(r, res.clone()); return res; }); if (hit) { e.waitUntil(net.catch(() => {})); return hit; } return net; }));
});
