/* opens instantly from this phone's copy, then quietly fetches the newest version for next time */
const C = "pl-v11";
const CORE = ["/", "/manifest.json", "/icon-96.png", "/icon-192.png", "/icon-512.png"];
self.addEventListener("install", e => { self.skipWaiting(); e.waitUntil(caches.open(C).then(c => c.addAll(CORE)).catch(() => {})); });
self.addEventListener("activate", e => e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x !== C).map(x => caches.delete(x)))).then(() => self.clients.claim())));
self.addEventListener("fetch", e => {
  const r = e.request; if (r.method !== "GET") return;
  const u = new URL(r.url), same = u.origin === location.origin, font = /(^|\.)fonts\.(googleapis|gstatic)\.com$/.test(u.hostname);
  if (!same && !font) return;
  const key = same && r.mode === "navigate" ? "/" : r;
  e.respondWith(caches.open(C).then(async c => {
    const hit = await c.match(key, { ignoreSearch: same });
    const net = (same ? fetch(r.url, { cache: "no-cache" }) : fetch(r)).then(res => { if (res && (res.ok || res.type === "opaque")) c.put(key, res.clone()); return res; });
    if (hit) { e.waitUntil(net.catch(() => {})); return hit; }
    return net.catch(() => new Response('<meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#fff;color:#3730A3;font:16px system-ui">No internet. Try again.</body>', { headers: { "Content-Type": "text/html" } }));
  }));
});
