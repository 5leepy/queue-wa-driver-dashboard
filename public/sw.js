const CACHE_NAME = 'antrean-driver-v2';

// Install event - force active immediately
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

// Activate event - clean up old caches, then claim all clients
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((cacheNames) => {
        return Promise.all(
          cacheNames
            .filter((name) => name !== CACHE_NAME) // delete any cache that isn't current version
            .map((name) => {
              console.log('[SW] Deleting old cache:', name);
              return caches.delete(name);
            })
        );
      })
      .then(() => self.clients.claim())
  );
});

// Fetch event - Cache-first with stale-while-revalidate for local static assets, bypass API/WS
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Bypass cache for APIs, WebSockets, Next.js HMR/dev files, or local bot ports
  if (
    url.pathname.startsWith('/_next') ||
    url.pathname.includes('webpack') ||
    url.pathname.startsWith('/api') ||
    url.hostname.includes('nadir.my.id') ||
    url.hostname.includes('googletagmanager.com') ||
    url.hostname.includes('google-analytics.com') ||
    url.hostname.includes('vercel-insights.com') ||
    url.port === '5050' ||
    url.port === '5051' ||
    event.request.url.startsWith('ws')
  ) {
    return;
  }

  // Only handle GET requests from the same origin
  if (event.request.method === 'GET' && url.origin === self.location.origin) {
    event.respondWith(
      caches.match(event.request).then((cachedResponse) => {
        // Fetch new version in the background to update the cache (stale-while-revalidate)
        const fetchPromise = fetch(event.request)
          .then((networkResponse) => {
            if (networkResponse && networkResponse.status === 200) {
              const responseToCache = networkResponse.clone();
              caches.open(CACHE_NAME).then((cache) => {
                cache.put(event.request, responseToCache);
              });
            }
            return networkResponse;
          })
          .catch((err) => {
            console.log('[SW] Fetch failed (probably offline):', err);
          });

        // Return cache if available, otherwise wait for network fetch
        return cachedResponse || fetchPromise;
      })
    );
  }
});
