/* v18: the page itself always comes fresh from the internet (falls back to this phone's copy when offline); icons and fonts come from the copy */
const C = "pl-v30";
const CORE = ["/", "/manifest.json", "/icon-96.png", "/icon-192.png", "/icon-512.png", "/icon-maskable-192.png", "/icon-maskable-512.png"];
self.addEventListener("install", e => { self.skipWaiting(); e.waitUntil(caches.open(C).then(c => c.addAll(CORE.map(u => new Request(u, { cache: "reload" })))).catch(() => {})); });
self.addEventListener("activate", e => e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x !== C).map(x => caches.delete(x)))).then(() => self.clients.claim())));
const OFF = () => new Response('<meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#fff;color:#3730A3;font:16px system-ui">No internet. Try again.</body>', { headers: { "Content-Type": "text/html" } });
self.addEventListener("fetch", e => {
  const r = e.request; if (r.method !== "GET") return;
  const u = new URL(r.url), same = u.origin === location.origin, font = /(^|\.)fonts\.(googleapis|gstatic)\.com$/.test(u.hostname);
  if (!same && !font) return;
  const page = same && (r.mode === "navigate" || u.pathname === "/" || u.pathname.endsWith(".html"));
  if (same && (u.pathname === "/manifest.json" || /^\/icon-/.test(u.pathname))) {   // app icon and manifest: always the newest from the internet
    e.respondWith(caches.open(C).then(c => fetch(r.url, { cache: "no-store" }).then(res => { if (res && res.ok) c.put(r, res.clone()); return res; }).catch(async () => (await c.match(r, { ignoreSearch: true })) || OFF())));
    return;
  }
  if (page) {
    e.respondWith(caches.open(C).then(c => fetch(r.url, { cache: "no-store" }).then(res => { if (res && res.ok) c.put("/", res.clone()); return res; }).catch(async () => (await c.match("/")) || OFF())));
    return;
  }
  e.respondWith(caches.open(C).then(async c => {
    const hit = await c.match(r, { ignoreSearch: same });
    const net = (same ? fetch(r.url, { cache: "no-cache" }) : fetch(r)).then(res => { if (res && (res.ok || res.type === "opaque")) c.put(r, res.clone()); return res; });
    if (hit) { e.waitUntil(net.catch(() => {})); return hit; }
    return net.catch(() => OFF());
  }));
});
