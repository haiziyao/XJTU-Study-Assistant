import { NoteService } from './service.js';
import { createNoteCommands } from './commands.js';
import { registerNoteRoutes } from './routes.js';

const AI_PROMPT = `【笔记】
- 可以用只读指令 {"ok":true,"action":"query","target":"note","filters":{"query":"关键词","ids":["可选 id"],"limit":10}} 查询用户笔记。
- 只有用户问题确实需要笔记内容时才查询；不得声称看过未返回的笔记，也不得创建、修改或删除笔记。
- 图片笔记（随手拍）的正文 text 常常是空的，字在图片里，识别结果在 **ocr** 字段：
  {"ok":true,"text":"识别出的文字","chars":120,"engine":"macos-vision","at":"时间"}。
  · ocr.ok === true 且 ocr.text 非空 → 那就是这张照片上的字，**直接用它回答**；不要说"正文是空的""图我看不到"。
  · ocr.ok === false 时按 ocr.error 如实说明，别编造图片内容：
    pending → "这张图还在识别中，稍等一下再问我"；ocr_unavailable → "这台机器上还没装好本地识别（macOS Vision），图里的字暂时读不出来"；
    no_text → "图里没识别到文字"；bad_image → "这个附件不是可识别的图片"；timeout / failed → "识别没成功，可以点重新识别再试"。
  · 识别是在本机做的，图片没有上传到任何地方；识别不了的包括手写体、竖排文字和表格结构。
- **绝不许因为 text 为空就说"这篇笔记里面没有内容"**：正文空但有 ocr.text 是有内容的；正文空且识别提示失败，
  要如实说"图里的字没读出来"，而不是"里面没有内容"。`;

export default {
  id: 'notes',
  title: '笔记',
  order: 40,
  collections: [
    { name: 'notes', file: 'notes.json' },
    { name: 'noteVersions', file: 'note-versions.json' },
    { name: 'noteTemplates', file: 'note-templates.json' },
    { name: 'noteViews', file: 'note-views.json' },
    { name: 'noteCanvases', file: 'note-canvases.json' },
  ],
  aiPrompt: AI_PROMPT,
  // 回灌给模型的字段。`ocr` = 图片笔记的文字识别结果（`{ok,text,chars,engine,at,error?}`，见 ocr.js）：
  // 没有它，随手拍笔记在模型眼里就只是一条"正文为空"的记录。
  aiQueryFields: { note: ['id', 'title', 'format', 'text', 'ocr', 'tags', 'folder', 'aliases', 'properties', 'links', 'anchor', 'updatedAt'] },
  aiTools: [{
    name: 'notes_query',
    description: '按 ID 或关键词只读查询用户笔记，返回标题、正文、标签和日历关联',
    method: 'POST',
    path: '/notes/ai-context',
    requiresAuth: false,
    mutates: false,
    implemented: true,
    params: { ids: 'string[]?', query: 'string?', limit: 'number?' },
    returns: { items: 'NoteAIContext[]' },
  }],

  createServices({ store, broadcast, services, dataDir, options }) {
    // `options.notes.ocr`：测试注入假识别引擎用（真实运行不传，走本机 Vision，见 ocr.js）
    // services/audit：写笔记时记一条 actor:'user' 的更改日志（AI 写由 chat-service 记）。
    const notes = new NoteService({ store, broadcast, dataDir, recognize: options?.ocr, services, audit: services.audit });
    services.commands.registerHandler('note', createNoteCommands({ notes }));
    return { notes };
  },

  registerRoutes(router, ctx) {
    registerNoteRoutes(router, ctx);
  },
};
