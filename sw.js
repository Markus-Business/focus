// Service Worker der Fokus-App: hält die App-Dateien für die Nutzung ohne Netz bereit.
// Daten (Supabase) laufen nicht hierüber – die App speichert sie selbst lokal.
const VERSION = 'fokus-v1';
const SHELL = ['./', './index.html', './vendor/supabase.js', './vendor/Sortable.min.js', './manifest.json', './icon-180.png', './icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

// Mit Zeitlimit holen, damit schlechtes Netz nicht hängen bleibt
function fetchWithTimeout(req, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    fetch(req).then((r) => { clearTimeout(t); resolve(r); }, (e) => { clearTimeout(t); reject(e); });
  });
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // fremde Adressen (Supabase) nicht anfassen
  const isPage = req.mode === 'navigate' || url.pathname.endsWith('/') || url.pathname.endsWith('.html');
  if (isPage) {
    // Seite: zuerst aus dem Netz (neueste Version), sonst aus dem Speicher
    e.respondWith(
      fetchWithTimeout(req, 4000)
        .then((res) => { if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put('./index.html', copy)); } return res; })
        .catch(() => caches.match('./index.html'))
    );
  } else {
    // Bibliotheken, Bilder: zuerst aus dem Speicher
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
      return res;
    })));
  }
});
