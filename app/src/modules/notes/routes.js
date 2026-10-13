import { HttpError } from '../../core/http/router.js';

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

  router.post(`${apiPrefix}/note-canvases/:id/ai-design`, async ({ params, body }) => {
    const canvas = notes.getResource('canvases', params.id);
    const node = (canvas.nodes || []).find((item) => item.id === body?.nodeId);
    if (!node) throw HttpError.notFound('找不到要美化的画布卡片');
    if (!services.ai?.complete) throw new HttpError(501, 'AI_UNAVAILABLE', 'AI 尚未配置，已改用本地画布建议');
    const compact = {
      canvas: canvas.name,
      card: { type: node.type, text: String(node.text || '').slice(0, 160), shape: node.shape || 'rounded', color: node.color || 'blue' },
      cards: (canvas.nodes || []).slice(0, 80).map((item) => ({ id: item.id, type: item.type, text: String(item.text || '').slice(0, 80), x: item.x, y: item.y })),
      edges: (canvas.edges || []).slice(0, 160).map((edge) => ({ from: edge.fromNode, to: edge.toNode, lineType: edge.lineType || 'curve' })),
    };
    const result = await services.ai.complete({
      system: '你是知识画布视觉设计助手。只返回一个 JSON 对象，不要 Markdown。字段为 shape(rounded|square|pill|hexagon)、color(blue|green|yellow|red|purple|gray)、lineType(curve|straight|elbow)、lineStyle(solid|dashed|dotted)、lineColor(blue|green|yellow|red|purple|gray)、lineWidth(2|3.5|5)、arrow(none|end|both)、advice。建议要简短、具体，兼顾知识层级与可读性。',
      user: `请为当前卡片提出美化方案，并给整个画布一条结构建议：${JSON.stringify(compact)}`,
      thinking: 'none',
      temperature: 0.2,
    });
    let parsed = {};
    try { parsed = JSON.parse(String(result.text || '').replace(/^```(?:json)?\s*|\s*```$/gi, '').trim()); } catch { parsed = { advice: String(result.text || '').trim() }; }
    const pick = (value, allowed, fallback) => allowed.includes(value) ? value : fallback;
    return {
      suggestion: {
        shape: pick(parsed.shape, ['rounded', 'square', 'pill', 'hexagon'], node.shape || 'rounded'),
        color: pick(parsed.color, ['blue', 'green', 'yellow', 'red', 'purple', 'gray'], node.color || 'blue'),
        lineType: pick(parsed.lineType, ['curve', 'straight', 'elbow'], 'curve'),
        lineStyle: pick(parsed.lineStyle, ['solid', 'dashed', 'dotted'], 'solid'),
        lineColor: pick(parsed.lineColor, ['blue', 'green', 'yellow', 'red', 'purple', 'gray'], 'blue'),
        lineWidth: [2, 3.5, 5].includes(Number(parsed.lineWidth)) ? Number(parsed.lineWidth) : 2,
        arrow: pick(parsed.arrow, ['none', 'end', 'both'], 'end'),
        advice: String(parsed.advice || '建议按知识层级排列卡片，并减少交叉连线。').slice(0, 600),
      },
      model: result.model,
    };
  });

  for (const [path, kind] of [['note-views', 'views'], ['note-canvases', 'canvases']]) {
    const R = `${apiPrefix}/${path}`;
    router.get(R, () => ({ items: notes.listResource(kind) }));
    router.post(R, async ({ body }) => ({ __status: 201, item: await notes.createResource(kind, body ?? {}) }));
    router.get(`${R}/:id`, ({ params }) => ({ item: notes.getResource(kind, params.id) }));
    router.patch(`${R}/:id`, async ({ params, body }) => ({ item: await notes.updateResource(kind, params.id, body ?? {}) }));
    router.delete(`${R}/:id`, ({ params }) => notes.removeResource(kind, params.id));
  }
}
