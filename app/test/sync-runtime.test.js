/**
 * 运行环境判定（`modules/sync/runtime.js`）的真值表单测。
 *
 * 为什么这是一条**安全相关**的判定：敏感数据（AI key / 学堂凭据）的同步开关
 * **只在非网页客户端显示**。判错的两个方向都很难看：
 *   - 把桌面端判成网页 → 用户永远开不了敏感数据同步（功能死掉）；
 *   - 把网页版判成桌面端 → 在公网页面上给出"同步 API key"的复选框（用户以为自己在
 *     自己的机器上，其实是在别人的服务器上点开关）。
 * 所以这张表把每一档都钉死：回环/私有网段 → native；公网 + 同源 `/auth/config` 可达 → web；
 * 公网 + 探测不可达 → native；**探测没做成** → unknown（按 native 处理但如实标注）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { detectRuntimeKind, explainRuntime, isPrivateHostname, normalizeHostname, secretsAllowed } from '../src/modules/sync/runtime.js';

test('环境判定：回环与私有网段一律 native（这些地址不可能是公网服务端版）', () => {
  for (const hostname of ['127.0.0.1', 'localhost', 'app.localhost', '::1', '[::1]:3210', '0.0.0.0']) {
    assert.equal(detectRuntimeKind({ hostname, hasSameOriginAuthConfig: false }), 'native', `${hostname} 应该是 native`);
  }
  for (const hostname of ['192.168.1.5', '192.168.0.1', '10.0.0.7', '10.255.255.254', '172.16.0.1', '172.20.3.4', '172.31.255.1', '169.254.1.1', '100.64.0.1']) {
    assert.equal(detectRuntimeKind({ hostname }), 'native', `${hostname} 是私有网段，应该 native`);
  }
  // 局域网里的机器名（手机 App 直连 `mypc.lan` / `ipad` 这种）
  for (const hostname of ['mypc', 'ipad.local', 'study.lan', 'nas.home']) {
    assert.equal(detectRuntimeKind({ hostname }), 'native', `${hostname} 是局域网名字，应该 native`);
  }
  // IPv6 唯一本地/链路本地
  assert.equal(detectRuntimeKind({ hostname: 'fd00::1' }), 'native');
  assert.equal(detectRuntimeKind({ hostname: 'fe80::abcd' }), 'native');
});

test('环境判定：公网域名 + 同源 /auth/config 可达 → web', () => {
  assert.equal(detectRuntimeKind({ hostname: 'study.xjtuwhy.com', hasSameOriginAuthConfig: true }), 'web');
  assert.equal(detectRuntimeKind({ hostname: 'www.example.com', hasSameOriginAuthConfig: true }), 'web');
  assert.equal(detectRuntimeKind({ hostname: '203.0.113.9', hasSameOriginAuthConfig: true }), 'web');
});

test('环境判定：公网域名 + 明确不可达 → native（不是服务端版宿主发的页面）', () => {
  assert.equal(detectRuntimeKind({ hostname: 'study.xjtuwhy.com', hasSameOriginAuthConfig: false }), 'native');
  assert.equal(detectRuntimeKind({ hostname: 'example.com', hasSameOriginAuthConfig: false }), 'native');
  // 边界：172.32 与 11.x 都是**公网**（不在 172.16/12 与 10/8 里），别把它们误判成内网
  assert.equal(isPrivateHostname('172.32.0.1'), false);
  assert.equal(isPrivateHostname('11.0.0.1'), false);
  assert.equal(detectRuntimeKind({ hostname: '172.32.0.1', hasSameOriginAuthConfig: true }), 'web');
});

test('环境判定：拿不到探测结果（null / undefined）→ unknown，按 native 处理但如实标注', () => {
  assert.equal(detectRuntimeKind({ hostname: 'study.xjtuwhy.com', hasSameOriginAuthConfig: null }), 'unknown');
  assert.equal(detectRuntimeKind({ hostname: 'study.xjtuwhy.com' }), 'unknown');
  assert.equal(detectRuntimeKind({ hostname: '' }), 'unknown');
  assert.equal(detectRuntimeKind({}), 'unknown');
  assert.equal(detectRuntimeKind(), 'unknown');
  // unknown 不等于 web：不能因为"没验成功"就把用户自己的设备挡在外面
  assert.equal(secretsAllowed('unknown'), true);
  assert.equal(secretsAllowed('native'), true);
  assert.equal(secretsAllowed('web'), false, '只有明确的网页版才禁止开敏感开关');
});

test('环境判定：explainRuntime 给出人话理由，面板直接显示', () => {
  const web = explainRuntime({ hostname: 'study.xjtuwhy.com', hasSameOriginAuthConfig: true });
  assert.equal(web.kind, 'web');
  assert.match(web.reason, /公网地址/);
  assert.match(web.reason, /auth\/config/);

  const native = explainRuntime({ hostname: '192.168.1.20' });
  assert.equal(native.kind, 'native');
  assert.match(native.reason, /私有网段/);

  const unknown = explainRuntime({ hostname: 'study.xjtuwhy.com', hasSameOriginAuthConfig: null });
  assert.equal(unknown.kind, 'unknown');
  assert.match(unknown.reason, /拿不到/);
  assert.match(unknown.reason, /按原生客户端处理/);
});

test('环境判定：主机名归一化（端口、方括号、尾点、大小写都不该骗过规则）', () => {
  assert.equal(normalizeHostname('127.0.0.1:3210'), '127.0.0.1');
  assert.equal(normalizeHostname('[::1]'), '::1');
  assert.equal(normalizeHostname('Study.XJTUWHY.com.'), 'study.xjtuwhy.com');
  assert.equal(normalizeHostname('  localhost  '), 'localhost');
  assert.equal(normalizeHostname(null), '');
  assert.equal(detectRuntimeKind({ hostname: '127.0.0.1:3210', hasSameOriginAuthConfig: true }), 'native', '本地端口不影响判定');
  assert.equal(isPrivateHostname('999.1.1.1'), false, '非法 IPv4 不能当私有地址');
});
