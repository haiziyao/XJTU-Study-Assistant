/**
 * 指令 target `pomodoro` 的处理器（`services.commands.registerHandler('pomodoro', ...)`）。
 *
 * **读是统计，写是控制**：
 * - `query` 只读，口径与 GET /status、周报完全相同（today / week / all）；
 * - `create` = 开始 / 重开（正在跑时先 `stop()` 把当前阶段按既有语义记进账本，再 `start()`）；
 * - `update.fields.op` = 控制：`pause | resume | skip | stop | setTask`；
 * - `delete` 等价于 `stop`（不造第二套语义）。
 *
 * 为什么写动作现在必须存在：用户真机说「帮我重开一下番茄钟，一轮后我去吃饭」，
 * 旧版只能回"启动这一步得你手点"——而用户要的正是不用动手。番茄钟的写操作全都是
 * 幂等的服务方法，模型给草稿、权限层决定 manual 确认卡 / auto 直接执行，命令层不特判权限。
 *
 * 两个刻意保留的边界：
 * - **未开始时 pause/resume/skip 必须 400**，不能静默成功：用户听到"已暂停"却发现计时
 *   根本没开始，会以为计时器坏了；错误里带当前 phase，模型/界面都能据此说清"现在是 idle"。
 * - **stop 在 idle 是成功的 no-op**：停止的语义是"确保它不在跑"，本来就不在跑就已经满足。
 *
 * 返回形状与其它 target 一致：`{ ok, action, target, explain, ... }`；
 * 开始/控制还会给出 `phase / endsAt / taskTitle / round`，让模型不必再查一次状态。
 */

import { HttpError } from '../../core/http/router.js';

const RANGES = ['today', 'week', 'all'];
const OPS = ['pause', 'resume', 'skip', 'stop', 'setTask'];

/**
 * 每个 op 允许出现的 fields 键（`op` 本身除外）。
 *
 * 多出来的键一律 400，而不是"忽略它"：模型把 `taskId` 塞进 `pause` 里，
 * 通常说明它想表达的是 setTask —— 静默丢掉会让它以为换任务已经生效。
 */
const OP_FIELDS = Object.freeze({
  pause: [],
  resume: [],
  skip: [],
  stop: [],
  setTask: ['taskId'],
});

const PHASE_LABEL = Object.freeze({ idle: '未开始', study: '专注', break: '休息' });
const labelOf = (phase) => PHASE_LABEL[phase] ?? String(phase ?? '未知');

function rangeOf(draft) {
  const raw = draft?.filters?.range ?? draft?.fields?.range ?? 'today';
  const range = typeof raw === 'string' ? raw.trim().toLowerCase() : 'today';
  if (!RANGES.includes(range)) {
    throw HttpError.badRequest(`字段 range 不合法：取值必须是 today / week / all 之一`, { field: 'range', value: raw });
  }
  return range;
}

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value ?? {}, key);

/** 本地时刻 HH:MM（endsAt 是 ISO/UTC，给用户看必须换成这台机器的本地时间）。 */
function clockText(iso) {
  const date = new Date(String(iso ?? ''));
  if (!Number.isFinite(date.getTime())) return null;
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** 分钟数说人话：45 / 1.5（不把 45.0 摆给用户看）。 */
function minutesText(sec) {
  // 先换成"十分之一分钟"再取整：45.0 -> 45，1.5 -> 1.5
  return String(Math.round((Number(sec) || 0) / 6) / 10);
}

/** 剩余时长说人话：不足一分钟给秒，超过就给"12 分 34 秒"。 */
function remainingText(sec) {
  const total = Math.max(0, Math.round(Number(sec) || 0));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes ? `${minutes} 分 ${seconds} 秒` : `${seconds} 秒`;
}

/** 控制类回执的公共字段：模型据此就能直接回答，不用再查一次 /status。 */
function controlPayload(op, after, explain, extra = {}) {
  return {
    op,
    phase: after.phase,
    running: after.running,
    remainingSec: after.remainingSec,
    endsAt: after.endsAt,
    taskId: after.taskId,
    taskTitle: after.taskTitle,
    round: after.round,
    explain,
    ...extra,
  };
}

/** 开始 / 重开的说明文案：manual 档的确认卡与 auto 档的回执共用同一套措辞。 */
function startExplain(status, { restarted = false, dryRun = false } = {}) {
  const minutes = minutesText(status.totalSec);
  const end = clockText(status.endsAt);
  const task = status.taskTitle ? `，关联「${status.taskTitle}」` : '';
  if (dryRun) {
    // 这一句是给确认卡用的：用户点下去计时会**立刻**开始，不能让他以为是"预约"。
    return restarted
      ? `将重开 ${minutes} 分钟专注${task}：先把当前阶段按实际时长记入账本，再开始新一轮，约 ${end} 结束（点确认后立刻开始计时）`
      : `将开始 ${minutes} 分钟专注${task}，约 ${end} 结束（点确认后立刻开始计时）`;
  }
  return restarted
    ? `已重开 ${minutes} 分钟专注${task}（上一段已按实际时长记入账本），约 ${end} 结束，计时已开始`
    : `已开始 ${minutes} 分钟专注${task}，约 ${end} 结束，计时已开始`;
}

/** 控制类操作的说明文案（op + 操作前后状态）。 */
function controlExplain(op, before, after, { dryRun = false, already = false } = {}) {
  if (op === 'stop') {
    if (already) return '番茄钟当前未开始（idle），停止是空操作';
    const actualSec = Math.max(0, (Number(before.totalSec) || 0) - (Number(before.remainingSec) || 0));
    return dryRun
      ? `将停止本轮${labelOf(before.phase)}（实际 ${actualSec} 秒会记入不完整会话），回到未开始`
      : `已停止本轮${labelOf(before.phase)}（实际 ${actualSec} 秒已记入不完整会话），回到未开始`;
  }
  if (op === 'pause') {
    return dryRun
      ? `将暂停${labelOf(before.phase)}，剩余 ${remainingText(after.remainingSec)}`
      : `已暂停${labelOf(before.phase)}，剩余 ${remainingText(after.remainingSec)}（点继续接着走）`;
  }
  if (op === 'resume') {
    const end = clockText(after.endsAt);
    return dryRun ? `将继续${labelOf(after.phase)}，约 ${end} 结束` : `已继续${labelOf(after.phase)}，约 ${end} 结束`;
  }
  if (op === 'skip') {
    const tail = after.running ? `，约 ${clockText(after.endsAt)} 结束` : '（已暂停，点继续开始）';
    return dryRun
      ? `将跳过本轮${labelOf(before.phase)}，进入${labelOf(after.phase)}${tail}`
      : `已跳过本轮${labelOf(before.phase)}，进入${labelOf(after.phase)}${tail}`;
  }
  // setTask
  if (dryRun) return after.taskTitle ? `将切换关联待办为「${after.taskTitle}」` : '将解除关联待办';
  return after.taskTitle ? `已切换关联待办为「${after.taskTitle}」` : '已解除关联待办';
}

export function createPomodoroCommands({ pomodoro }) {
  /**
   * 控制的唯一实现：update 与 delete 共用，保证"删除"不会变成第二套停止语义。
   *
   * `fields` 已经过 op/键白名单校验；这里只做：
   *   1. 读一次现状（错误文案要说"当前处于什么状态"，也需要 stop 前的阶段名）；
   *   2. dryRun 走 `previewControl`（与真写同一套纯状态函数，不落库）；
   *   3. 真写调对应服务方法；idle 的 stop 不调服务，直接返回 `{ already: 'idle' }`。
   */
  async function runControl(op, fields, options = {}) {
    const before = await pomodoro.status();
    const dryRun = options.dryRun === true;
    // 预览也要能回答"现在是 idle，不能暂停"——所以先走 previewControl 再决定返回。
    const preview = pomodoro.previewControl({ op, taskId: fields.taskId });

    if (op === 'stop' && before.phase === 'idle') {
      // idle 的停止是成功的空操作：目标状态（不在跑）已经满足，不该给用户/模型一个错误。
      const explain = controlExplain('stop', before, preview, { dryRun, already: true });
      return controlPayload('stop', preview, explain, {
        already: 'idle',
        ...(dryRun ? { dryRun: true, planned: { action: 'update', target: 'pomodoro', fields: { op } } } : { status: before }),
      });
    }

    if (dryRun) {
      return controlPayload(op, preview, controlExplain(op, before, preview, { dryRun: true }), {
        dryRun: true,
        planned: { action: 'update', target: 'pomodoro', fields: { op, ...(op === 'setTask' ? { taskId: fields.taskId } : {}) } },
      });
    }

    let status;
    if (op === 'pause') status = await pomodoro.pause();
    else if (op === 'resume') status = await pomodoro.resume();
    else if (op === 'skip') status = await pomodoro.skip();
    else if (op === 'stop') status = await pomodoro.stop();
    else if (op === 'setTask') status = await pomodoro.setTask({ taskId: fields.taskId });

    return controlPayload(op, status, controlExplain(op, before, status), { status });
  }

  return {
    async query(draft) {
      const range = rangeOf(draft);
      const result = await pomodoro.query({ range });
      return {
        filters: { range },
        count: 1,
        items: [result],
        summary: result,
        explain: result.explain,
      };
    },

    /**
     * `create` = 开始 / 重开。
     *
     * 重开为什么**先 stop 再 start**：
     * - 账本是"已经发生的会话"，当前阶段已经专注的秒数必须按既有语义先结算（一条
     *   `completed:false` 的部分会话），否则这段投入会凭空消失；
     * - `startState` 在非 idle 时本来就会 409（"先停止当前会话再开始"）。重开若绕过它直接
     *   改状态，就等于把"停止语义"复制到了指令层 —— 停止怎么写账、怎么广播全由服务层决定，
     *   这里只能调用它，不能另写一份。
     *
     * 校验为什么在 stop 之前：`taskId` 不存在 / `studyMin` 越界时，若先停了当前番茄再报 400，
     * 用户会平白丢掉正在跑的那一段。`previewStart` 与真写共用状态机校验，先跑它再动手。
     */
    async create(draft, options = {}) {
      const fields = draft?.fields ?? {};
      if (fields.reset !== undefined && typeof fields.reset !== 'boolean') {
        throw HttpError.badRequest('字段 reset 不合法：必须是布尔值', { field: 'reset', value: fields.reset });
      }
      const dryRun = options.dryRun === true;
      const before = await pomodoro.status();
      // `reset:true` 与"当前正在跑时再 create"都表示重开；idle 时两者都等价于普通开始
      const beforeActive = before.phase !== 'idle';
      const hasTask = hasOwn(fields, 'taskId');
      // 不给 taskId 时沿用当前关联（重开要把待办带过去）；显式 null/'' 才是"解除关联"
      const taskId = hasTask ? fields.taskId : before.taskId;
      const input = { taskId };
      if (fields.studyMin !== undefined) input.studyMin = fields.studyMin;
      if (fields.breakMin !== undefined) input.breakMin = fields.breakMin;

      // 先校验（含待办存在性与分钟数），通过后才允许停掉当前阶段
      const preview = pomodoro.previewStart(input);
      const explain = startExplain(preview, { restarted: beforeActive, dryRun });

      if (dryRun) {
        return {
          dryRun: true,
          restarted: beforeActive,
          phase: preview.phase,
          running: preview.running,
          remainingSec: preview.remainingSec,
          endsAt: preview.endsAt,
          taskId: preview.taskId,
          taskTitle: preview.taskTitle,
          round: preview.round,
          planned: { action: 'create', target: 'pomodoro', fields },
          preview,
          explain,
        };
      }

      // 正在跑：先把当前阶段按既有语义结算进账本，再开新一轮（"重开"）
      if (beforeActive) await pomodoro.stop();
      const status = await pomodoro.start(input);
      return {
        restarted: beforeActive,
        phase: status.phase,
        running: status.running,
        remainingSec: status.remainingSec,
        endsAt: status.endsAt,
        taskId: status.taskId,
        taskTitle: status.taskTitle,
        round: status.round,
        status,
        explain: startExplain(status, { restarted: beforeActive }),
      };
    },

    /**
     * `update` = 控制。
     *
     * 幂等/状态校验的口径：
     * - 未开始时 pause/resume/skip 由状态机抛 400（错误里带当前 phase），不吞；
     * - 运行中再次 pause、暂停中再次 resume 同样 400，避免"看起来成功但什么都没变"；
     * - 只有 stop 在 idle 视为成功 no-op（返回 `already:'idle'`）—— 停止的目标就是"不在跑"。
     */
    async update(draft, options = {}) {
      const fields = draft?.fields ?? {};
      const rawOp = fields.op;
      const normalizedOp = typeof rawOp === 'string' ? rawOp.trim().toLowerCase() : '';
      // op 名是驼峰（setTask），比较时忽略大小写，但落库/回执里保留规范写法
      const op = OPS.find((item) => item.toLowerCase() === normalizedOp);
      if (!op) {
        throw HttpError.badRequest(
          `字段 op 不合法：必须是 ${OPS.join(' / ')} 之一（开始/重开请用 action=create）`,
          { field: 'op', allowed: OPS, value: rawOp },
        );
      }
      const allowed = new Set(['op', ...OP_FIELDS[op]]);
      const extra = Object.keys(fields).filter((key) => !allowed.has(key));
      if (extra.length) {
        throw HttpError.badRequest(`op=${op} 不接受字段：${extra.join('、')}`, { field: extra[0], op, allowed: [...allowed] });
      }
      if (op === 'setTask' && !hasOwn(fields, 'taskId')) {
        throw HttpError.badRequest('op=setTask 需要 fields.taskId（传 null 表示解除关联）', { field: 'taskId', op });
      }
      return runControl(op, fields, options);
    },

    /**
     * `delete` 等价于 `stop`：同一个 `runControl('stop')`，不复制停止逻辑。
     *
     * 为什么允许 delete 落到 stop：模型有时会把"结束/删掉这个计时"表达成 delete，
     * 直接 400 只会让它绕回来说一堆"没有这个能力"；而停止本身就是最接近的语义。
     * 账本里的历史会话不会被删除 —— 删除的只是"正在跑的这一轮"。
     */
    async delete(draft, options = {}) {
      const result = await runControl('stop', {}, options);
      // 预览里仍然报 action=delete（虽然执行走的是同一个 stop）：确认卡要显示用户点的是哪件事
      if (result.planned) result.planned = { ...result.planned, action: 'delete' };
      return result;
    },
  };
}
