export function createNoteCommands({ notes }) {
  return {
    query(draft) {
      const filters = draft?.filters ?? {};
      const items = notes.queryForAI({
        ids: filters.ids ?? (filters.id ? [filters.id] : []),
        query: filters.query ?? filters.keyword ?? '',
        limit: filters.limit,
      });
      return {
        filters,
        count: items.length,
        items,
        explain: items.length ? `命中 ${items.length} 条笔记。` : '没有找到符合条件的笔记。',
      };
    },
  };
}
