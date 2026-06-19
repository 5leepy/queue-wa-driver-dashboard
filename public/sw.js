const CACHE_NAME = 'antrean-driver-v1';

// Install event - force active immediately
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

// Activate event - claim all clients immediately
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
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
        // Fetch new version in the background to update the cache
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
            console.log('SW fetch failed (probably offline):', err);
          });

        // Return cache if available, otherwise wait for network fetch
        return cachedResponse || fetchPromise;
      })
    );
  }
});
