self.addEventListener("install", e => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", e => {
  if (e.request.mode === "navigate") {
    e.respondWith(fetch(e.request).catch(() => new Response('<meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#0E0C2B;color:#C7CCF9;font:16px system-ui">No internet. Try again.</body>', { headers: { "Content-Type": "text/html" } })));
  }
});
