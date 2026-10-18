/* 可安装 PWA + 加密离线只读层。只缓存笔记、未来日历和未完成待办。 */
(function () {
  'use strict';

  // 渲染层的轻量单测没有真实 fetch/IndexedDB；PWA 能力在这种宿主里安静退化。
  if (typeof window.fetch !== 'function') {
    window.PCPWA = { init: async () => {}, refreshOfflineData: async () => false, clearOfflineData: async () => {}, offlineInfo: async () => ({ storedAt: null, secure: false, online: true }) };
    return;
  }

  const DB_NAME = 'potato-mobile-offline';
  const DB_VERSION = 1;
  const DATA_VERSION = 1;
  const MAX_RECENT_NOTES = 20;
  const nativeFetch = window.fetch.bind(window);
  let apiBase = null;
  let dbPromise = null;
  let installPrompt = null;

  function openDb() {
    if (!('indexedDB' in window) || !window.crypto?.subtle) return Promise.reject(new Error('当前环境不支持加密离线存储'));
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
        if (!db.objectStoreNames.contains('responses')) db.createObjectStore('responses');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return dbPromise;
  }

  async function transact(store, mode, action) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const result = action(tx.objectStore(store));
      tx.oncomplete = () => resolve(result?.result);
      tx.onerror = () => reject(tx.error || result?.error);
      tx.onabort = () => reject(tx.error || new Error('离线数据库操作失败'));
    });
  }

  async function encryptionKey() {
    let key = await transact('meta', 'readonly', (store) => store.get('device-key'));
    if (key) return key;
    key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    await transact('meta', 'readwrite', (store) => store.put(key, 'device-key'));
    return key;
  }

  function cacheKind(url) {
    let parsed;
    try { parsed = new URL(url, location.href); } catch { return null; }
    const path = parsed.pathname.replace(/^\/api\/v1/, '');
    if (/^\/notes(?:\/[^/]+)?$/.test(path) && parsed.searchParams.get('deleted') !== 'true') return path === '/notes' ? 'notes-list' : 'note';
    if (path === '/calendar') return 'calendar';
    if (path === '/todos' && parsed.searchParams.get('completed') !== 'true') return 'todos';
    return null;
  }

  function cacheKey(url) {
    const parsed = new URL(url, location.href);
    return `${parsed.pathname}${parsed.search}`;
  }

  async function encryptJson(value) {
    const key = await encryptionKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plain = new TextEncoder().encode(JSON.stringify({ v: DATA_VERSION, value }));
    const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain);
    return { iv, cipher, storedAt: new Date().toISOString(), v: DATA_VERSION };
  }

  async function decryptJson(record) {
    if (!record?.cipher || !record?.iv) return null;
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: record.iv }, await encryptionKey(), record.cipher);
    const parsed = JSON.parse(new TextDecoder().decode(plain));
    return parsed?.v === DATA_VERSION ? parsed.value : null;
  }

  async function storeResponse(url, payload, kind) {
    const record = { ...(await encryptJson(payload)), kind, url: cacheKey(url) };
    await transact('responses', 'readwrite', (store) => store.put(record, record.url));
    await transact('meta', 'readwrite', (store) => store.put(record.storedAt, 'last-sync'));
  }

  async function readRecord(url, kind) {
    const exact = await transact('responses', 'readonly', (store) => store.get(cacheKey(url)));
    if (exact) return { payload: await decryptJson(exact), storedAt: exact.storedAt };
    // 日历和清单的筛选 URL 很多；断网时退回后台预取的规范快照。
    const fallback = kind && await transact('responses', 'readonly', (store) => store.get(`snapshot:${kind}`));
    return fallback ? { payload: await decryptJson(fallback), storedAt: fallback.storedAt } : null;
  }

  async function storeSnapshot(kind, payload) {
    const record = { ...(await encryptJson(payload)), kind, url: `snapshot:${kind}` };
    await transact('responses', 'readwrite', (store) => store.put(record, record.url));
    await transact('meta', 'readwrite', (store) => store.put(record.storedAt, 'last-sync'));
  }

  function offlineResponse(record) {
    return new Response(JSON.stringify(record.payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'X-Potato-Offline': '1', 'X-Potato-Cached-At': record.storedAt || '' },
    });
  }

  window.fetch = async function encryptedOfflineFetch(input, init = {}) {
    const request = input instanceof Request ? input : null;
    const url = request?.url || String(input);
    const method = String(init.method || request?.method || 'GET').toUpperCase();
    const kind = cacheKind(url);

    if (method !== 'GET' && navigator.onLine === false && apiBase && url.startsWith(apiBase)) {
      return new Response(JSON.stringify({ ok: false, error: { code: 'OFFLINE_READ_ONLY', message: '当前处于离线只读模式，请连接电脑后再修改。' } }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    try {
      const response = await nativeFetch(input, init);
      if (kind && response.ok && response.headers.get('content-type')?.includes('application/json')) {
        response.clone().json().then((payload) => storeResponse(url, payload, kind)).catch(() => {});
      }
      return response;
    } catch (error) {
      if (method !== 'GET' && apiBase && url.startsWith(apiBase)) {
        showStatus('无法连接电脑 · 当前为只读模式', 'offline');
        return new Response(JSON.stringify({ ok: false, error: { code: 'OFFLINE_READ_ONLY', message: '当前无法连接电脑，请恢复局域网连接后再修改。' } }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (!kind || method !== 'GET') throw error;
      const cached = await readRecord(url, kind).catch(() => null);
      if (!cached?.payload) throw error;
      showStatus('离线只读 · 正在显示最近缓存', 'offline');
      return offlineResponse(cached);
    }
  };

  function dateKey(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  async function fetchJson(path) {
    const response = await nativeFetch(`${apiBase}${path}`, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  async function refreshOfflineData() {
    if (!apiBase || navigator.onLine === false || !window.isSecureContext) return false;
    const today = new Date();
    const until = new Date(today);
    until.setDate(until.getDate() + 30);
    const [notes, calendar, todos] = await Promise.all([
      fetchJson('/notes?limit=50'),
      fetchJson(`/calendar?from=${dateKey(today)}&to=${dateKey(until)}`),
      fetchJson('/todos?completed=false&limit=300'),
    ]);
    const recent = (notes?.items || []).filter((note) => !note.deletedAt).slice(0, MAX_RECENT_NOTES);
    await Promise.all([
      storeSnapshot('notes-list', { ...notes, items: recent }),
      storeSnapshot('calendar', calendar),
      storeSnapshot('todos', { ...todos, items: (todos?.items || []).filter((todo) => !todo.completed) }),
      ...recent.map(async (note) => {
        try { await storeResponse(`${apiBase}/notes/${encodeURIComponent(note.id)}`, await fetchJson(`/notes/${encodeURIComponent(note.id)}`), 'note'); } catch { /* 单条失败不影响其余快照 */ }
      }),
    ]);
    showStatus('离线内容已更新', 'synced', 2200);
    return true;
  }

  async function clearOfflineData() {
    await transact('responses', 'readwrite', (store) => store.clear());
    await transact('meta', 'readwrite', (store) => store.delete('last-sync'));
    showStatus('离线内容已清除', 'synced', 2200);
  }

  async function offlineInfo() {
    const storedAt = await transact('meta', 'readonly', (store) => store.get('last-sync')).catch(() => null);
    return { storedAt, secure: window.isSecureContext, online: navigator.onLine !== false };
  }

  function showStatus(text, tone = 'offline', hideAfter = 0) {
    const node = document.getElementById('pwa-status');
    if (!node) return;
    node.textContent = text;
    node.dataset.tone = tone;
    node.hidden = false;
    clearTimeout(showStatus.timer);
    if (hideAfter) showStatus.timer = setTimeout(() => { node.hidden = true; }, hideAfter);
  }

  function syncNetworkStatus() {
    if (navigator.onLine) {
      showStatus('已恢复连接，正在刷新离线内容…', 'synced');
      refreshOfflineData().catch(() => showStatus('已联网，离线内容稍后刷新', 'synced', 2500));
    } else {
      showStatus('离线只读 · 修改功能暂不可用', 'offline');
    }
  }

  async function registerServiceWorker() {
    if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
    const registration = await navigator.serviceWorker.register('sw.js', { scope: './' });
    const updateBox = document.getElementById('pwa-update');
    const reveal = () => { if (registration.waiting && navigator.serviceWorker.controller) updateBox.hidden = false; };
    reveal();
    registration.addEventListener('updatefound', () => registration.installing?.addEventListener('statechange', reveal));
    document.getElementById('pwa-update-now')?.addEventListener('click', () => registration.waiting?.postMessage({ type: 'SKIP_WAITING' }));
    document.getElementById('pwa-update-later')?.addEventListener('click', () => { updateBox.hidden = true; });
    navigator.serviceWorker.addEventListener('controllerchange', () => location.reload());
  }

  async function init(options = {}) {
    apiBase = options.apiBase || apiBase;
    window.addEventListener('online', syncNetworkStatus);
    window.addEventListener('offline', syncNetworkStatus);
    await registerServiceWorker().catch(() => {});
    if (navigator.onLine === false) syncNetworkStatus();
    else refreshOfflineData().catch(() => {});
  }

  window.addEventListener?.('beforeinstallprompt', (event) => {
    event.preventDefault();
    installPrompt = event;
  });

  window.PCModules?.registerSettingsSection?.({
    id: 'mobile-pwa',
    title: '手机版与离线内容',
    order: 82,
    async render(mount) {
      const info = await offlineInfo();
      const note = document.createElement('p');
      note.className = 'settings-note';
      note.textContent = !info.secure
        ? '当前不是安全连接。请通过传输页提供的 HTTPS 地址打开，才能安装并加密缓存离线内容。'
        : `离线只读缓存：近期笔记、未来 30 天日程和未完成待办。${info.storedAt ? `上次更新 ${new Date(info.storedAt).toLocaleString()}` : '尚未生成缓存。'}`;
      const actions = document.createElement('div');
      actions.className = 'settings-actions';
      const addButton = (label, run) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'ghost-btn';
        button.textContent = label;
        button.addEventListener('click', async () => {
          button.disabled = true;
          try { await run(); } finally { button.disabled = false; }
        });
        actions.appendChild(button);
      };
      addButton('更新离线内容', async () => {
        if (!(await refreshOfflineData())) throw new Error('当前无法更新，请确认已通过 HTTPS 连接电脑');
        window.PC?.toast?.('离线内容已更新');
      });
      addButton('清除离线内容', async () => {
        await clearOfflineData();
        window.PC?.toast?.('离线内容已清除');
      });
      if (installPrompt) addButton('安装到主屏幕', async () => { await installPrompt.prompt(); installPrompt = null; });
      mount.replaceChildren(note, actions);
    },
  });

  window.PCPWA = { init, refreshOfflineData, clearOfflineData, offlineInfo };
})();
