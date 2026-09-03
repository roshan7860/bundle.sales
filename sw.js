// ---------------------------------------------------------------------------
// Roshan Bundle Activation -- service worker
//
// Goal: whenever you deploy a change, EVERY open browser tab and the
// installed (home-screen / "Create shortcut") app should pick it up on
// their own -- no manual refresh, no delete-and-reinstall.
//
// How it works:
//  1. CACHE_VERSION below is the only thing that has to change on a deploy.
//     Bump it (e.g. 'v3' -> 'v4') every time you upload a new index.html.
//     That alone makes the browser see this file as "changed", which is
//     what makes it check for updates at all.
//  2. self.skipWaiting() during install + the SKIP_WAITING message handler
//     let a freshly-downloaded version activate immediately instead of
//     waiting for every tab/app window to be closed first.
//  3. clients.claim() during activate hands control of already-open
//     tabs/app windows to the new worker right away.
//  4. Old caches from previous versions are deleted on activate, so nothing
//     stale lingers around.
//  5. Navigation/page requests use a "network-first" strategy: it always
//     tries to fetch the live page first and only falls back to the cached
//     copy if there's no network (offline). That means even before a new
//     service-worker version fully takes over, people are still getting
//     fresh HTML instead of a cached one.
//
// On the index.html side, the app already polls this file for updates,
// tells a newly-found worker to skip waiting, and reloads once it takes
// control -- so combined with this file, a deploy should reach open
// browser tabs and the installed app within about a minute automatically.
// ---------------------------------------------------------------------------

var CACHE_VERSION = 'v3'; // <-- bump this string on every deploy
var CACHE_NAME = 'roshan-portal-' + CACHE_VERSION;

// Only the app-shell files that make sense to have available offline.
// Firestore/API calls are never cached here.
var PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png'
];

self.addEventListener('install', function(event){
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache){
      return cache.addAll(PRECACHE_URLS).catch(function(){
        // Don't fail install just because one optional asset 404s.
      });
    })
  );
});

self.addEventListener('activate', function(event){
  event.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(
        keys.filter(function(key){ return key !== CACHE_NAME; })
            .map(function(key){ return caches.delete(key); })
      );
    }).then(function(){
      return self.clients.claim();
    })
  );
});

// Lets the page tell a waiting/installing worker to activate immediately
// (see index.html's tellWorkerToSkipWaiting()).
self.addEventListener('message', function(event){
  if(event.data === 'SKIP_WAITING'){
    self.skipWaiting();
  }
});

self.addEventListener('fetch', function(event){
  var req = event.request;
  if(req.method !== 'GET') return;

  // Navigation requests (loading/reloading the page) and the main HTML
  // file: always go to the network first so people get the newest markup
  // right away; only fall back to the cache when there's no connection.
  if(req.mode === 'navigate' || req.destination === 'document'){
    event.respondWith(
      fetch(req).then(function(res){
        var copy = res.clone();
        caches.open(CACHE_NAME).then(function(cache){ cache.put(req, copy); });
        return res;
      }).catch(function(){
        return caches.match(req).then(function(cached){
          return cached || caches.match('./index.html');
        });
      })
    );
    return;
  }

  // Everything else (icons, manifest, etc.): try the cache first for speed,
  // fall back to network, and keep the cache updated in the background.
  event.respondWith(
    caches.match(req).then(function(cached){
      var networkFetch = fetch(req).then(function(res){
        if(res && res.ok){
          var copy = res.clone();
          caches.open(CACHE_NAME).then(function(cache){ cache.put(req, copy); });
        }
        return res;
      }).catch(function(){ return cached; });
      return cached || networkFetch;
    })
  );
});
