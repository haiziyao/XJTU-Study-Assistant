# 笔记系统前端挂载层

本目录实现笔记入口、摘要展示、日历挂载和随手拍衔接。正文、Markdown、OCR、图片和附件由 AI 智学主程序持有，本模块不建立笔记后端集合。

## 接入

```js
const notes = PCModules.getService('notes');
await notes.connectProvider({
  cacheNamespace: '稳定的用户或工作区键',
  capabilities,
  listNotes,
  createDraft,
  openNote,
  startCapture,
  // 可选：uploadNotes、readNote、readNotesForAI、searchNotes、renderMarkdown、exportNote、retryProcessing、subscribe
});
```

摘要字段为 `id、title、source、status、anchor、tags、mediaCount、createdAt、updatedAt`；`previewText` 只在内存显示。

日历关联只接受：

```js
{ type: 'date', date: 'YYYY-MM-DD' }
{ type: 'schedule', scheduleId: '...', occurrenceDate: 'YYYY-MM-DD' }
```

独立随手拍入口调用 `notes.ingestSnapshot(summary)`。该入口拒绝正文、OCR、图片、附件、路径、Blob 和 Base64 数据。

本地缓存最多 100 条、有效期 7 天，只保存摘要白名单字段；主程序始终是唯一事实源。

Provider 声明 `markdown: true` 后，详情区会显示“查看笔记”。查看弹层复用仓库内置的 `kit/richtext.js`（支持公式与安全 SVG），正文只短暂存在于弹层内存中，不写入摘要状态或本地缓存。

## 手动上传与查看

- 声明 `upload: true` 并实现 `uploadNotes(files, input)` 后开放“手动上传”。`files` 是浏览器原始 `File[]`，`input` 只包含可选标题、标签与日历挂载；Provider 必须返回一个摘要、摘要数组或 `{ items }`。本模块不读取、复制或缓存文件内容。
- 声明 `view: true` 并实现 `readNote(noteId)` 后开放“查看笔记”。返回字符串，或 `{ format: 'markdown | text', text }`。为兼容旧 Provider，`markdown: true + renderMarkdown(noteId)` 仍可提供查看能力。
- 查看内容仅存在于当前弹层。Markdown 经过 `PCRichText` 安全渲染，`text` 使用纯文本展示，Provider 返回的 HTML 不会直接注入页面。
- 默认上传限制：单次最多 8 个文件、单文件 512 KB、合计 4 MB；支持 Markdown、文本、HTML、PDF、Word 和常见图片。限制用于适配本地 JSON API 的 1 MB 单请求上限；每个文件单独交给主程序保存。

## AI 读取挂载点

Provider 声明 `aiRead: true` 并实现 `readNotesForAI({ ids, query, limit })` 后，AI 编排层可以调用：

```js
const notes = PCModules.getService('notes');
const context = await notes.readForAI({ ids: ['note-id'], limit: 5 });
```

返回项仅保留 `id、title、format、text、tags、anchor、updatedAt`。入口最多接收 20 个 ID、最多返回 20 条，每条正文最多 200,000 字符；Provider 应在这里完成当前用户授权检查和必要脱敏。调用结果只返回给本次 AI 上下文，不并入 `state.items`，也不进入 `localStorage`。未声明能力时调用会明确失败，防止 AI 默认读取全部私人笔记。

当前仓库自带默认 Provider：进入笔记页时自动连接 `/api/v1/notes`，正文和附件由主程序的 `notes` 模块保存在 `app/data/notes.json`。AI 模块通过只读指令目标 `note` 查询正文；前端仍只缓存摘要。
