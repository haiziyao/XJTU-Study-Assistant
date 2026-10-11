import { NoteService } from './service.js';
import { createNoteCommands } from './commands.js';
import { registerNoteRoutes } from './routes.js';

const AI_PROMPT = `【笔记】
- 可以用只读指令 {"ok":true,"action":"query","target":"note","filters":{"query":"关键词","ids":["可选 id"],"limit":10}} 查询用户笔记。
- 只有用户问题确实需要笔记内容时才查询；不得声称看过未返回的笔记，也不得创建、修改或删除笔记。`;

export default {
  id: 'notes',
  title: '笔记',
  order: 40,
  collections: [{ name: 'notes', file: 'notes.json' }],
  aiPrompt: AI_PROMPT,
  aiQueryFields: { note: ['id', 'title', 'format', 'text', 'tags', 'anchor', 'updatedAt'] },
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

  createServices({ store, broadcast, services }) {
    const notes = new NoteService({ store, broadcast });
    services.commands.registerHandler('note', createNoteCommands({ notes }));
    return { notes };
  },

  registerRoutes(router, ctx) {
    registerNoteRoutes(router, ctx);
  },
};
