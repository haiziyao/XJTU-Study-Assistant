/**
 * 合并口径的**纯函数**决策表（`merge.js`）。
 *
 * 为什么要单独钉一张表：`planMerge` 是整套同步的"宪法"——
 * 它只有六个分支，但每一个分支错了都会表现为**静默吞数据**（最难发现、最不能接受的那种 bug）：
 *   - 少了"重放 → 跳过"，第二次同步会把每条记录再存一份；
 *   - 少了"同 id 同内容 → 跳过"，两台设备互相推会把数据翻倍；
 *   - 少了"陈旧版本 → 跳过"，一台落后两个版本的设备推一次就会生成一份**带着旧内容**的副本
 *     （用户刚删掉的东西会被"复活"）；
 *   - 多了"谁新用谁"，两边各改各的时候会吞掉一方的编辑 —— 这张表里**一条时间比较都没有**。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { contentHash, copyId, ledgerKey, normalizeName, parseCopyId, planMerge, pushHistory, pushVersion, redactSecrets, versionKey } from '../src/modules/sync/merge.js';
import { planSingletonMerge, project, singletonIsEmpty, entryOf } from '../src/modules/sync/catalog.js';

const H = (name) => `hash-${name}`;

test('合并口径：对面这一版之前就给过我（重放）→ 跳过', () => {
  const decision = planMerge({
    id: 'n1',
    incomingHash: H('a'),
    localHash: H('a'),
    localExists: true,
    history: [{ hash: H('a'), localId: 'n1' }],
  });
  assert.deepEqual(decision, { action: 'skipped', reason: 'replay' });
});

test('合并口径：同 id 同内容（另一台设备推回来）→ 跳过', () => {
  const decision = planMerge({ id: 'n1', incomingHash: H('a'), localHash: H('a'), localExists: true, history: [] });
  assert.deepEqual(decision, { action: 'skipped', reason: 'identical' });
});

test('合并口径：本机没有这条记录 → 新增（保留原 id）', () => {
  assert.deepEqual(planMerge({ id: 'n1', incomingHash: H('a'), localExists: false, history: [] }), { action: 'added' });
});

test('合并口径：本机已有同内容的记录，再来一条同内容的冲突副本 → 跳过（不存第二份）', () => {
  const decision = planMerge({ id: 'n1', incomingHash: H('a'), localExists: false, history: [], variantContentPresent: true });
  assert.deepEqual(decision, { action: 'skipped', reason: 'variant-present' });
});

test('合并口径：本机这一版就是对面正式采纳过的版本 → 就地更新（唯一允许覆盖的分支）', () => {
  const decision = planMerge({
    id: 'n1',
    incomingHash: H('b'),
    localHash: H('a'),
    localExists: true,
    history: [{ hash: H('a'), localId: 'n1' }],
  });
  assert.deepEqual(decision, { action: 'updated' });
});

test('合并口径：对面的账本里只有"冲突副本"记录（没有被采纳过）→ 不覆盖，两条都留', () => {
  const decision = planMerge({
    id: 'n1',
    incomingHash: H('c'),
    localHash: H('b'),
    localExists: true,
    // 我方上次把 B 机那一版存成了副本（localId 不是 n1）→ 不算"采纳"
    history: [{ hash: H('b'), localId: 'n1-h12345678', conflict: true }],
  });
  assert.deepEqual(decision, { action: 'conflict' });
});

test('合并口径：陈旧推送（本机历史上出现过这一版，而对面没见过本机当前版）→ 跳过，绝不复活旧内容', () => {
  const decision = planMerge({
    id: 'n1',
    incomingHash: H('old'),
    localHash: H('deleted'),
    localExists: true,
    // 对面（B 机）从没给过本机 id 这一版 —— 它只是离线太久
    history: [],
    knownBefore: [H('old'), H('deleted')],
  });
  assert.deepEqual(decision, { action: 'skipped', reason: 'stale' });
});

test('合并口径：主动改回旧版本（对面见过本机当前版）→ 就地更新，不能被当成陈旧推送', () => {
  const decision = planMerge({
    id: 'n1',
    incomingHash: H('old'),
    localHash: H('deleted'),
    localExists: true,
    // 对面收到过（并被本机采纳过）当前这一版 → 它是**主动**改回去的（撤销编辑 / 从回收站恢复）
    history: [{ hash: H('deleted'), localId: 'n1' }],
    knownBefore: [H('old'), H('deleted')],
  });
  assert.deepEqual(decision, { action: 'updated' });
});

test('合并口径：判断不了 → 两条都留（这是默认分支）', () => {
  const decision = planMerge({ id: 'n1', incomingHash: H('b'), localHash: H('a'), localExists: true, history: [] });
  assert.deepEqual(decision, { action: 'conflict' });
});

test('冲突副本 id：确定性（两侧算出来必须一样）+ 可拆回父 id 与指纹', () => {
  const hash = contentHash({ body: 'B 改的' });
  const id = copyId('note-1', hash);
  assert.equal(id, `note-1-h${hash.slice(0, 8)}`);
  assert.equal(copyId('note-1', hash), id, '同一个内容算两次必须一样（否则两侧各存一份，越同步越多）');
  assert.deepEqual(parseCopyId(id), { parentId: 'note-1', hash: hash.slice(0, 8) });
  assert.equal(parseCopyId('note-1'), null);
});

test('内容指纹：与 id / createdAt / updatedAt 无关（幂等的前提）', () => {
  const base = { title: 'x', body: 'y' };
  // 真实的两个输入都是 `project()` 之后的记录（project 去掉两个时间戳、保留 id）
  const a = contentHash(project({ id: 'a', createdAt: '2026-01-01', updatedAt: '2026-01-01', ...base }));
  const b = contentHash(project({ id: 'b', createdAt: '2026-02-02', updatedAt: '2026-03-03', ...base }));
  assert.equal(a, b, 'id 与时间戳变了，内容指纹必须不变');
  const c = contentHash(project({ id: 'a', createdAt: '2026-02-02', updatedAt: '2026-03-03', ...base, body: 'z' }));
  assert.notEqual(a, c, '内容变了，指纹必须变');
  // project() 去掉的正是这两个时间戳，id 保留（协议要求按 id 合并）
  assert.deepEqual(project({ id: 'a', title: 'x', createdAt: 'c', updatedAt: 'u' }), { id: 'a', title: 'x' });
});

test('账本/版本索引：有上限、保序、去重', () => {
  let history = [];
  for (let index = 0; index < 12; index += 1) history = pushHistory(history, { hash: `h${index}`, localId: 'n1', at: 'x' });
  assert.equal(history.length, 8, '每个 (设备, 集合, id) 最多记 8 版');
  assert.equal(history.at(-1).hash, 'h11');

  let versions = [];
  versions = pushVersion(versions, 'a');
  versions = pushVersion(versions, 'b');
  versions = pushVersion(versions, 'a');
  assert.deepEqual(versions, ['b', 'a'], '重复指纹去重、最新的排最后');
});

test('批次/账本键：形状固定（换实现时不能悄悄改口径）', () => {
  assert.equal(ledgerKey('device:abc', 'notes', 'n1'), 'device:abc|notes|n1');
  assert.equal(versionKey('notes', 'n1'), 'notes|n1');
  assert.equal(normalizeName('  高等   数学  '), '高等 数学');
});

test('单例合并（ai-config / 学堂凭据）：填空白、绝不覆盖本机已有的值', () => {
  // ① 本机连配置文件都没有 → 整份采用
  const fresh = planSingletonMerge({ local: { provider: 'deepseek', apiKey: '' }, incoming: { apiKey: 'sk-remote', model: 'deepseek-v4-pro' }, fileExists: false });
  assert.deepEqual(fresh.adopted.sort(), ['apiKey', 'model']);
  assert.equal(fresh.wholesale, true);
  assert.deepEqual(fresh.conflicts, []);

  // ② 本机有值、与远端不同 → 保留本机值，只报字段名（**不报值**）
  const clash = planSingletonMerge({
    local: { apiKey: 'sk-mine', model: 'deepseek-flash' },
    incoming: { apiKey: 'sk-theirs', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com/v1' },
    fileExists: true,
  });
  assert.deepEqual(clash.conflicts, ['apiKey'], '值不同 → 冲突（保留本机值）');
  assert.equal(clash.patch.apiKey, undefined, '绝不能把远端的 key 写进 patch');
  assert.equal(clash.patch.baseUrl, 'https://api.deepseek.com/v1', '本机为空的字段才填');
  assert.deepEqual(clash.unchanged, ['model']);

  // ③ `__fileExists` 是同步自己的元信息，不能被写回配置
  const meta = planSingletonMerge({ local: null, incoming: { id: 'ai-config', apiKey: 'sk-x', __fileExists: true }, fileExists: false });
  assert.equal(meta.patch.__fileExists, undefined);
  assert.equal(meta.patch.id, undefined);
});

test('单例"有没有内容"：默认值不算内容（否则每台机器都会同步一堆默认值）', () => {
  const aiConfig = entryOf('ai-config');
  assert.equal(singletonIsEmpty(aiConfig, { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash', provider: 'deepseek', __fileExists: false }), true);
  assert.equal(singletonIsEmpty(aiConfig, { apiKey: 'sk-1' }), false);
  assert.equal(singletonIsEmpty(aiConfig, { baseUrl: 'https://x/v1', __fileExists: true }), false, '磁盘上有配置文件就算有内容');
  const lms = entryOf('lms-credentials');
  assert.equal(singletonIsEmpty(lms, { cookies: [] }), true);
  assert.equal(singletonIsEmpty(lms, { cookies: [{ name: 'TGC', value: 'x' }] }), false);
});

test('脱敏：报告/日志里不能出现 key、Bearer 令牌与常见凭据字段', () => {
  assert.equal(redactSecrets('用的是 sk-abcdef123456 这个 key'), '用的是 *** 这个 key');
  assert.equal(redactSecrets('Authorization: Bearer tok_abc123456'), 'Authorization: Bearer ***');
  assert.equal(redactSecrets('{"apiKey":"sk-xyz","model":"m"}'), '{"apiKey":"***","model":"m"}');
  assert.equal(redactSecrets('一段普通中文'), '一段普通中文');
});
