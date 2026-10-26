/**
 * 成长模块 · 角色成长（搬自 Brain Online test/rpg.test.js）。
 *
 * 经验 → 等级曲线、连击、成就解锁、属性映射与改名。前四个用例直接测纯函数；
 * 后五个走真实 HTTP，确认打卡 → 角色档案 → 成就列表这条链路没有断。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createServer } from '../src/server/index.js';
import {
  totalXpForLevel,
  xpForNextLevel,
  levelFromTotalXp,
  computeStreak,
  streakLabel,
} from '../src/modules/growth/rpg.js';

async function startApp() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'potato-growth-rpg-'));
  const app = await createServer({
    dataDir,
    onlyModules: ['growth'],
    growth: { now: () => new Date(2026, 9, 26, 9, 0, 0) },
  });
  const info = await app.listen({ port: 0 });
  const call = async (method, route, body) => {
    const response = await fetch(`${info.baseUrl}/growth${route}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const close = async () => {
    await call('POST', '/system/shutdown', { reason: 'test-cleanup' }).catch(() => {});
    await app.close();
    await app.services.growth?.closing?.catch?.(() => {});
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
  };
  return { app, call, close };
}

/** 造一条并完成，返回 PATCH 响应里的 award。 */
async function complete(ctx, fields) {
  const created = await ctx.call('POST', '/tasks', { estimateMin: 5, difficulty: 1, ...fields });
  const patched = await ctx.call('PATCH', `/tasks/${created.body.task.id}`, { status: 'done' });
  assert.equal(patched.status, 200, JSON.stringify(patched.body).slice(0, 300));
  return patched.body.award;
}

test('等级曲线：累计经验单调递增，1 级从 0 开始', () => {
  assert.equal(totalXpForLevel(1), 0);
  assert.ok(totalXpForLevel(2) > 0);
  let previous = -1;
  for (let level = 1; level <= 30; level++) {
    const total = totalXpForLevel(level);
    assert.ok(total > previous, `level ${level}`);
    previous = total;
  }
  assert.equal(xpForNextLevel(1), 100);
  assert.equal(xpForNextLevel(2), 160);
});

test('经验 → 等级换算在边界上正确', () => {
  assert.deepEqual([0, 99, 100, 259, 260].map((xp) => levelFromTotalXp(xp).level), [1, 1, 2, 2, 3]);
  const at100 = levelFromTotalXp(100);
  assert.equal(at100.xpIntoLevel, 0);
  assert.equal(at100.xpForNext, 160);
  assert.equal(at100.progress, 0);
});

test('连击：今天没打卡不算断，断一天就归零', () => {
  const dates = new Set(['2026-10-24', '2026-10-25', '2026-10-26']);
  assert.equal(computeStreak(dates, '2026-10-26'), 3);
  // 今天还没打，但昨天打了 → 仍然算 3
  assert.equal(computeStreak(dates, '2026-10-27'), 3);
  // 昨天断了
  assert.equal(computeStreak(dates, '2026-10-28'), 0);
  assert.equal(computeStreak(new Set(), '2026-10-26'), 0);
});

test('连击用词随天数变化', () => {
  assert.match(streakLabel(0), /还没开始/);
  assert.match(streakLabel(3), /三天/);
  assert.match(streakLabel(30), /一个月/);
});

test('完成任务：加经验、加属性、解锁首个成就与全清', async () => {
  const ctx = await startApp();
  try {
    const created = await ctx.call('POST', '/tasks', {
      title: '深度工作块',
      kind: 'focus',
      difficulty: 4,
      estimateMin: 30,
    });
    const award = (await ctx.call('PATCH', `/tasks/${created.body.task.id}`, { status: 'done' })).body.award;
    assert.equal(award.xp, 43, '难度 4 × 8 + 6 分钟 + 深度 5 = 43');
    assert.equal(award.attr, 'focus');
    assert.equal(award.attrGain, 2, '难度 ≥ 4 的任务属性 +2');
    assert.equal(award.streak, 1);
    assert.ok(award.newAchievements.some((item) => item.id === 'first-blood'));
    assert.ok(award.newAchievements.some((item) => item.id === 'perfect-day'));

    const character = (await ctx.call('GET', '/character')).body.character;
    assert.equal(character.totalXp, 43);
    assert.equal(character.attrs.focus, 2);
    assert.equal(character.streak, 1);
    assert.equal(character.level, 1);
  } finally {
    await ctx.close();
  }
});

test('修复日完成 3 条以上解锁"修复日"成就', async () => {
  const ctx = await startApp();
  try {
    await ctx.call('POST', '/state', {
      sleepHours: 5,
      sleepQuality: 1,
      energy: 1,
      mood: 1,
      stress: 5,
      focus: 1,
      body: 1,
    });
    const awards = [];
    for (let i = 0; i < 3; i++) {
      awards.push(await complete(ctx, { title: `轻恢复 ${i}`, kind: 'recover', difficulty: 1, estimateMin: 5 }));
    }
    assert.ok(
      awards.some((award) => award.newAchievements.some((item) => item.id === 'recover-hero')),
      JSON.stringify(awards.map((award) => award.newAchievements)),
    );
    const character = (await ctx.call('GET', '/character')).body.character;
    assert.ok(character.achievements.some((item) => item.id === 'recover-hero'));
  } finally {
    await ctx.close();
  }
});

test('升级会报告 leveledUp 与旧等级', async () => {
  const ctx = await startApp();
  try {
    const awards = [];
    for (let i = 0; i < 4; i++) {
      awards.push(await complete(ctx, { title: `长块 ${i}`, kind: 'focus', difficulty: 5, estimateMin: 240 }));
    }
    assert.deepEqual(awards.map((award) => award.level), [1, 2, 2, 3]);
    assert.equal(awards[1].leveledUp, true);
    assert.equal(awards[1].prevLevel, 1);
    assert.equal(awards[3].leveledUp, true);
    assert.equal(awards[3].prevLevel, 2);
    const character = (await ctx.call('GET', '/character')).body.character;
    assert.equal(character.level, 3);
    assert.equal(character.totalXp, 260);
  } finally {
    await ctx.close();
  }
});

test('成就列表带解锁状态，重复解锁不会重复记录', async () => {
  const ctx = await startApp();
  try {
    await complete(ctx, { title: '写一句话', kind: 'life' });
    // 幂等打卡：不会再加一次经验，也不会重复写成就
    const created = await ctx.call('POST', '/tasks', { title: '只做一次', kind: 'life' });
    await ctx.call('PATCH', `/tasks/${created.body.task.id}`, { status: 'done' });
    await ctx.call('PATCH', `/tasks/${created.body.task.id}`, { status: 'done' });

    const list = (await ctx.call('GET', '/character/achievements')).body.achievements;
    assert.ok(list.length > 5);
    const first = list.find((item) => item.id === 'first-blood');
    assert.equal(first.unlocked, true);
    const character = (await ctx.call('GET', '/character')).body.character;
    assert.equal(character.achievements.filter((item) => item.id === 'first-blood').length, 1);
  } finally {
    await ctx.close();
  }
});

test('属性按任务类型映射，改名有长度限制', async () => {
  const ctx = await startApp();
  try {
    const kinds = { focus: 'focus', mind: 'wisdom', body: 'vitality', life: 'discipline', recover: 'resilience' };
    for (const [kind, attr] of Object.entries(kinds)) {
      const award = await complete(ctx, { title: `属性测试 ${kind}`, kind, difficulty: 1 });
      assert.equal(award.attr, attr);
    }
    const renamed = await ctx.call('PATCH', '/character', { name: ' 夜航员 ' });
    assert.equal(renamed.body.character.name, '夜航员');

    const blank = await ctx.call('PATCH', '/character', { name: '   ' });
    assert.equal(blank.status, 400);
    assert.equal(blank.body.error.code, 'INVALID_FIELD');
  } finally {
    await ctx.close();
  }
});
