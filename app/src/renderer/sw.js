const VERSION = 'mobile-v15';
const SHELL = `potato-shell-${VERSION}`;
const APP_ROOT = new URL('./', self.location.href).pathname;
const ASSETS = [
  './', './index.html', './manifest.webmanifest', './assets/app-icon.svg',
  './shell/shell.css?v=20261019-5', './shell/theme.css?v=20261021-1', './shell/app.js?v=20261019-1', './shell/icons.js',
  './shell/message.js', './shell/planned.js', './shell/settings.js?v=20261019-3',
  './shell/sidebar-layout.js', './shell/sidebar-customize.js',
  './kit/theme.js?v=20261019-1', './kit/registry.js', './kit/util.js', './kit/labels.js',
  './kit/dom.js', './kit/richtext.js?v=20261021-1', './kit/qrcode.js', './kit/pwa.js',
  './views/calendar.css', './views/calendar.js', './views/lms.css', './views/lms.js', './views/notifications.js?v=20261019-2',
  './views/academic.css', './views/academic.js', './views/notes/notes.css?v=20261021-1',
  './views/notes/notes.js?v=20261021-1', './views/auth.css?v=20261017-1', './views/auth-settings.js',
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

  // 联网时优先获取最新脚本和样式，失败时才回退到缓存，避免更新后仍显示旧界面。
  if (/\.(?:js|css)$/i.test(url.pathname)) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) caches.open(SHELL).then((cache) => cache.put(request, response.clone()));
          return response;
        })
        .catch(() => caches.match(request)),
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
