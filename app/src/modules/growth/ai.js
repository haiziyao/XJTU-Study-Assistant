/**
 * AI 模块：DeepSeek（OpenAI 兼容协议）接入，**默认指向本机端点**。
 *
 * 三条不能破的规矩：
 * 1. **默认本地**：默认 baseUrl 是 `http://127.0.0.1:11434/v1`（Ollama），
 *    这样长期使用不产生任何调用费用；想用官方 API 再自己改。
 * 2. **永远降级**：连不上、超时、没配密钥、模型报错 —— 一律退到本地规则生成的
 *    简报与复盘，页面只会看到"本地生成"的标注，功能不会变成空白。
 * 3. **模型只出文字**：AI 不改任务、不写库。任务表单由规则引擎生成，
 *    AI 只负责"今天怎么打"的叙述与解读。
 *
 * 与 XJTU 的 AI 配置打通（本移植版的关键差异）
 * ------------------------------------------------
 * 源项目自己有一份 `data/ai-config.json`，密钥也存里面。移植后**不再独立存密钥**：
 *   1. 优先读 `services.ai`（`app/src/modules/ai/config.js` 的 `AiConfigStore`）。
 *      它已经合并了「设置里保存的 / 环境变量 / 启动参数」三层来源；
 *   2. `services.ai` 没有密钥时（例如本地 Ollama 端点），回落到成长模块自己的
 *      `growthSettings` 集合里 id='ai' 的记录 —— 这里**只放 baseUrl / model / enabled / temperature /
 *      timeoutMs，不放 apiKey**；
 *   3. `GET /growth/ai/status` 只回 `hasKey` 与末四位 `keyMask`，永远不回原值。
 *
 * 为什么以「有没有密钥」作为切换点，而不是「配置存不存在」：
 * `AiConfigStore.get()` 永远会补默认的 baseUrl/model，配置对象永远存在；
 * 如果按"存在"判断，成长模块的回落配置永远轮不到。以 key 为界也符合直觉：
 * 配了共享密钥就跟着主程序走；没配（本地模型）就用成长模块自己的端点。
 */

import { badRequest } from './errors.js';
import { doc } from './store-utils.js';
import { iso } from './time.js';

const DEFAULTS = {
  enabled: true,
  baseUrl: 'http://127.0.0.1:11434/v1',
  model: 'deepseek-r1:latest',
  // 注意：这里故意**没有 apiKey** —— 成长模块的集合里永不出现密钥字段
  temperature: 0.7,
  timeoutMs: 30000,
};

const MAX_TIMEOUT_MS = 600_000;

function trimSlash(url) {
  return String(url ?? '').replace(/\/+$/, '');
}

function maskKey(key) {
  if (!key) return '';
  return `***${String(key).slice(-4)}`;
}

/** 上游报错经常回显请求头 —— 把密钥从任意文本里抹掉再对外。 */
function redactSecret(text, secret) {
  const source = String(text ?? '');
  if (!secret) return source;
  return source.split(String(secret)).join('***');
}

/** 宽松布尔：设置页可能传 "true"/"1"/false。 */
function asBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const text = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'off'].includes(text)) return false;
  return fallback;
}

export function createAiService({ store, clock, services }) {
  // 只存非密钥字段；单文档语义由 store-utils 的 doc() 提供
  // 与提醒设置同集合、不同记录（id='ai'）：保存设置时 normalizeSettings 不会碰它，
  // 备份也能按源项目的 `ai-config` 文档名单独搬运。
  const configDoc = doc(store, 'growthSettings', DEFAULTS, 'ai');
  let lastProbe = null;

  async function readGrowthConfig() {
    return configDoc.read();
  }

  /**
   * 读主程序 AI 配置（密钥在这里，且**只在内存里用**）。
   * `config.get()` 是 AiConfigStore 的公开读取方式；`maskConfig()` 是降级兜底
   * （只有 hasKey 没有 key，此时无法真的调模型，但状态仍可显示）。
   */
  function readSharedConfig() {
    try {
      const raw = services?.ai?.config?.get?.();
      if (raw && typeof raw === 'object') return raw;
    } catch {
      /* 配置读不出来不影响降级 */
    }
    try {
      return services?.ai?.maskConfig?.() ?? null;
    } catch {
      return null;
    }
  }

  /** 合并出「这一次调用真正要用的配置」。 */
  async function resolveConfig() {
    const growth = await readGrowthConfig();
    const shared = readSharedConfig();
    const enabled = growth.enabled !== false;
    const timeoutMs = Number(growth.timeoutMs);
    const temperature = Number(growth.temperature);

    if (shared?.apiKey) {
      return {
        enabled,
        source: 'xjtu-ai',
        baseUrl: trimSlash(shared.baseUrl ?? DEFAULTS.baseUrl),
        model: String(shared.model ?? DEFAULTS.model),
        apiKey: String(shared.apiKey),
        temperature: Number.isFinite(Number(shared.temperature)) ? Number(shared.temperature) : DEFAULTS.temperature,
        timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : DEFAULTS.timeoutMs,
      };
    }

    const usingGrowthFallback = Boolean(growth.baseUrl || growth.model);
    return {
      enabled,
      source: usingGrowthFallback ? 'growth-settings' : 'default',
      baseUrl: trimSlash(growth.baseUrl || DEFAULTS.baseUrl),
      model: String(growth.model || DEFAULTS.model),
      // 本地端点通常不需要 key；需要 key 的官方端点请在 AI 设置里配（会走上面的分支）
      apiKey: '',
      temperature: Number.isFinite(temperature) ? temperature : DEFAULTS.temperature,
      timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : DEFAULTS.timeoutMs,
    };
  }

  async function listModels(cfg, { timeoutMs = 4000 } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${trimSlash(cfg.baseUrl)}/models`, {
        headers: cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {},
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const rows = Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : [];
      return rows.map((row) => row?.id ?? row?.name).filter(Boolean);
    } finally {
      clearTimeout(timer);
    }
  }

  async function resolveModel(cfg) {
    const wanted = String(cfg.model ?? '').trim();
    try {
      const list = await listModels(cfg, { timeoutMs: 4000 });
      if (!list.length) return wanted || DEFAULTS.model;
      if (wanted && list.includes(wanted)) return wanted;
      const deepseek = list.find((name) => /deepseek/i.test(name));
      return deepseek ?? list[0];
    } catch {
      return wanted || DEFAULTS.model;
    }
  }

  async function chat(messages, { timeoutMs } = {}) {
    const cfg = await resolveConfig();
    if (!cfg.enabled) throw new Error('AI 已关闭');
    const model = await resolveModel(cfg);
    const controller = new AbortController();
    const limit = timeoutMs ?? cfg.timeoutMs ?? DEFAULTS.timeoutMs;
    const timer = setTimeout(() => controller.abort(), limit);
    try {
      const res = await fetch(`${trimSlash(cfg.baseUrl)}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          temperature: cfg.temperature ?? DEFAULTS.temperature,
          stream: false,
          messages,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const detail = redactSecret(text, cfg.apiKey).slice(0, 200);
        throw new Error(`上游 ${res.status}${detail ? `：${detail}` : ''}`);
      }
      const json = await res.json();
      const content = json?.choices?.[0]?.message?.content;
      if (!content) throw new Error('上游没有返回内容');
      return { content: String(content).trim(), model, usage: json.usage ?? null };
    } finally {
      clearTimeout(timer);
    }
  }

  const SYSTEM = [
    '你是「成长」模块的作战参谋。用户把现实生活当成一款长期经营的游戏，你是那个懂他状态的参谋。',
    '说话要具体、克制、可执行：不喊口号，不列举泛泛的鸡汤，不给"多喝热水"这类无用建议。',
    '你只输出文字，不能修改任务清单，也不能替用户决定做什么。',
    '长度硬限制：不超过 220 字，纯文本，不要 Markdown 标题与列表符号。',
  ].join('\n');

  function contextBlock(payload) {
    return JSON.stringify(payload, null, 2);
  }

  async function maskedConfig() {
    const cfg = await resolveConfig();
    return {
      enabled: Boolean(cfg.enabled),
      baseUrl: cfg.baseUrl,
      model: cfg.model,
      hasKey: Boolean(cfg.apiKey),
      keyMask: maskKey(cfg.apiKey),
      source: cfg.source,
    };
  }

  return {
    readConfig: resolveConfig,
    localBriefing,
    localReview,

    async status() {
      const cfg = await resolveConfig();
      const shared = readSharedConfig();
      return {
        enabled: Boolean(cfg.enabled),
        baseUrl: cfg.baseUrl,
        model: cfg.model,
        hasKey: Boolean(cfg.apiKey),
        // 只回掩码：`***` + 末四位（没有 key 时是空串）
        keyMask: maskKey(cfg.apiKey),
        isLocal: /127\.0\.0\.1|localhost|::1/.test(String(cfg.baseUrl)),
        lastProbe,
        checkedAt: iso(clock.now()),
        source: cfg.source,
        // 主程序 AI 是否已配置共享密钥（前端据此提示"走主程序配置"）
        sharedConfigured: Boolean(shared?.apiKey),
      };
    },

    async probe() {
      const cfg = await resolveConfig();
      const started = Date.now();
      try {
        const models = await listModels(cfg, { timeoutMs: 5000 });
        lastProbe = {
          ok: true,
          at: iso(clock.now()),
          ms: Date.now() - started,
          models: models.slice(0, 20),
        };
      } catch (err) {
        lastProbe = { ok: false, at: iso(clock.now()), ms: Date.now() - started, error: err.message };
      }
      return lastProbe;
    },

    /**
     * 保存配置。
     *
     * 非密钥字段写进 `growthSettings` 的 id='ai' 记录（回落配置）；`apiKey` 绝不落成长集合：
     * 有 `services.ai` 就委托它保存（它自己写 0600 私有文件），没有就明确报错。
     * 共享配置**已有密钥**时，把 baseUrl/model/temperature 同步过去 ——
     * 否则用户改了成长模块的设置却仍被共享配置的旧地址接管，界面会"看起来没生效"。
     */
    async saveConfig(input = {}) {
      const current = await readGrowthConfig();
      const next = { ...current };
      if (input.baseUrl !== undefined) {
        const url = String(input.baseUrl).trim();
        if (!/^https?:\/\//.test(url)) throw badRequest('INVALID_FIELD', 'baseUrl 必须以 http:// 或 https:// 开头');
        next.baseUrl = trimSlash(url);
      }
      if (input.model !== undefined) next.model = String(input.model).trim() || DEFAULTS.model;
      if (input.enabled !== undefined) next.enabled = asBool(input.enabled, current.enabled !== false);
      if (input.temperature !== undefined) {
        next.temperature = Math.min(1.5, Math.max(0, Number(input.temperature) || 0));
      }
      if (input.timeoutMs !== undefined) {
        const timeoutMs = Number(input.timeoutMs);
        if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > MAX_TIMEOUT_MS) {
          throw badRequest('INVALID_FIELD', `timeoutMs 必须是 1000–${MAX_TIMEOUT_MS} 的整数`);
        }
        next.timeoutMs = Math.round(timeoutMs);
      }
      // 先把要委托给 AI 模块的补丁准备好：密钥校验失败时**不要**留下半截配置
      const shared = readSharedConfig();
      const sharedHasKey = Boolean(shared?.apiKey);
      const updateShared = services?.ai?.updateConfig;
      const sharedPatch = {};
      if (input.apiKey !== undefined) {
        const key = String(input.apiKey).trim();
        // 与源项目同款：空串 = 保持原值；`-` = 清除
        if (key === '-') sharedPatch.apiKey = '';
        else if (key) {
          if (typeof updateShared !== 'function') {
            throw badRequest(
              'INVALID_FIELD',
              '当前实例没有装配 AI 模块，无法保存密钥；请把密钥配在 AI 设置里（成长模块不存密钥）',
            );
          }
          sharedPatch.apiKey = key;
        }
      }
      if (sharedHasKey && input.baseUrl !== undefined) sharedPatch.baseUrl = next.baseUrl;
      if (sharedHasKey && input.model !== undefined) sharedPatch.model = next.model;
      if (sharedHasKey && input.temperature !== undefined) sharedPatch.temperature = next.temperature;
      // 这一次同时给了密钥（或本来就有）：baseUrl/model 也要跟着落到共享配置，
      // 否则密钥一存进去，调用立刻改走共享配置的旧地址 —— 用户会以为设置没生效。
      const gainingKey = typeof sharedPatch.apiKey === 'string' && sharedPatch.apiKey.length > 0;
      if (!sharedHasKey && gainingKey) {
        if (input.baseUrl !== undefined) sharedPatch.baseUrl = next.baseUrl;
        if (input.model !== undefined) sharedPatch.model = next.model;
        if (input.temperature !== undefined) sharedPatch.temperature = next.temperature;
      }

      await configDoc.set(next);
      if (typeof updateShared === 'function' && Object.keys(sharedPatch).length) {
        await updateShared.call(services.ai, sharedPatch);
      }

      lastProbe = null;
      return maskedConfig();
    },

    maskedConfig,

    /** 今日作战简报：AI 版，失败时由调用方用本地版兜底。 */
    async briefing(payload) {
      const messages = [
        { role: 'system', content: SYSTEM },
        {
          role: 'user',
          content:
            '这是我今天的现场数据，请给一段作战简报：先说今天适合干什么（依据状态），' +
            '再点出最该被保护的一件事，最后给一句能立刻执行的动作。\n\n' +
            contextBlock(payload),
        },
      ];
      const result = await chat(messages);
      return { ...result, source: 'ai' };
    },

    /** 今日复盘：AI 版。 */
    async review(payload) {
      const messages = [
        { role: 'system', content: SYSTEM },
        {
          role: 'user',
          content:
            '这是我今天的执行结果。写一段复盘：只讲证据（完成率、投入分钟、状态与产出的关系），' +
            '指出一个真实的偏差，最后给明天一条具体建议。不要夸奖，不要安慰。\n\n' +
            contextBlock(payload),
        },
      ];
      const result = await chat(messages);
      return { ...result, source: 'ai' };
    },

    /** 状态解读：AI 版。 */
    async interpret(payload) {
      const messages = [
        { role: 'system', content: SYSTEM },
        {
          role: 'user',
          content:
            '请把这份身体/精神状态的读数翻译成人话：最短板是什么、今天该避开什么、' +
            '哪一个小动作能最快把状态拉回来。\n\n' +
            contextBlock(payload),
        },
      ];
      const result = await chat(messages);
      return { ...result, source: 'ai' };
    },
  };
}

/** 本地简报（无 AI 时的兜底，纯规则，永远可用）。 */
export function localBriefing({ state, plan, tasks, character, overdue = [], insights = [] }) {
  const lines = [];
  if (!state) {
    lines.push('今天还没有录入状态。先花 30 秒把身体和精神填一下，任务表单才能按你的真实电量排。');
    return lines.join('');
  }
  const done = tasks.filter((task) => task.status === 'done').length;
  const modeText = { push: '推进日', steady: '稳态日', recover: '修复日' }[state.mode] ?? state.mode;
  lines.push(`今天是${modeText}（就绪度 ${state.score}，可投入约 ${state.capacity} 分钟）。`);
  if (state.mode === 'recover') {
    lines.push('状态偏低，别硬撑长任务：先做一条 5–15 分钟的小事把身体带起来，比空想计划有用。');
  } else if (state.mode === 'push') {
    lines.push('状态在线，把最硬的那件事放在今天最前面，趁电量足解决它。');
  } else {
    lines.push('按常规节奏推进即可，不用刻意加码，也不要放任自己躺平。');
  }
  if (overdue.length) {
    lines.push(`有 ${overdue.length} 条任务逾期，先处置最旧的那条「${overdue[0].title}」：补做、改期或放弃。`);
  }
  const first = tasks.find((task) => task.status === 'todo');
  if (first) lines.push(`下一个动作：${first.title}（约 ${first.estimateMin} 分钟）。`);
  else if (done > 0) lines.push('今天的任务都处理完了，剩下的时间属于恢复。');
  if (character?.streak >= 3) lines.push(`连续 ${character.streak} 天有产出，这条线值得保住。`);
  if (insights.length) lines.push(`这周的一个规律：${insights[0]}`);
  return lines.join('');
}

/** 本地复盘（无 AI 时的兜底）。 */
export function localReview({ state, tasks, stats }) {
  if (!stats.total) return '今天还没有任务记录，也就没有可复盘的东西。';
  const rate = Math.round((stats.done / stats.total) * 100);
  const parts = [`完成 ${stats.done}/${stats.total}（${rate}%），实际投入约 ${stats.minutesDone} 分钟。`];
  if (state) parts.push(`早上读数 ${state.score} 分、${state.mode} 模式。`);
  if (stats.todo > 0) parts.push(`还剩 ${stats.todo} 条没动，明天先决定是补做还是放弃，别一直挂着。`);
  if (rate >= 80) parts.push('完成率不错，注意别把明天的预算也提前用掉。');
  else if (rate < 40) parts.push('完成率偏低：要么今天的任务排多了，要么状态读数没被认真对待。明天先把任务条数减半试试。');
  return parts.join('');
}

export { DEFAULTS as AI_DEFAULTS };
