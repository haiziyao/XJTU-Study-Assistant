const VERSION = 'mobile-v1';
const SHELL = `potato-shell-${VERSION}`;
const APP_ROOT = new URL('./', self.location.href).pathname;
const ASSETS = [
  './', './index.html', './manifest.webmanifest', './assets/app-icon.svg',
  './shell/shell.css', './shell/theme.css', './shell/app.js', './shell/icons.js',
  './shell/message.js', './shell/planned.js', './shell/settings.js',
  './shell/sidebar-layout.js', './shell/sidebar-customize.js',
  './kit/theme.js', './kit/registry.js', './kit/util.js', './kit/labels.js',
  './kit/dom.js', './kit/richtext.js', './kit/qrcode.js', './kit/pwa.js',
  './views/calendar.css', './views/calendar.js', './views/lms.css', './views/lms.js',
  './views/academic.css', './views/academic.js', './views/notes/notes.css',
  './views/notes/notes.js', './views/auth.css', './views/auth-settings.js',
  './views/knowledge-settings.css', './views/knowledge-settings.js',
  './views/chat-hub.css', './views/chat-hub.js', './views/chat-settings.css',
  './views/chat-settings.js', './views/review.css', './views/review.js',
  './views/transfer.css', './views/transfer.js', './views/account.css',
  './views/account.js', './views/sync.css', './views/sync.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((cache) => cache.addAll(ASSETS)));
});
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith('potato-shell-') && key !== SHELL).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // 业务数据由页面里的加密离线层处理，Service Worker 绝不保存明文 API 响应。
  if (url.pathname.startsWith('/api/')) return;
  if (!url.pathname.startsWith(APP_ROOT)) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(SHELL).then((cache) => cache.put(new URL('./', self.location.href), copy));
          return response;
        })
        .catch(() => caches.match(new URL('./', self.location.href))),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request).then((response) => {
      if (response.ok) caches.open(SHELL).then((cache) => cache.put(request, response.clone()));
      return response;
    })),
  );
});
