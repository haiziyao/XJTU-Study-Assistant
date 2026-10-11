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
  // 可选：searchNotes、renderMarkdown、exportNote、retryProcessing、subscribe
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

Provider 声明 `markdown: true` 后，详情区会显示 Markdown 预览。预览复用仓库内置的 `kit/richtext.js`（支持公式与安全 SVG），正文只短暂存在于弹层内存中，不写入摘要状态或本地缓存。
