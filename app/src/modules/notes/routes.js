export function registerNoteRoutes(router, { services, apiPrefix = '/api/v1' }) {
  const P = `${apiPrefix}/notes`;
  const notes = services.notes;

  router.get(P, ({ query }) => ({ items: notes.list(query) }));
  router.post(`${P}/ai-context`, ({ body }) => ({ items: notes.queryForAI(body ?? {}) }));
  router.post(P, async ({ body }) => ({ __status: 201, summary: await notes.create(body ?? {}) }));
  router.get(`${P}/:id`, ({ params }) => ({ note: notes.get(params.id) }));
  router.delete(`${P}/:id`, ({ params }) => notes.remove(params.id));
}
