/* the app moved to pl.jjtraders.top — this removes the old /app/ copy from the device */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x.startsWith("gt-app-")).map(x => caches.delete(x)))).then(() => self.registration.unregister()).then(() => self.clients.matchAll()).then(cs => cs.forEach(c => c.navigate("/")))));
