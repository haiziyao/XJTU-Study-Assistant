import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

const renderer = path.resolve(import.meta.dirname, '..', 'src', 'renderer');
const text = (relative) => readFile(path.join(renderer, relative), 'utf8');

test('手机版：底栏固定为对话、日历、待办、笔记，其余入口进入更多弹层', async () => {
  const [html, app] = await Promise.all([text('index.html'), text('shell/app.js')]);
  assert.match(html, /id="mobile-tabbar"/);
  assert.match(html, /id="mobile-more-sheet"/);
  assert.match(app, /MOBILE_PRIMARY\s*=\s*\['chat', 'calendar', 'todo', 'notes'\]/);
  assert.match(app, /Modules\.list\(\)/, '手机导航必须复用视图注册表，不能另维护一套页面');
});
test('PWA：清单、Service Worker 与安全更新流程均已接入', async () => {
  const [html, manifestRaw, worker] = await Promise.all([text('index.html'), text('manifest.webmanifest'), text('sw.js')]);
  const manifest = JSON.parse(manifestRaw);
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.scope, '/app/');
  assert.match(html, /rel="manifest"/);
  assert.match(worker, /SKIP_WAITING/);
  assert.match(worker, /url\.pathname\.startsWith\('\/api\/'\)\) return/, 'Service Worker 不得把 API 明文写进 Cache Storage');
});

test('手机版入口二维码在本地编码，不把访问地址发给第三方网站', async () => {
  const [qr, transfer] = await Promise.all([text('kit/qrcode.js'), text('views/transfer.js')]);
  assert.match(qr, /window\.PCQRCode/);
  assert.match(qr, /AES|TextEncoder|codewords/);
  assert.doesNotMatch(qr, /api\.qr|googleapis|qrserver|fetch\s*\(/i);
  assert.match(transfer, /PCQRCode\.svg\(gateway\.httpsUrls\[0\]/);
});

test('离线隐私：只缓存笔记、日历、未完成待办，并使用 AES-GCM 不可导出密钥', async () => {
  const source = await text('kit/pwa.js');
  assert.match(source, /AES-GCM/);
  assert.match(source, /generateKey\([^;]+false, \['encrypt', 'decrypt'\]\)/s, '设备密钥必须不可导出');
  assert.match(source, /\/notes/);
  assert.match(source, /path === '\/calendar'/);
  assert.match(source, /path === '\/todos'/);
  for (const forbidden of ['/ai/', 'academic', 'auth-session', 'secret']) {
    assert.doesNotMatch(source.slice(source.indexOf('function cacheKind'), source.indexOf('function cacheKey')), new RegExp(forbidden.replaceAll('/', '\\/'), 'i'));
  }
});

test('触屏工作区：知识图谱与 Canvas 提供长按菜单和双指缩放状态', async () => {
  const source = await text('views/notes/notes.js');
  assert.match(source, /function wireLongPress/);
  assert.match(source, /touches\?\.length !== 2/);
  assert.match(source, /wireLongPress\(item\.group/);
  assert.match(source, /wireLongPress\(card/);
  assert.match(source, /wireLongPress\(hit/);
});
