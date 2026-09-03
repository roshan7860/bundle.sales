// ---------------------------------------------------------------------------
// Roshan Bundle Activation -- service worker
//
// Goal: whenever you deploy a change, EVERY open browser tab and the
// installed (home-screen / "Create shortcut") app should pick it up on
// their own -- no manual refresh, no delete-and-reinstall.
//
// How it works:
//  1. CACHE_VERSION below is the only thing that has to change on a deploy.
//     Bump it (e.g. 'v4' -> 'v5') every time you upload a new index.html.
//     That alone makes the browser see this file as "changed", which is
//     what makes it check for updates at all.
//  2. self.skipWaiting() during install + the SKIP_WAITING message handler
//     let a freshly-downloaded version activate immediately instead of
//     waiting for every tab/app window to be closed first.
//  3. clients.claim() during activate hands control of already-open
//     tabs/app windows to the new worker right away.
//  4. Old caches from previous versions are deleted on activate, so nothing
//     stale lingers around.
//  5. This worker ONLY intercepts requests for this site's own files
//     (same-origin). Cross-origin requests -- the Firebase SDK from
//     gstatic.com, the xlsx library from cdnjs, Google Fonts, and any
//     Firestore/API traffic -- are left completely alone and go straight
//     to the network exactly like they would with no service worker at
//     all. Trying to cache those (especially the no-cors <script> tags)
//     is what caused the blank white screen on mobile -- this avoids that.
//
// On the index.html side, the app already polls this file for updates,
// tells a newly-found worker to skip waiting, and reloads once it takes
// control -- so combined with this file, a deploy should reach open
// browser tabs and the installed app within about a minute automatically.
// ---------------------------------------------------------------------------

var CACHE_VERSION = 'v9'; // <-- bump this string on every deploy
var CACHE_NAME = 'roshan-portal-' + CACHE_VERSION;

// Only this site's own root document. Keep this list small and same-origin
// only -- anything else is a source of subtle mobile bugs for very little
// offline benefit in an app that's mostly live Firestore data anyway.
var PRECACHE_URLS = [
  './',
  './index.html'
];

self.addEventListener('install', function(event){
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache){
      return cache.addAll(PRECACHE_URLS).catch(function(){
        // Don't fail install just because an optional asset 404s.
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

  // Only handle requests for this site's own origin. Everything
  // cross-origin (Firebase SDK, xlsx CDN, Google Fonts, Firestore/API
  // calls, etc.) is left untouched -- the browser handles it exactly as
  // if this service worker didn't exist.
  var url = new URL(req.url);
  if(url.origin !== self.location.origin) return;

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

  // Other same-origin static assets (icons, manifest, etc.): cache-first
  // for speed, fall back to network, and keep the cache updated quietly.
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
