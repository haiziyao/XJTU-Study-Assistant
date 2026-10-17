/**
 * 局域网直传：集合目录与**写入适配**。
 *
 * 这个文件只回答两个问题：
 *   1. 协议里的一个集合名（`notes` / `todos` / …）对应本地哪个 JsonStore 集合、界面上叫什么；
 *   2. 收到对面的记录时，**用谁的服务**把它写进来。
 *
 * 硬规则（AGENTS/契约都写了，这里再强调一次）：
 *   - **读**别人的集合可以直接 `store.<collection>.all()`（只读、无副作用）；
 *   - **写**必须走对方模块自己的服务（`services.notes.create` 之类），
 *     否则校验、广播、指令日志、索引全被绕过 —— 一处直接改文件，另一处的索引就永久不一致；
 *   - 某个集合**没有可用的写入口**时：`importable: false`，接收侧跳过并如实回报原因
 *     （目前只有「对话 / 消息」，见下面 conversations / messages 的说明）。
 *
 * 一个必须说清楚的边界（写进 README 与传输页）：
 *   各模块的 `create()` 都**不接受外部指定的 id**（id 由集合层生成），也不认识 `origin` 字段。
 *   所以「同 id 不同内容 → 新 id 加 `-from-<短id>` 后缀」这条，落地方式是：
 *   本地新记录的 id 由它自己的模块生成，**远端 id ↔ 本地 id 的对应关系记在传输模块的幂等账本里**
 *   （`data/transfer-log.json`，见 service.js），账本里同时保存 `alias`（`<远端id>-from-<短id>`）
 *   与 `origin`（设备名），并在传输页与结果明细里显示。这样既没有绕过模块写库，
 *   又让"这条是从哪台设备的哪条记录来的"始终可查、可回溯。
 */

/** 传输页上的分组顺序 = 这个数组的顺序（对话在前，与左栏习惯一致）。 */
export const COLLECTION_ORDER = [
  'conversations',
  'messages',
  'memories',
  'notes',
  'todos',
  'schedules',
  'events',
  'cards',
  'goals',
];

/** 空字符串/空白统一成「没有名字」，避免同名判定被空格骗过去。 */
const nameOf = (value) => String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * 集合目录。
 *
 * 字段说明：
 *   collection   本地 JsonStore 集合名（`module.js` 的 collections 声明）
 *   label        界面上的中文名
 *   importable   接收侧能不能写（false 时必须在 reason 里写清"为什么"）
 *   reason       不能写 / 特殊处理的原因（会原样显示给用户）
 *   project      从远端记录里挑出**可写字段**（模块自己的校验只认这些键）
 *   create       调用拥有该集合的模块服务写入；返回 `{ record, duplicated?, conflict? }`
 *   verify       写入后回查一次，用于发现"模块按自己的上限截断了"这类静默失真
 *   remove       「疑似重复清单」里的"删除本机这条"：同样走模块自己的删除入口
 *   title        结果明细里怎么称呼这条记录
 *   duplicateKey 「同名」判定的键（§8.1：不同 id 但标题/正文相同 → 两条都留 + 疑似重复清单）
 *   sendFilter   发送时哪些记录不该带走
 */
export const COLLECTIONS = {
  conversations: {
    collection: 'aiConversations',
    label: '对话',
    importable: false,
    reason:
      '「对话」只有"新建空会话"这一个入口，历史消息必须由模型调用产生（ai 模块没有写回消息的接口）。只建一个空壳会把"传过去了"变成假象，所以接收侧跳过这一项。',
    title: (item) => item.title || item.id,
    duplicateKey: (item) => nameOf(item.title),
  },

  messages: {
    collection: 'aiMessages',
    label: '消息',
    importable: false,
    reason: '消息挂在对话下面，且由 ai 模块在真实对话时写入；没有独立写入口，接收侧跳过。',
    title: (item) => String(item.content ?? '').slice(0, 40) || item.id,
    duplicateKey: null,
  },

  memories: {
    collection: 'memories',
    label: '记忆',
    importable: true,
    reason: '同 scope+key 冲突时**不自动取代**：并存的第二条会带上 `-from-<设备>` 的 key，冲突列进清单让你自己选。',
    title: (item) => item.text,
    duplicateKey: (item) => nameOf(item.text),
    project(item) {
      return {
        scope: item.scope,
        kind: item.kind,
        key: item.key,
        text: item.text,
        value: item.value,
        // 远端来源照实带过来（user / ai / import）；模块自己的校验会再兜一层
        source: item.source === 'ai' || item.source === 'import' ? item.source : 'import',
        confidence: item.confidence,
        reviewAt: item.reviewAt,
      };
    },
    async create({ services }, fields, meta) {
      // §8.1：记忆 scope+key 冲突 → **不自动取代**。memory.create 见到同键 active 条会 409
      //（这是它的正确行为：它不替用户决定），所以这里先查一次，冲突时把 key 加上来源后缀，
      // 让两条事实并存、都可检索；取代与否交给用户（传输页的冲突清单）。
      const existing = fields.key ? services.memory.activeByKey(fields.scope, fields.key) : null;
      if (existing && nameOf(existing.text) !== nameOf(fields.text)) {
        // 注意 key 的**语法**由记忆模块说了算：只能是小写字母/数字/下划线、≤40 字符。
        // 所以这里用 `_from_<短id>`（不是 id 后缀那种 `-from-`）：不符合语法的 key 会被
        // 模块自己 400 掉，那样这一条就整条收不下来了。base 太长时截断，保证加完后缀仍在 40 字内。
        const suffix = `_from_${meta.deviceShortId}`;
        const base = String(fields.key).slice(0, Math.max(1, 40 - suffix.length));
        // 同一台设备反复冲突（极少）时再退让一步：加序号，避免第二次直接 409
        let key = `${base}${suffix}`;
        for (let index = 2; index <= 9 && services.memory.activeByKey(fields.scope, key); index += 1) {
          key = `${base.slice(0, Math.max(1, 40 - suffix.length - 2))}${suffix}_${index}`;
        }
        const result = await services.memory.create({ ...fields, key });
        return {
          record: result.item,
          conflict: { kind: 'scope+key', existingId: existing.id, existingText: existing.text, existingKey: existing.key, newKey: key },
        };
      }
      const result = await services.memory.create(fields);
      return { record: result.item, duplicated: result.duplicated === true };
    },
    /** 清理疑似重复项时用：走模块自己的删除入口（它负责广播与状态约束）。 */
    remove({ services }, id) {
      return services.memory.remove(id);
    },
  },

  notes: {
    collection: 'notes',
    label: '笔记',
    importable: true,
    reason: '笔记模块的正文上限是 20 万字：超过的部分会被它自己截断，截断情况会写进结果明细（不静默）。',
    title: (item) => item.title,
    duplicateKey: (item) => nameOf(item.title),
    // 软删除的笔记不跟着走：用户在另一台机器上删掉的东西，不该被这次传输"复活"
    sendFilter: (item) => !item.deletedAt,
    project(item) {
      return {
        title: item.title,
        body: item.body,
        tags: item.tags,
        folder: item.folder,
        aliases: item.aliases,
        properties: item.properties,
        favorite: item.favorite,
        format: item.format,
        status: item.status,
        attachments: item.attachments,
        source: 'import',
      };
    },
    create({ services }, fields) {
      return services.notes.create(fields).then((summary) => ({ record: summary }));
    },
    async remove({ services }, id) {
      await services.notes.remove(id);
      return { id, deleted: true };
    },
    /** 写入后回查正文长度：模块截断了就如实报出来（用户至少要能发现自己的笔记短了）。 */
    verify({ services }, record, item) {
      const wanted = String(item.body ?? '').length;
      const saved = services.notes.get(record.id, { includeDeleted: true });
      const got = String(saved?.body ?? '').length;
      if (got < wanted) return { truncated: { field: 'body', wanted, got } };
      return null;
    },
  },

  todos: {
    collection: 'todos',
    label: '待办',
    importable: true,
    title: (item) => item.title,
    duplicateKey: (item) => nameOf(item.title),
    project(item) {
      return {
        title: item.title,
        deadline: item.deadline,
        estimatedHours: item.estimatedHours,
        priority: item.priority,
        description: item.description,
        tags: item.tags,
        completed: item.completed,
        // **分类可以传，父子关系不能传**：接收侧是走 `todos.create()` 落库的，**会生成新 id**，
        // 而 `parentId` 指向的是发送端的 id —— 直接搬过去必然悬空，被服务层以 PARENT_NOT_FOUND 拒掉，
        // 表现就是"子任务传过去以后没了"（比丢分类更糟，所以宁可显式不传）。
        // 要支持带层级传输，得在接收侧做"发送端 id → 新 id"的重映射（同一 bundle 内父先子后），
        // 那是另一件事，见 README 的说明。
        category: item.category ?? '',
        completedAt: item.completedAt ?? null,
        source: 'import',
      };
    },
    create({ services }, fields) {
      return services.todos.create(fields).then((record) => ({ record }));
    },
    remove({ services }, id) {
      return services.todos.remove(id);
    },
  },

  schedules: {
    collection: 'schedules',
    label: '日程',
    importable: true,
    title: (item) => item.title,
    // "同名"对日程来说必须是"同名 + 同一时段"：重复的 08:00 线性代数才是真的重复
    duplicateKey: (item) => `${nameOf(item.title)}@${item.date ?? ''} ${item.startTime ?? ''}`,
    project(item) {
      return {
        title: item.title,
        date: item.date,
        startTime: item.startTime,
        endTime: item.endTime,
        description: item.description,
        location: item.location,
        category: item.category,
        priority: item.priority,
        estimatedMinutes: item.estimatedMinutes,
        tags: item.tags,
        reminders: item.reminders,
        repeat: item.repeat,
        source: 'import',
      };
    },
    create({ services }, fields) {
      return services.schedules.create(fields).then((record) => ({ record }));
    },
    remove({ services }, id) {
      return services.schedules.remove(id);
    },
  },

  events: {
    collection: 'events',
    label: '事件',
    importable: true,
    title: (item) => item.title,
    duplicateKey: (item) => `${nameOf(item.title)}@${item.startDate ?? ''}`,
    project(item) {
      return {
        title: item.title,
        startDate: item.startDate,
        endDate: item.endDate,
        description: item.description,
        category: item.category,
        allDay: item.allDay,
        color: item.color,
        tags: item.tags,
        repeat: item.repeat,
        source: 'import',
      };
    },
    create({ services }, fields) {
      return services.events.create(fields).then((record) => ({ record }));
    },
    remove({ services }, id) {
      return services.events.remove(id);
    },
  },

  cards: {
    collection: 'cards',
    label: '卡片',
    importable: true,
    title: (item) => item.front,
    duplicateKey: (item) => nameOf(item.front),
    project(item) {
      return {
        front: item.front,
        back: item.back,
        tags: item.tags,
        course: item.course,
        // 复习进度（due / ease / reps…）**不跟着传**：它是"我复习到哪了"，
        // 跟着数据走会让另一台机器的复习计划被悄悄改掉；调度从零开始，由模块自己定。
        // source 只能是 note / manual / ai，所以这里固定 manual。
        source: 'manual',
      };
    },
    create({ services }, fields) {
      return services.cards.create(fields).then((record) => ({ record }));
    },
    remove({ services }, id) {
      return services.cards.remove(id);
    },
  },

  goals: {
    collection: 'goals',
    label: '目标',
    importable: true,
    title: (item) => item.title,
    duplicateKey: (item) => nameOf(item.title),
    project(item) {
      return {
        title: item.title,
        kind: item.kind,
        course: item.course,
        targetDate: item.targetDate,
        status: item.status,
        progress: item.progress,
        milestones: item.milestones,
        priority: item.priority,
        note: item.note,
        remindDays: item.remindDays,
        source: 'import',
      };
    },
    create({ services }, fields) {
      return services.goals.create(fields).then((record) => ({ record }));
    },
    remove({ services }, id) {
      return services.goals.remove(id);
    },
  },
};

/**
 * 只出现在界面上的「不传」项（§8.1：成绩隐私最重，默认且始终不勾选）。
 *
 * 为什么连接收也一起关掉：成绩是学业模块从教务处同步来的**只读投影**，
 * 它没有 create/update 入口（写入口只会污染下一次同步的幂等键）；
 * 而且用户口径就是"成绩不传"。
 */
export const EXCLUDED = {
  grades: {
    collection: 'academicGrades',
    label: '成绩',
    sendable: false,
    importable: false,
    reason: '成绩隐私最重（§8.1），默认且始终不参与传输；需要时请用学业模块自己的导出。',
  },
};

/** 协议里认识的集合名（发送端选集合、接收端防脏键都用它）。 */
export const COLLECTION_NAMES = COLLECTION_ORDER.filter((name) => Boolean(COLLECTIONS[name]));

/** 给传输页/接口用的目录（含"不能传/不能收"的原因，界面直接照着显示）。 */
export function catalog() {
  return [
    ...COLLECTION_NAMES.map((name) => {
      const entry = COLLECTIONS[name];
      return {
        name,
        collection: entry.collection,
        label: entry.label,
        sendable: true,
        importable: entry.importable === true,
        reason: entry.reason ?? null,
      };
    }),
    { name: 'grades', collection: EXCLUDED.grades.collection, label: '成绩', sendable: false, importable: false, reason: EXCLUDED.grades.reason },
  ];
}

/** 取一个集合的目录项；未知集合返回 null（调用方负责跳过）。 */
export function entryOf(name) {
  return COLLECTIONS[String(name ?? '')] ?? null;
}
