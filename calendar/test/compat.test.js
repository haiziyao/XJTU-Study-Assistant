/**
 * dschat 2 兼容层测试：标记行解析、字段别名、ICS 导出。
 * 运行：npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { parseMarkup } from '../src/server/parser/markup-parser.js';
import { fromDschatEvent, normalizeLooseDate, repeatFromDschat, toDschatEvent } from '../src/server/services/compat.js';
import { buildIcs, toRrule } from '../src/server/services/ics-service.js';
import { createServer } from '../src/server/index.js';

async function startApp() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'potato-calendar-compat-'));
  const app = await createServer({ dataDir });
  const info = await app.listen({ port: 0 });
  const call = async (method, route, body, raw = false) => {
    const response = await fetch(`${info.baseUrl}${route}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (raw) return { status: response.status, contentType: response.headers.get('content-type'), text: await response.text() };
    return { status: response.status, body: await response.json() };
  };
  return { app, info, call };
}

test('宽松日期归一化与 dschat 2 一致', () => {
  assert.equal(normalizeLooseDate('2026-9-1'), '2026-09-01');
  assert.equal(normalizeLooseDate('2026/09/01'), '2026-09-01');
  assert.equal(normalizeLooseDate('2026年9月1日'), '2026-09-01');
  assert.equal(normalizeLooseDate('20260901'), '2026-09-01');
  assert.equal(normalizeLooseDate('无'), undefined);
});

test('扁平重复字段映射为结构化 repeat', () => {
  assert.deepEqual(repeatFromDschat({ repeat: 'weekly', repeat_interval: 2, repeat_end: '2026-12-31' }), {
    type: 'weekly',
    interval: 2,
    weekdays: [],
    until: { mode: 'date', date: '2026-12-31' },
  });
  assert.equal(repeatFromDschat({ repeat: '每2周' }).interval, 2);
  assert.equal(repeatFromDschat({ repeat: '每天' }).type, 'daily');
  assert.equal(repeatFromDschat({ repeat: '乱写' }).type, 'none');
});

test('dschat 2 单日事件转换为本项目字段', () => {
  const { target, fields } = fromDschatEvent({
    title: '每周例会',
    date: '2026-09-20',
    start_time: '10:00',
    end_time: '11:00',
    location: '三教101',
    repeat: 'weekly',
    repeat_interval: 2,
    repeat_end: '2026-12-31',
  });
  assert.equal(target, 'schedule');
  assert.equal(fields.date, '2026-09-20');
  assert.equal(fields.startTime, '10:00');
  assert.equal(fields.allDay, false);
  assert.equal(fields.repeat.interval, 2);
  assert.equal(fields.source, 'import');

  // 全天事件（无时刻）
  const allDay = fromDschatEvent({ title: '放假', date: '2026-10-01', all_day: 1 });
  assert.equal(allDay.fields.allDay, true);
  assert.equal(allDay.fields.startTime, undefined);
});

test('反向转换输出 dschat 2 的 snake_case 形状', () => {
  const record = {
    id: 'abc',
    title: '项目周会',
    description: '备注',
    date: '2026-09-20',
    startTime: '10:00',
    endTime: '11:00',
    allDay: false,
    repeat: { type: 'weekly', interval: 2, weekdays: [1], until: { mode: 'date', date: '2026-12-31' } },
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  };
  const out = toDschatEvent(record);
  assert.equal(out.start_time, '10:00');
  assert.equal(out.all_day, false);
  assert.equal(out.repeat, 'weekly');
  assert.equal(out.repeat_interval, 2);
  assert.equal(out.repeat_end, '2026-12-31');
});

test('标记行解析：新增日程 / 删除日程 / 新增待办 / 新增学期', () => {
  const { drafts, unparsed } = parseMarkup(
    [
      '[新增日程] 每周例会 | 2026-09-20 | 10:00 | 11:00 | 三教101 | 每2周 | 2026-12-31',
      '[新增日程] 数学考试 | 2026-09-30 | 09:00 | 11:00 | 三教101 | 无 | 无',
      '[删除日程] 每周例会',
      '[新增待办] 高数作业 | 高 | 2026-9-25 | 数学',
      '[新增学期] 2026 春 | 2026-02-23 | 18',
      '这一行不是标记行',
    ].join('\n'),
  );

  assert.equal(drafts.length, 5);
  assert.deepEqual(unparsed, ['这一行不是标记行']);

  assert.equal(drafts[0].fields.repeat.interval, 2);
  assert.equal(drafts[0].fields.repeat.until.date, '2026-12-31');
  assert.equal(drafts[1].fields.allDay, false);
  assert.equal(drafts[1].fields.repeat, undefined);
  assert.equal(drafts[2].action, 'delete');
  assert.equal(drafts[2].filters.keyword, '每周例会');
  assert.equal(drafts[3].fields.allDay, true);
  assert.equal(drafts[3].fields.priority, 2);
  assert.equal(drafts[3].fields.date, '2026-09-25');
  assert.deepEqual(drafts[3].fields.tags, ['数学']);
  assert.equal(drafts[4].target, 'event');
  assert.equal(drafts[4].fields.startDate, '2026-02-23');
  // 18 周 = 125 天（含起始日），2026-02-23 + 125 天 = 2026-06-28
  assert.equal(drafts[4].fields.endDate, '2026-06-28');
});

test('RRULE 生成（含 BYDAY / UNTIL / COUNT）', () => {
  assert.equal(toRrule({ type: 'weekly', interval: 2, weekdays: [1, 3], until: { mode: 'date', date: '2026-12-31' } }), 'FREQ=WEEKLY;BYDAY=MO,WE;INTERVAL=2;UNTIL=20261231T235959Z');
  assert.equal(toRrule({ type: 'daily', interval: 1, until: { mode: 'count', count: 10 } }), 'FREQ=DAILY;COUNT=10');
  assert.equal(toRrule({ type: 'weekday' }), 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR');
  assert.equal(toRrule({ type: 'none' }), undefined);
});

test('ICS 导出为合法文本且包含 VEVENT 与 RRULE', async () => {
  const { app, call } = await startApp();
  try {
    await call('POST', '/schedules', {
      title: '每周例会',
      date: '2026-09-20',
      startTime: '10:00',
      endTime: '11:00',
      location: '三教101',
      repeat: { type: 'weekly', interval: 2, weekdays: [7], until: { mode: 'date', date: '2026-12-31' } },
    });
    await call('POST', '/events', { title: '国庆假期', startDate: '2026-10-01', endDate: '2026-10-07', category: 'holiday' });

    const ics = await call('GET', '/ics', undefined, true);
    assert.equal(ics.status, 200);
    assert.match(ics.contentType, /text\/calendar/);
    assert.match(ics.text, /BEGIN:VCALENDAR/);
    assert.equal((ics.text.match(/BEGIN:VEVENT/g) ?? []).length, 2);
    assert.match(ics.text, /RRULE:FREQ=WEEKLY;BYDAY=SU;INTERVAL=2;UNTIL=20261231T235959Z/);
    // 全天事件按 RFC 5545 使用次日作为开区间结束
    assert.match(ics.text, /DTSTART;VALUE=DATE:20261001/);
    assert.match(ics.text, /DTEND;VALUE=DATE:20261008/);
  } finally {
    await app.close();
  }
});

test('dschat 2 兼容接口：写入、查询、按标题删除', async () => {
  const { app, call } = await startApp();
  try {
    const created = await call('POST', '/compat/dschat/events', {
      title: '每周例会',
      date: '2026-09-20',
      start_time: '10:00',
      end_time: '11:00',
      repeat: 'weekly',
      repeat_interval: 2,
      repeat_end: '2026-12-31',
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.target, 'schedule');

    const listed = await call('GET', '/compat/dschat/events');
    assert.equal(listed.body.events.length, 1);
    assert.equal(listed.body.events[0].start_time, '10:00');
    assert.equal(listed.body.events[0].repeat_interval, 2);

    const removed = await call('POST', '/compat/dschat/events/delete', { title: '每周例会' });
    assert.equal(removed.body.deleted, 1);
    const after = await call('GET', '/compat/dschat/events');
    assert.equal(after.body.events.length, 0);
  } finally {
    await app.close();
  }
});

test('标记行接口端到端：一次提交多条并返回逐条结果', async () => {
  const { app, call } = await startApp();
  try {
    const result = await call('POST', '/commands/markup', {
      text: [
        '[新增日程] 每周例会 | 2026-09-20 | 10:00 | 11:00 | 三教101 | 每2周 | 2026-12-31',
        '[新增待办] 高数作业 | 高 | 2026-09-25 | 数学',
        '[删除日程] 不存在的日程',
      ].join('\n'),
    });
    assert.equal(result.body.drafts.length, 3);
    assert.equal(result.body.succeeded, 2);
    assert.equal(result.body.failed, 1);
    assert.equal(result.body.failed >= 1, true);

    const agenda = await call('GET', '/schedules/agenda?date=2026-09-25');
    assert.equal(agenda.body.allDay.length, 1);
    assert.equal(agenda.body.allDay[0].title, '高数作业');
  } finally {
    await app.close();
  }
});

test('接口层也接受宽松日期与 snake_case 字段', async () => {
  const { app, call } = await startApp();
  try {
    const created = await call('POST', '/schedules', {
      title: '宽松日期测试',
      date: '2026年9月1日',
      start_time: '9:00',
      end_time: '10:00',
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.item.date, '2026-09-01');
    assert.equal(created.body.item.startTime, '09:00');
  } finally {
    await app.close();
  }
});

test('buildIcs 可直接用于文件导出', () => {
  const ics = buildIcs({
    events: [{ id: 'e1', title: '考试;重要,', startDate: '2026-01-05', endDate: '2026-01-05', category: 'exam' }],
    schedules: [{ id: 's1', title: '晨读', date: '2026-01-06', startTime: '07:00', endTime: '07:30', allDay: false, status: 'pending' }],
  });
  assert.match(ics, /SUMMARY:考试\\;重要\\,/);
  assert.match(ics, /UID:e1@potato-calendar/);
  assert.match(ics, /UID:s1@potato-calendar/);
  assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
});

test('CORS 预检与响应头：允许浏览器直接打开测试页面联调', async () => {
  const { app, info } = await startApp();
  try {
    const preflight = await fetch(`${info.baseUrl}/schedules`, {
      method: 'OPTIONS',
      headers: { Origin: 'null', 'Access-Control-Request-Method': 'POST' },
    });
    assert.equal(preflight.status, 204);
    assert.ok(preflight.headers.get('access-control-allow-origin'));

    const response = await fetch(`${info.baseUrl}/health`, { headers: { Origin: 'null' } });
    assert.ok(response.headers.get('access-control-allow-origin'));
    assert.ok(response.headers.get('access-control-allow-methods').includes('PATCH'));
  } finally {
    await app.close();
  }
});

test('测试页面由后端托管（/app），无需 Electron 也能联调', async () => {
  const { app, info } = await startApp();
  const origin = info.baseUrl.replace(/\/api\/v1$/, '');
  const getRaw = async (route) => {
    const response = await fetch(`${origin}${route}`);
    return { status: response.status, contentType: response.headers.get('content-type'), text: await response.text() };
  };
  try {
    const page = await getRaw('/app');
    assert.equal(page.status, 200);
    assert.match(page.contentType, /text\/html/);
    assert.match(page.text, /Potato Calendar/);

    const script = await getRaw('/app/app.js');
    assert.match(script.contentType, /javascript/);
    assert.match(script.text, /resolveInfo/);

    const style = await getRaw('/app/styles.css');
    assert.match(style.contentType, /text\/css/);

    const notAllowed = await getRaw('/app/../package.json');
    assert.notEqual(notAllowed.status, 200);
  } finally {
    await app.close();
  }
});
