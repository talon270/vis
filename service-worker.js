/* ============================================================================
   VIS · SERVICE WORKER
   ----------------------------------------------------------------------------
   Caches the shell on install, so after one visit the app opens with no
   network at all.

   Network-first for every request, cache as the fallback. The shell is seven
   small files and three fonts (45 KB), so the cost is one round trip per file
   while online. The gain is that an edited index.html and logic.js always
   arrive together; a cache-first worker can serve a new page against an old
   logic.js.
   ponytail: no timeout on the network leg, so a hanging connection waits for
   the browser's own timeout. Add a race against the cache if that bites.

   It does NOT fire reminders while the app is closed: the web has no
   scheduled-notification API. The page fires them; this file only routes
   clicks on them back to the page (NOTIFICATION CLICKS, below).

   Bump CACHE when SHELL changes.
   ========================================================================== */

const CACHE = "vis-shell-3";
const SHELL = [
  "./",
  "./index.html",
  "./logic.js",
  "./manifest.webmanifest",
  "./icon.svg",
  "./icon-192.png",
  "./icon-512.png",
  "./fonts/plexmono-400.woff2",
  "./fonts/plexmono-600.woff2",
  "./fonts/plexmono-700.woff2"
];

self.addEventListener("install", (event) => {
  /* cache:"reload" so a stale HTTP cache can't poison a fresh install. */
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: "reload" }))))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n.startsWith("vis-") && n !== CACHE).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  /* Same-origin GETs only. Sync calls to the database are cross-origin and
     must never be answered from a cache. */
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;

  event.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok) {
        const copy = res.clone();
        event.waitUntil(caches.open(CACHE).then((c) => c.put(req, copy)));
      }
      return res;
    } catch (e) {
      return (await caches.match(req, { ignoreSearch: true })) ||
             (req.mode === "navigate" && await caches.match("./index.html")) ||
             new Response("Offline, and this file was never cached.", { status: 504 });
    }
  })());
});

/* ---------------------------------------------------------------------------
   NOTIFICATION CLICKS
   The page owns the log and the schedule, so the click is passed to it.
   Exactly one window gets the message: two windows would log two breaks.
     · Done / Snooze  no focus, so one click logs the break without pulling
                      you into the app.
     · the body       focuses the window and does what the notification's
                      data.click names: "checkin" opens the check-in form;
                      a break reminder has none and starts the 20 s count.
   With no window open (quit after the notification appeared), Done reopens
   the app with ?done=1 rather than drop a break you took. Everything else
   just reopens it, on Today, where the check-in form is.
   ------------------------------------------------------------------------- */
self.addEventListener("notificationclick", (event) => {
  const data = event.notification.data || {};
  const type = event.action || data.click || "look";
  event.notification.close();
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const win = wins.find((w) => w.focused) || wins[0];
    if (!win) return self.clients.openWindow(type === "done" ? "./?done=1" : "./");
    win.postMessage({ type });
    if (type !== "done" && type !== "snooze") return win.focus();
  })());
});
