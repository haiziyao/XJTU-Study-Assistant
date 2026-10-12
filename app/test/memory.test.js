/**
 * 记忆服务的单元测试（接口文档 §10）。
 *
 * 挑这几类来测，是因为它们各自对应一种"用户会真的受伤"的错法：
 *   1. **200 字上限**：`text` 会直接进提示词，写坏了就是脏提示词（§10.2）；
 *   2. **敏感信息 400**：记忆是本机长期留存的数据，身份证/密码不该躺在这里（§10.5）；
 *   3. **去重与覆盖链**：同一条信息存两份、或覆盖时把旧条删掉，都会让"记忆"失去可信度（§10.3）；
 *   4. **复核语义**：带时效的结论到期后如果还照常注入，等于用过期事实污染每一次对话（§10.2/§10.7）；
 *   5. **预算与排序**：预算不生效就是"把整库塞进提示词"，排序错了就是"重要的进不来"（§10.7）；
 *   6. **提议不落库 + rejected 不重提**：模型唯一的写入口，也是记忆最容易失去信任的地方（§10.6）。
 *
 * 用真的 `JsonStore`（临时目录）而不是手写假集合：去重、覆盖链、清空备份都要落到
 * "文件里到底写了什么"，假集合测不出这一层。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { JsonStore } from '../src/core/store/json-store.js';
import {
  MemoryService,
  DEFAULT_BUDGET,
  firstSentence,
  freshnessOf,
  isReviewDue,
  normalizeText,
  scoreOf,
  sensitiveReason,
} from '../src/modules/memory/service.js';

/** 起一个只装了 `memories` 集合的服务（时钟可注入：复核与衰减不必改系统时间）。 */
async function makeService({ now } = {}) {
  const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'potato-memory-'));
  const store = await new JsonStore({ dataDir, collections: [{ name: 'memories', file: 'memories.json' }] }).init();
  const memory = new MemoryService({ store, now });
  return {
    memory,
    store,
    dataDir,
    async cleanup() {
      // 先等后台的命中回报写完再删目录：inject() 是"发了不等"的（§10.7 的命中即回报），
      // 直接 rm 会和落盘抢同一个文件（表现为随机 ENOENT / ENOTEMPTY 的假失败）
      await memory.flush();
      await fs.promises.rm(dataDir, { recursive: true, force: true });
    },
  };
}

/** 造一条指定字数的正文（不带句末标点，便于精确控制预算）。 */
const textOf = (chars, seed = '甲') => seed.repeat(chars);

// ---------------------------------------------------------------- 输入校验

test('记忆：正文 1~200 字，空/超长一律 400', async () => {
  const ctx = await makeService();
  try {
    await assert.rejects(
      () => ctx.memory.create({ text: '   ' }),
      (error) => error.status === 400 && error.details.field === 'text',
      '全空白等于没给正文',
    );
    await assert.rejects(() => ctx.memory.create({}), (error) => error.status === 400);
    assert.equal((await ctx.memory.create({ text: textOf(200) })).item.text.length, 200, '200 字应该收下');
    await assert.rejects(
      () => ctx.memory.create({ text: textOf(201) }),
      (error) => error.status === 400 && /200/.test(error.message) && error.details.field === 'text',
      '201 字必须 400 —— text 会直接进提示词',
    );
  } finally {
    await ctx.cleanup();
  }
});

test('记忆：scope / kind / key / source / confidence / value 都有校验', async () => {
  const ctx = await makeService();
  const base = { text: '我习惯晚上 19:00 之后安排学习任务' };
  try {
    for (const [field, patch] of [
      ['scope', { scope: '课程:39020' }],
      ['scope', { scope: 'course' }],
      ['kind', { kind: 'feeling' }],
      ['key', { key: '我的键' }],
      ['key', { key: 'Bad_Key' }],
      ['key', { key: 'a'.repeat(41) }],
      ['value', { value: () => 'x' }],
      ['sourceRef', { sourceRef: 'm-183' }],
    ]) {
      await assert.rejects(
        () => ctx.memory.create({ ...base, ...patch }),
        (error) => error.status === 400 && String(error.message).includes(field),
        `${field} 非法时必须 400：${JSON.stringify(patch)}`,
      );
    }
    // confidence 在"用户明说"这条路上恒为 1（§10.2），所以用它校验不了非法值 ——
    // 走模型提议那条路（source: ai）才看得到 0~1 的边界
    assert.throws(
      () => ctx.memory.propose({ ...base, confidence: 1.5 }),
      (error) => error.status === 400 && String(error.message).includes('confidence'),
    );
    // 合法的三种 scope 都要收下（course: 的 id 不做存在性校验，课程可能还没同步）
    for (const scope of ['global', 'course:39020', 'module:calendar']) {
      const item = (await ctx.memory.create({ text: `${scope} 的偏好`, scope })).item;
      assert.equal(item.scope, scope);
    }
    // JSON 值照收，超大的结构化值要拦（value 是辅助字段，不是第二个正文）
    assert.deepEqual((await ctx.memory.create({ text: '我的作息是晚上学习', value: { from: '19:00' } })).item.value, {
      from: '19:00',
    });
    await assert.rejects(() => ctx.memory.create({ text: '值太大', value: { blob: 'x'.repeat(3000) } }), (error) => error.status === 400);
  } finally {
    await ctx.cleanup();
  }
});

test('记忆：source 固定 user、confidence 恒为 1（POST /memories 是"用户明说"的路径）', async () => {
  const ctx = await makeService();
  try {
    const item = (await ctx.memory.create({ text: '我在读大二，专业是材料', source: 'ai', confidence: 0.3 })).item;
    assert.equal(item.source, 'user', '§10.5：显式写入的 source 固定 user，模型推断只能走 propose');
    assert.equal(item.confidence, 1, '§10.2：source 为 user 时 confidence 恒为 1');
  } finally {
    await ctx.cleanup();
  }
});

test('记忆：敏感信息直接拒（身份证 / 银行卡 / 密码 / 验证码），普通含数字文本不误杀', async () => {
  const ctx = await makeService();
  try {
    const cases = [
      ['我的身份证号是 610103199901011234', 'id_card'],
      ['银行卡 6222021234567890123', 'bank_card'],
      ['我的教务密码是 abcd1234', 'password'],
      ['刚才的验证码是 8848', 'sms_code'],
      ['学号 2023123456 密码 abcd1234', 'student_id_password'],
    ];
    for (const [text, pattern] of cases) {
      await assert.rejects(
        () => ctx.memory.create({ text }),
        (error) =>
          error.status === 400 &&
          error.details.reason === 'sensitive_content' &&
          error.details.pattern === pattern,
        `必须拒绝：${text}`,
      );
    }
    // 反向用例：带时间、带学号的普通偏好不能被误判（误杀的代价是用户再也记不住任何带数字的事）
    for (const text of ['我习惯晚上 19:00 之后安排学习任务', '我的学号是 2023123456', '我一学期修 24 学分', '我住在 3 号楼 512']) {
      assert.equal(sensitiveReason(text), undefined, `不该误杀：${text}`);
      assert.ok((await ctx.memory.create({ text })).item.id);
    }
  } finally {
    await ctx.cleanup();
  }
});

test('记忆：reviewAt 接受日期或 ISO 时刻，非法值 400，null 清空', async () => {
  const ctx = await makeService();
  try {
    const dated = (await ctx.memory.create({ text: '我这学期选了数据结构', reviewAt: '2027-01-15' })).item;
    assert.equal(dated.reviewAt, '2027-01-15', '日期粒度原样保留');
    const stamped = (await ctx.memory.create({ text: '我寒假要学车', reviewAt: '2027-02-01T10:00:00+08:00' })).item;
    assert.equal(stamped.reviewAt, '2027-02-01T10:00:00+08:00');

    for (const bad of ['下周三', '2026-02-30', '2026/01/15', 20260115]) {
      await assert.rejects(
        () => ctx.memory.create({ text: '带时效的结论', reviewAt: bad }),
        (error) => error.status === 400 && error.details.field === 'reviewAt',
        `reviewAt 非法：${JSON.stringify(bad)}`,
      );
    }
    assert.equal((await ctx.memory.update(dated.id, { reviewAt: null })).reviewAt, null);
  } finally {
    await ctx.cleanup();
  }
});

// ---------------------------------------------------------------- 去重 / 覆盖 / 冲突

test('记忆：无 key 时按 scope + 归一化正文去重，命中即幂等返回既有条', async () => {
  const ctx = await makeService();
  try {
    const first = (await ctx.memory.create({ text: '我习惯晚上学习' })).item;
    const again = await ctx.memory.create({ text: ' 我习惯晚上学习。 ' });
    assert.equal(again.duplicated, true, '标点与空白差异也算同一条（§10.3 的归一化口径）');
    assert.equal(again.item.id, first.id);
    assert.equal(ctx.store.memories.all().length, 1, '幂等调用不许新建第二条');

    // 全角 / 半角与大小写也要归一
    const full = (await ctx.memory.create({ text: '我习惯晚上 19:00 学习' })).item;
    const half = await ctx.memory.create({ text: '我习惯晚上 19：00 学习' });
    assert.equal(half.item.id, full.id, '全角冒号与半角冒号是同一条');

    // 作用域隔离：同样的正文在另一门课下是另一条记忆
    const scoped = (await ctx.memory.create({ text: '我习惯晚上学习', scope: 'course:39020' })).item;
    assert.notEqual(scoped.id, first.id, '不同 scope 不去重');
  } finally {
    await ctx.cleanup();
  }
});

test('记忆：同 scope+key 冲突 409（不静默覆盖），replace 走 superseded 链且不删除', async () => {
  const ctx = await makeService();
  try {
    const first = (
      await ctx.memory.create({ scope: 'global', kind: 'preference', key: 'preferred_study_window', text: '我习惯晚上学习' })
    ).item;

    await assert.rejects(
      () => ctx.memory.create({ scope: 'global', kind: 'preference', key: 'preferred_study_window', text: '我习惯下午学习' }),
      (error) =>
        error.status === 409 &&
        error.details.existing.id === first.id &&
        typeof error.details.hint === 'string',
      '冲突必须让用户选（§10.5）',
    );

    // 同键同文 → 幂等，而不是端一张"两个一模一样的东西选哪个"的卡
    const same = await ctx.memory.create({ key: 'preferred_study_window', text: '我习惯晚上学习' });
    assert.equal(same.duplicated, true);
    assert.equal(same.item.id, first.id);

    const replaced = await ctx.memory.create({
      scope: 'global',
      kind: 'preference',
      key: 'preferred_study_window',
      text: '我习惯下午学习',
      replace: true,
    });
    assert.equal(replaced.replaced.id, first.id);
    const old = ctx.memory.get(first.id);
    assert.ok(old, '旧条不删除（保留链，用户可能改回来）');
    assert.equal(old.status, 'superseded');
    assert.equal(old.supersededBy, replaced.item.id);
    assert.equal(ctx.memory.get(replaced.item.id).status, 'active');
    assert.equal((await ctx.memory.create({ text: '我习惯下午学习' })).duplicated, true, '新值现在是去重基准');

    // 旧条必须查得到：管理页要展示"被谁取代了"
    const superseded = ctx.memory.list({ status: 'superseded' });
    assert.equal(superseded.count, 1);
    assert.equal(superseded.items[0].id, first.id);
    // 分组计数不受 status 过滤影响：只看"已被取代"时，仍然要知道还有几条生效中
    assert.deepEqual(superseded.counts, { active: 1, superseded: 1, archived: 0, rejected: 0, total: 2 });
  } finally {
    await ctx.cleanup();
  }
});

test('记忆：list 支持 scope / kind / status / key / q / limit / offset，默认不过滤状态', async () => {
  const ctx = await makeService();
  try {
    await ctx.memory.create({ text: '我习惯晚上学习', kind: 'preference', key: 'night_study' });
    await ctx.memory.create({ text: '我周三下午不方便', kind: 'constraint' });
    await ctx.memory.create({ text: '高数老师是王老师', kind: 'fact', scope: 'course:39020' });
    await ctx.memory.create({ text: '数据结构作业拖到最后一天', kind: 'episodic' });

    assert.equal(ctx.memory.list({}).count, 4, '默认不过滤状态（§10.4：提议前要能查到 rejected）');
    assert.equal(ctx.memory.list({ scope: 'course:39020' }).count, 1);
    assert.equal(ctx.memory.list({ kind: 'constraint' }).count, 1);
    assert.equal(ctx.memory.list({ key: 'night_study' }).items[0].text, '我习惯晚上学习');
    assert.equal(ctx.memory.list({ q: '周三' }).count, 1, '关键词命中正文');
    assert.equal(ctx.memory.list({ q: 'night_study' }).count, 1, '关键词也命中 key');
    assert.equal(ctx.memory.list({ q: '不存在的东西' }).count, 0);
    assert.deepEqual(ctx.memory.list({}).counts, { active: 4, superseded: 0, archived: 0, rejected: 0, total: 4 });

    const page = ctx.memory.list({ limit: 2, offset: 1 });
    assert.equal(page.count, 4, 'count 是过滤后的总数，不受分页影响');
    assert.equal(page.items.length, 2);
    assert.equal(page.filters.limit, 2);
  } finally {
    await ctx.cleanup();
  }
});

// ---------------------------------------------------------------- 复核语义

test('记忆：reviewAt 到期后不再注入，但仍然可检索、可复核恢复', async () => {
  const future = new Date('2026-06-01T10:00:00+08:00');
  const ctx = await makeService({ now: () => future });
  try {
    await ctx.memory.create({ text: '我这学期选了数据结构', reviewAt: '2026-07-15' });
    await ctx.memory.create({ text: '我习惯晚上学习', reviewAt: null });

    let ids = ctx.memory.contextItems().map((item) => item.id);
    assert.equal(ids.length, 2, '未到期时照常注入');
    assert.equal(ctx.memory.list({ dueReview: true }).count, 0);

    // 复核日过去了：到期的结论停止注入（过期事实污染每一次对话，比"这次没想起来"危险）
    const after = new Date('2026-08-01T10:00:00+08:00');
    const later = new MemoryService({ store: ctx.store, now: () => after });
    ids = later.contextItems().map((item) => item.id);
    assert.equal(ids.length, 1, '到期的记忆不进注入');
    assert.equal((await later.inject()).dueReview, 1, '但要如实报出"有几条在等复核"');
    assert.equal(later.list({ dueReview: true }).count, 1, '管理页要能列出待复核的');
    assert.equal(later.list({}).count, 2, '检索不受复核影响（它不等于失效）');

    // 用户点"仍然有效" → 推到新的时间，又回到注入里
    const dated = later.list({ dueReview: true }).items[0];
    await later.update(dated.id, { reviewAt: '2027-01-15' });
    assert.equal(later.contextItems().length, 2);
    assert.equal(later.list({ dueReview: true }).count, 0);
    // `later` 是第二个服务实例，自己的后台回报要自己等（inject 是"发了不等"的）
    await later.flush();
  } finally {
    await ctx.cleanup();
  }
});

test('记忆：日期粒度的 reviewAt 到"那天结束"才算到期；时刻粒度按时刻比', () => {
  const noon = new Date('2026-07-15T12:00:00+08:00');
  assert.equal(isReviewDue('2026-07-15', noon), false, '当天不算过期');
  assert.equal(isReviewDue('2026-07-14', noon), true);
  assert.equal(isReviewDue(null, noon), false);
  assert.equal(isReviewDue('2026-07-15T09:00:00+08:00', noon), true, '早上 9 点已过');
  assert.equal(isReviewDue('2026-07-15T20:00:00+08:00', noon), false);
});

// ---------------------------------------------------------------- 注入预算与排序

test('记忆：预算真的生效 —— 条数上限、字数上限、truncated 如实置位', async () => {
  const ctx = await makeService();
  try {
    // 父约定里的边界用例：9 条各 100 字（无句末标点）→ 600 字刚好只放得下 6 条
    for (let i = 0; i < 9; i += 1) {
      await ctx.memory.create({ text: `${i}${textOf(99, '甲')}` });
    }
    const result = await ctx.memory.inject({ maxItems: 8, maxChars: 600 });
    assert.equal(result.injected.length, 6, '600 / 100 = 6 条');
    assert.equal(result.truncated, true, '还有 3 条没进来，必须如实告诉调用方');
    assert.ok(
      result.injected.reduce((sum, item) => sum + item.text.length, 0) <= 600,
      '不许超发（chat-service 就是按 text.length 计字数的）',
    );
    assert.ok(result.injected.every((item) => typeof item.text === 'string' && item.text.length > 0));
    assert.equal(result.budget.usedItems, 6);
    assert.ok(result.budget.usedChars <= 600);
    assert.equal(result.budget.dropped, 3);

    // 条数上限也要生效：10 条各 10 字 → 默认 8 条
    const other = await makeService();
    try {
      for (let i = 0; i < 10; i += 1) {
        await other.memory.create({ text: `${i}${textOf(9, '乙')}` });
      }
      const capped = await other.memory.inject({});
      assert.equal(capped.injected.length, DEFAULT_BUDGET.maxItems);
      assert.equal(capped.truncated, true);
    } finally {
      await other.cleanup();
    }

    // 刚好放得下时 truncated 必须为 false（否则调用方会去补查一堆已经看到的记忆）
    const exact = await makeService();
    try {
      for (let i = 0; i < 6; i += 1) {
        await exact.memory.create({ text: `${i}${textOf(99, '丙')}` });
      }
      const fitted = await exact.memory.inject({ maxItems: 8, maxChars: 600 });
      assert.equal(fitted.injected.length, 6);
      assert.equal(fitted.budget.usedChars, 600, '600 字刚好用完');
      assert.equal(fitted.truncated, false, '没有漏掉任何一条就不该说 truncated');
    } finally {
      await exact.cleanup();
    }
  } finally {
    await ctx.cleanup();
  }
});

test('记忆：空库 / 无匹配时 inject 不抛异常，返回空预算', async () => {
  const ctx = await makeService();
  try {
    const empty = await ctx.memory.inject({});
    assert.deepEqual(empty.injected, []);
    assert.equal(empty.truncated, false);
    assert.equal(empty.budget.usedItems, 0);
    // 只有 episodic 时也不注入（它只走检索），但同样不许抛
    await ctx.memory.create({ text: '上次数据结构作业拖到最后一天', kind: 'episodic' });
    const onlyEpisodic = await ctx.memory.inject({});
    assert.deepEqual(onlyEpisodic.injected, []);
    assert.equal(onlyEpisodic.truncated, false);
    assert.equal(ctx.memory.list({ kind: 'episodic' }).count, 1, 'episodic 仍然检索得到');
  } finally {
    await ctx.cleanup();
  }
});

test('记忆：排序 = kind 权重 × 置信度 × 新鲜度，episodic 不注入', async () => {
  const now = new Date('2026-10-12T09:00:00+08:00');
  const ctx = await makeService({ now: () => now });
  try {
    await ctx.memory.create({ text: '决定不导入已过期作业', kind: 'decision' });
    await ctx.memory.create({ text: '我在读大二，专业是材料', kind: 'fact' });
    await ctx.memory.create({ text: '我习惯晚上学习', kind: 'preference' });
    await ctx.memory.create({ text: '我周三下午不方便', kind: 'constraint' });

    const order = ctx.memory.contextItems().map((item) => item.kind);
    assert.deepEqual(order, ['constraint', 'preference', 'fact', 'decision'], '§10.7 的权重顺序');

    // 90 天半衰期：靠 lastUsedAt 把一条"用过很久"的记忆降级（注入会自动刷新 lastUsedAt）
    const stale = (
      await ctx.memory.create({ text: '我习惯早上背单词', kind: 'constraint' })
    ).item;
    await ctx.memory.markUsed(stale.id);
    const ninetyDaysLater = new Date(now.getTime() + 90 * 86400000);
    const later = new MemoryService({ store: ctx.store, now: () => ninetyDaysLater });
    const scores = later.contextItems().map((item) => item.score);
    const staleScore = later.contextItems().find((item) => item.id === stale.id).score;
    assert.ok(Math.abs(staleScore - 0.5) < 0.01, `90 天后应衰减到一半，实际 ${staleScore}`);
    assert.ok(staleScore < Math.max(...scores.filter((score) => score !== staleScore)), '衰减后不该再排第一');
  } finally {
    await ctx.cleanup();
  }
});

test('记忆：分数函数是纯函数，权重 / 半衰期 / 置信度各自可验证', () => {
  const now = new Date('2026-10-12T09:00:00+08:00');
  const at = (days) => new Date(now.getTime() - days * 86400000).toISOString();
  assert.equal(Math.round(freshnessOf({ updatedAt: at(0) }, now) * 100) / 100, 1);
  assert.ok(Math.abs(freshnessOf({ updatedAt: at(90) }, now) - 0.5) < 0.01);
  assert.ok(Math.abs(freshnessOf({ updatedAt: at(180) }, now) - 0.25) < 0.01);
  assert.equal(freshnessOf({ updatedAt: 'not-a-date' }, now), 1, '时间坏了当新鲜，别把记忆全丢掉');

  const base = { updatedAt: at(0), confidence: 1 };
  assert.equal(scoreOf({ ...base, kind: 'constraint' }, now), 1);
  assert.equal(scoreOf({ ...base, kind: 'preference' }, now), 0.9);
  assert.equal(scoreOf({ ...base, kind: 'fact' }, now), 0.8);
  assert.equal(scoreOf({ ...base, kind: 'decision' }, now), 0.6);
  assert.equal(scoreOf({ ...base, kind: 'episodic' }, now), 0, 'episodic 不注入');
  assert.equal(scoreOf({ ...base, kind: 'fact', confidence: 0.5 }, now), 0.4);
});

test('记忆：作用域决定"什么时候被想起来"（course 跟课程、module 跟视图）', async () => {
  const ctx = await makeService();
  try {
    const global = (await ctx.memory.create({ text: '我习惯晚上学习' })).item;
    const course = (await ctx.memory.create({ text: '这门课老师不点名', scope: 'course:39020' })).item;
    const module = (await ctx.memory.create({ text: '我在日历里只想看有课的日子', scope: 'module:calendar' })).item;

    const bare = ctx.memory.contextItems().map((item) => item.id);
    assert.deepEqual(bare, [global.id], '没带上下文时只有 global 参与');

    const inCourse = ctx.memory.contextItems({ courseId: 39020 }).map((item) => item.id);
    assert.ok(inCourse.includes(course.id));
    assert.ok(!inCourse.includes(module.id));
    assert.deepEqual(ctx.memory.contextItems({ courseId: '39020' }).map((item) => item.id), inCourse, '课程 id 数字/字符串等价');

    const inModule = ctx.memory.contextItems({ module: 'calendar' }).map((item) => item.id);
    assert.ok(inModule.includes(module.id));
    assert.ok(!inModule.includes(course.id), '作用域之间互不串台');
    // §10.3：module: 的作用域也跟着"当前视图"匹配
    assert.ok(ctx.memory.contextItems({ view: 'calendar' }).map((item) => item.id).includes(module.id));
  } finally {
    await ctx.cleanup();
  }
});

test('记忆：放不下时保首句（不从句中切断），首句也放不下就整条不进', async () => {
  const ctx = await makeService();
  try {
    const first = '我习惯晚上学习。我一般从十九点开始，两个小时一休息。';
    const item = (await ctx.memory.create({ text: first })).item;
    // 预算只够第一句（10 字 + 省略号）：截到首句并如实标注
    const clipped = await ctx.memory.inject({ maxItems: 8, maxChars: 11 });
    assert.equal(clipped.injected.length, 1);
    assert.equal(clipped.injected[0].id, item.id);
    assert.equal(clipped.injected[0].text, '我习惯晚上学习。…');
    assert.equal(clipped.injected[0].truncated, true);
    assert.equal(clipped.truncated, true);

    // 首句都放不下 → 整条不进（半句话进提示词会被模型当完整结论用）
    const tiny = await ctx.memory.inject({ maxItems: 8, maxChars: 5 });
    assert.deepEqual(tiny.injected, []);
    assert.equal(tiny.truncated, true);

    // 调用方要"要么进要么不进"的二元语义时，关掉首句保留即可
    const binary = await ctx.memory.inject({ maxItems: 8, maxChars: 11, keepFirstSentence: false });
    assert.deepEqual(binary.injected, []);
    assert.equal(binary.truncated, true);

    // 没有句末标点的正文永远不会被从中间切开
    const plain = await makeService();
    try {
      await plain.memory.create({ text: textOf(50, '丁') });
      const cut = await plain.memory.inject({ maxItems: 8, maxChars: 20 });
      assert.equal(cut.injected.length, 0, '没有完整首句就不进');
    } finally {
      await plain.cleanup();
    }
    assert.equal(firstSentence('我习惯晚上学习。第二句'), '我习惯晚上学习。');
    assert.equal(firstSentence('没有标点的一句话'), '没有标点的一句话');
  } finally {
    await ctx.cleanup();
  }
});

test('记忆：注入后异步回报命中（useCount / lastUsedAt），失败不影响返回', async () => {
  const now = new Date('2026-10-12T09:00:00+08:00');
  const ctx = await makeService({ now: () => now });
  try {
    const item = (await ctx.memory.create({ text: '我习惯晚上学习' })).item;
    assert.equal(item.useCount, 0);
    assert.equal(item.lastUsedAt, null);

    const result = await ctx.memory.inject({});
    assert.equal(result.injected.length, 1, '返回同步完成，不等落盘');
    await ctx.memory.flush();
    const after = ctx.memory.get(item.id);
    assert.equal(after.useCount, 1, '§10.7：命中即回报');
    assert.equal(after.lastUsedAt, now.toISOString());

    const used = await ctx.memory.markUsed(item.id, { count: 3 });
    assert.equal(used.useCount, 4);
    await assert.rejects(() => ctx.memory.markUsed('nope'), (error) => error.status === 404);
  } finally {
    await ctx.cleanup();
  }
});

// ---------------------------------------------------------------- 提议 / 生命周期

test('记忆：propose 只给草稿、绝不落库，且草稿形状与 §4.2 的指令对象一致', async () => {
  const ctx = await makeService();
  try {
    const result = ctx.memory.propose({
      scope: 'global',
      kind: 'preference',
      key: 'preferred_study_window',
      text: '我习惯晚上 19:00 之后安排学习任务',
      value: { from: '19:00' },
      confidence: 0.72,
    });
    assert.equal(result.writes, false, '§10.5：这个接口永远不会写库');
    assert.equal(result.draft.target, 'memory');
    assert.equal(result.draft.action, 'create');
    assert.equal(result.draft.ok, true);
    assert.equal(result.draft.fields.source, 'ai', '确认后落库才能是"模型提议"（§10.2）');
    assert.equal(result.draft.confidence, 0.72);
    assert.ok(result.draft.explain.includes('我习惯晚上'));
    assert.equal(ctx.store.memories.all().length, 0, '提议之后库里必须还是空的');
    // 提议也不许绕过敏感信息拦截：模型想记密码，一样 400
    assert.throws(
      () => ctx.memory.propose({ text: '我的教务密码是 abcd1234' }),
      (error) => error.status === 400 && error.details.reason === 'sensitive_content',
    );
  } finally {
    await ctx.cleanup();
  }
});

test('记忆：rejected 是负记忆 —— 同一 scope+key 绝不重提；已 active 等价的也不重提', async () => {
  const ctx = await makeService();
  try {
    const item = (
      await ctx.memory.create({ scope: 'global', kind: 'constraint', key: 'wednesday_afternoon_busy', text: '我周三下午不方便' })
    ).item;

    // 已 active 且内容等价 → 不提
    const duplicate = ctx.memory.propose({ scope: 'global', kind: 'constraint', key: 'wednesday_afternoon_busy', text: '我周三下午不方便' });
    assert.equal(duplicate.suppressed, 'duplicate');
    assert.equal(duplicate.draft, null);

    // 已 active 但内容不同 → 照常给草稿，并提醒会和谁冲突（让用户选，§10.5）
    const conflict = ctx.memory.propose({ scope: 'global', kind: 'constraint', key: 'wednesday_afternoon_busy', text: '我周三下午要上课' });
    assert.equal(conflict.draft.target, 'memory');
    assert.equal(conflict.conflicts[0].id, item.id);
    assert.match(conflict.draft.warnings.join(' '), /冲突/);

    // 用户否决 → 之后永远不再提
    await ctx.memory.update(item.id, { status: 'rejected' });
    const afterReject = ctx.memory.propose({ scope: 'global', kind: 'constraint', key: 'wednesday_afternoon_busy', text: '我周三下午要上课' });
    assert.equal(afterReject.suppressed, 'rejected');
    assert.equal(afterReject.draft, null);
    assert.match(afterReject.explain, /否决/);
    // 负记忆必须查得到（§10.4：提议前查 GET /memories?scope=&key=）
    assert.equal(ctx.memory.list({ scope: 'global', key: 'wednesday_afternoon_busy' }).items[0].status, 'rejected');
  } finally {
    await ctx.cleanup();
  }
});

test('记忆：生命周期迁移（archived 可恢复、rejected/superseded 不可逆为 active、改键不许撞车）', async () => {
  const ctx = await makeService();
  try {
    const item = (await ctx.memory.create({ text: '我习惯晚上学习', key: 'night_study' })).item;
    assert.equal((await ctx.memory.update(item.id, { status: 'archived' })).status, 'archived');
    assert.equal((await ctx.memory.update(item.id, { status: 'active' })).status, 'active', 'archived 可恢复');

    await ctx.memory.update(item.id, { status: 'rejected' });
    await assert.rejects(
      () => ctx.memory.update(item.id, { status: 'active' }),
      (error) => error.status === 409,
      'rejected 不可逆为 active（只能新建）',
    );

    // 改正字段
    const fixed = await ctx.memory.update(item.id, { text: '我习惯晚上 20:00 之后学习', kind: 'preference', reviewAt: '2027-01-15' });
    assert.equal(fixed.text, '我习惯晚上 20:00 之后学习');
    assert.equal(fixed.kind, 'preference');
    assert.equal(fixed.reviewAt, '2027-01-15');
    assert.equal(fixed.source, 'user');
    assert.equal(fixed.confidence, 1, '改正文不该动"用户说的"这个事实');

    // 已被取代的不能直接改回 active（会造出两条同键 active）
    const chain = await makeService();
    try {
      const old = (await chain.memory.create({ text: '我习惯早上学习', key: 'study_window' })).item;
      await chain.memory.create({ text: '我习惯晚上学习', key: 'study_window', replace: true });
      await assert.rejects(() => chain.memory.update(old.id, { status: 'active' }), (error) => error.status === 409);
    } finally {
      await chain.cleanup();
    }

    // 改 key 撞上另一条 active → 409，而不是静默造出重复
    const holder = (await ctx.memory.create({ text: '我习惯晚上学习', key: 'night_study' })).item;
    const other = (await ctx.memory.create({ text: '我周三下午不方便', key: 'wed_busy' })).item;
    await assert.rejects(
      () => ctx.memory.update(other.id, { key: 'night_study' }),
      (error) => error.status === 409 && error.details.existing.id === holder.id,
    );

    // 改正文时同样要过敏感信息与长度校验
    await assert.rejects(() => ctx.memory.update(item.id, { text: textOf(201) }), (error) => error.status === 400);
    await assert.rejects(() => ctx.memory.update(item.id, { text: '我的教务密码是 abcd1234' }), (error) => error.details.reason === 'sensitive_content');

    assert.equal((await ctx.memory.remove(other.id)).deleted, true);
    // get() 是同步的：同步抛出的错误要用 assert.throws（assert.rejects 会把它原样抛出来）
    assert.throws(() => ctx.memory.get(other.id), (error) => error.status === 404);
    await assert.rejects(() => ctx.memory.remove('不存在'), (error) => error.status === 404);
    await assert.rejects(() => ctx.memory.update('不存在', { text: '随便' }), (error) => error.status === 404);
    await assert.rejects(() => ctx.memory.markUsed('不存在'), (error) => error.status === 404);
  } finally {
    await ctx.cleanup();
  }
});

test('记忆：清空先备份（memories.json.bak-<时间戳>），文件里真的空了', async () => {
  const ctx = await makeService();
  try {
    await ctx.memory.create({ text: '我习惯晚上学习' });
    await ctx.memory.create({ text: '我周三下午不方便' });
    const result = await ctx.memory.clear();
    assert.equal(result.deleted, 2);
    assert.ok(result.backup && fs.existsSync(result.backup), '清空必须留下备份（§10.8）');
    assert.match(path.basename(result.backup), /^memories\.json\.bak-/);
    const backup = JSON.parse(fs.readFileSync(result.backup, 'utf8'));
    assert.equal(backup.items.length, 2, '备份里要有被删掉的那两条');
    assert.equal(ctx.store.memories.all().length, 0);

    // 空库清空是幂等的，不该报错、也不该造一个空备份
    const again = await ctx.memory.clear();
    assert.equal(again.deleted, 0);
    assert.equal(again.backup, null);
  } finally {
    await ctx.cleanup();
  }
});

test('记忆：normalizeText 的口径（空白 / 标点 / 全角半角 / 大小写）', () => {
  assert.equal(normalizeText('我习惯晚上学习'), normalizeText('  我习惯晚上学习。 '));
  assert.equal(normalizeText('ABC 19:00'), normalizeText('abc 19：00'));
  assert.equal(normalizeText('我，周三；下午'), normalizeText('我周三下午'));
});
