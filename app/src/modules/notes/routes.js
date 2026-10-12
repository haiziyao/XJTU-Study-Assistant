export function registerNoteRoutes(router, { services, apiPrefix = '/api/v1' }) {
  const P = `${apiPrefix}/notes`;
  const notes = services.notes;

  router.get(P, ({ query }) => ({ items: notes.list(query) }));
  router.get(`${P}/graph`, ({ query }) => notes.graph(query));
  router.post(`${P}/daily`, async ({ body }) => ({ summary: await notes.daily(body?.date) }));
  router.post(`${P}/ai-context`, ({ body }) => ({ items: notes.queryForAI(body ?? {}) }));
  router.post(P, async ({ body }) => ({ __status: 201, summary: await notes.create(body ?? {}) }));
  router.get(`${P}/:id/links`, ({ params }) => notes.links(params.id));
  router.get(`${P}/:id/versions`, ({ params }) => ({ items: notes.versions(params.id) }));
  router.post(`${P}/:id/versions/:versionId/restore`, async ({ params }) => ({ summary: await notes.restoreVersion(params.id, params.versionId) }));
  router.post(`${P}/:id/restore`, async ({ params }) => ({ summary: await notes.restore(params.id) }));
  router.get(`${P}/:id`, ({ params, query }) => ({ note: notes.get(params.id, { includeDeleted: query.deleted === 'true' }) }));
  router.patch(`${P}/:id`, async ({ params, body }) => ({ summary: await notes.update(params.id, body ?? {}) }));
  router.delete(`${P}/:id`, ({ params, query }) => notes.remove(params.id, { permanent: query.permanent === 'true' }));

  const T = `${apiPrefix}/note-templates`;
  router.get(T, () => ({ items: notes.templates() }));
  router.post(T, async ({ body }) => ({ __status: 201, item: await notes.createTemplate(body ?? {}) }));
  router.post(`${T}/:id/instantiate`, async ({ params, body }) => ({ __status: 201, summary: await notes.instantiateTemplate(params.id, body ?? {}) }));
  router.patch(`${T}/:id`, async ({ params, body }) => ({ item: await notes.updateTemplate(params.id, body ?? {}) }));
  router.delete(`${T}/:id`, ({ params }) => notes.removeTemplate(params.id));

  for (const [path, kind] of [['note-views', 'views'], ['note-canvases', 'canvases']]) {
    const R = `${apiPrefix}/${path}`;
    router.get(R, () => ({ items: notes.listResource(kind) }));
    router.post(R, async ({ body }) => ({ __status: 201, item: await notes.createResource(kind, body ?? {}) }));
    router.get(`${R}/:id`, ({ params }) => ({ item: notes.getResource(kind, params.id) }));
    router.patch(`${R}/:id`, async ({ params, body }) => ({ item: await notes.updateResource(kind, params.id, body ?? {}) }));
    router.delete(`${R}/:id`, ({ params }) => notes.removeResource(kind, params.id));
  }
}
