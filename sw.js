// MK1 Gym Tracker service worker
//
// Keeps a copy of the app (the page and the three Firebase files) on the
// phone, so it opens instantly and works with no signal at all. Your workout
// data itself is stored and synced separately by Firestore's offline cache.
//
// - The page: served from the phone's copy straight away, while a fresh copy
//   downloads in the background for next time. The in-app "new version"
//   banner then offers a refresh, which always fetches the latest page.
// - Firebase files: their URLs include the version number, so they never
//   change and are served from the phone's copy.
// - Everything else (Firestore, sign-in) goes straight to the network.
//
// Bump SHELL_CACHE only when this file's caching logic changes. Normal app
// releases (new index.html) need no change here.

const SHELL_CACHE = "mk1-shell-v2";
const SDK_URLS = [
  "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js",
  "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js",
  "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js"
];
const LOCAL_FILES = ["./", "./manifest.json", "./icon-192.png", "./icon-512.png", "./apple-touch-icon.png",
  "./photo-ed.jpg", "./photo-tara.jpg", "./qr-ed.png", "./qr-tara.png"];
const PAGE_KEY = new URL("./", self.registration.scope).href; // the one stored copy of the page

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // Local files individually, so one missing icon can't block install.
    await Promise.all(LOCAL_FILES.map(u => cache.add(new Request(u, {cache: "reload"})).catch(() => {})));
    await Promise.all(SDK_URLS.map(u => cache.add(new Request(u, {mode: "cors"})).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith("mk1-") && k !== SHELL_CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

function isPageRequest(req, url) {
  if (url.origin !== self.location.origin) return false;
  if (req.mode === "navigate") return true;
  const scopePath = new URL(self.registration.scope).pathname;
  return url.pathname === scopePath || url.pathname === scopePath + "index.html";
}

async function fetchAndStorePage(req) {
  const res = await fetch(req, {cache: "no-store"});
  if (res && res.ok && res.type === "basic") {
    const cache = await caches.open(SHELL_CACHE);
    await cache.put(PAGE_KEY, res.clone());
  }
  return res;
}

function offlinePage() {
  return new Response(
    `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="background:#15181f;color:#eceef2;font-family:system-ui;text-align:center;padding:80px 24px"><div style="font-size:34px">&#128246;</div><h3>You're offline</h3><p style="color:#8a90a0">Open MK1 Tracker once with signal and it will work offline after that.</p><button onclick="location.reload()" style="margin-top:12px;padding:12px 20px;border-radius:12px;border:0;background:#e2502a;color:#fff;font-weight:700">Try again</button></body>`,
    {headers: {"Content-Type": "text/html; charset=utf-8"}}
  );
}

self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Firebase SDK files: versioned, never change.
  if (SDK_URLS.includes(url.href)) {
    event.respondWith((async () => {
      const cached = await caches.match(url.href);
      if (cached) return cached;
      const res = await fetch(req);
      if (res && res.ok) (await caches.open(SHELL_CACHE)).put(url.href, res.clone());
      return res;
    })());
    return;
  }

  if (isPageRequest(req, url)) {
    // The update checker asks for the live page with cache "no-store":
    // always go to the network for that (and refresh the stored copy).
    // The update checker (a background fetch) and the banner's Refresh button
    // (a page load with ?_v=) both want the latest page from the network.
    const wantsFresh = url.searchParams.has("_v") || (req.mode !== "navigate" && req.cache === "no-store");
    if (wantsFresh) {
      event.respondWith((async () => {
        try { return await fetchAndStorePage(req); }
        catch (e) {
          if (req.mode !== "navigate") throw e; // let the update check fail quietly
          return (await caches.match(PAGE_KEY)) || offlinePage();
        }
      })());
      return;
    }
    // Normal open: stored copy instantly, refresh it in the background.
    event.respondWith((async () => {
      const cached = await caches.match(PAGE_KEY);
      const network = fetchAndStorePage(req);
      if (cached) {
        event.waitUntil(network.catch(() => {}));
        return cached;
      }
      try { return await network; }
      catch (e) { return offlinePage(); }
    })());
    return;
  }

  // Other files from this site (icons, manifest): stored copy first.
  if (url.origin === self.location.origin) {
    event.respondWith((async () => {
      const cached = await caches.match(req, {ignoreSearch: true});
      if (cached) return cached;
      const res = await fetch(req);
      if (res && res.ok) (await caches.open(SHELL_CACHE)).put(req, res.clone());
      return res;
    })());
  }
  // Anything else (Firestore, Google sign-in): not touched.
});
