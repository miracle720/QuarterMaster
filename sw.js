// v5: Google worker sign-in (worker-auth.js). v4: features/payroll/audit/push scripts, functions + messaging SDKs, push handlers.
// v3: the app shell (index.html / app.js / styles.css) is now NETWORK-FIRST.
// Before, it was cache-first with a version that never changed, so any phone
// that had loaded the app once kept running its old copy of app.js forever —
// some workers had the fixes, others didn't, and index.html / app.js could
// even be from different versions on the same phone.
const CACHE_NAME = 'warehouse-checkin-v12';
const ASSETS = [
  './',
  './index.html',
  './app.js',
  './features.js',
  './payroll.js',
  './audit.js',
  './push.js',
  './worker-auth.js',
  './worker-emails.js',
  './analytics-extra.js',
  './styles.css',
  './manifest.json',
  './icons/logo.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png',
  'https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@2.47.0/tabler-icons.min.css',
  // Must match the <script> tags in index.html exactly or offline loads miss them
  'https://www.gstatic.com/firebasejs/10.13.0/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/10.13.0/firebase-database-compat.js',
  'https://www.gstatic.com/firebasejs/10.13.0/firebase-auth-compat.js',
  'https://www.gstatic.com/firebasejs/10.13.0/firebase-functions-compat.js',
  'https://www.gstatic.com/firebasejs/10.13.0/firebase-messaging-compat.js',
  'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      Promise.all(ASSETS.map(a => cache.add(a).catch(() => {})))
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = e.request.url;
  // Live data / auth: never touch
  if (url.includes('firebaseio.com') || url.includes('googleapis.com') || url.includes('identitytoolkit')) return;

  const sameOrigin = new URL(url).origin === self.location.origin;
  if (sameOrigin) {
    // Network-first, but fall back to cache after 4s so flaky warehouse wifi
    // doesn't hang the app on a dead connection.
    e.respondWith(new Promise(resolve => {
      let settled = false;
      const fallback = () => caches.match(e.request).then(c => c || caches.match('./index.html'));
      const timer = setTimeout(() => {
        fallback().then(c => { if (c && !settled) { settled = true; resolve(c); } });
      }, 4000);
      fetch(e.request).then(response => {
        clearTimeout(timer);
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
        }
        if (!settled) { settled = true; resolve(response); }
      }).catch(() => {
        clearTimeout(timer);
        if (!settled) fallback().then(c => { settled = true; c ? resolve(c) : resolve(Response.error()); });
      });
    }));
    return;
  }
  // Third-party libs (pinned versions): cache-first is fine
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request).then(response => {
      if (response && response.status === 200) {
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
      }
      return response;
    }))
  );
});

// ---- Push notifications (sent by the Cloud Functions in server/functions) ----
// The server sends data-only messages: { title, body, tag, url }.
self.addEventListener('push', e => {
  let p = {};
  try { p = e.data ? e.data.json() : {}; } catch (_) { p = { data: { body: e.data ? e.data.text() : '' } }; }
  const d = (p && (p.data || p.notification)) || p || {};
  e.waitUntil(self.registration.showNotification(d.title || 'Warehouse Check-in', {
    body: d.body || 'You have new work.', tag: d.tag || 'wms', renotify: true, requireInteraction: false,
    data: { url: d.url || './index.html' }
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const target = new URL((e.notification.data && e.notification.data.url) || './index.html', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) { if ('focus' in c) return c.focus(); }
    return self.clients.openWindow ? self.clients.openWindow(target) : undefined;
  }));
});
