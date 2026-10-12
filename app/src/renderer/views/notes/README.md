# 笔记系统前端挂载层

本目录实现笔记入口、摘要展示、独立 Markdown 编辑页、日历挂载和随手拍衔接。正文与附件由后端 `notes` 模块或外部 Provider 持有，浏览器摘要缓存不保存正文。

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

应用左侧不再单列“随手拍”占位页；随手拍统一位于笔记系统。内置 Provider 使用摄像头/相册文件输入创建 `source: snapshot` 的未整理笔记；外部程序仍可通过 `notes.ingestSnapshot(summary)` 投递安全摘要。

本地缓存最多 100 条、有效期 7 天，只保存摘要白名单字段；主程序始终是唯一事实源。

Provider 声明 `markdown: true` 后，详情区会显示“查看笔记”。查看弹层复用仓库内置的 `kit/richtext.js`（支持公式与安全 SVG），正文只短暂存在于弹层内存中，不写入摘要状态或本地缓存。

## 手动上传与查看

- 声明 `upload: true` 并实现 `uploadNotes(files, input)` 后开放“手动上传”。`files` 是浏览器原始 `File[]`，`input` 只包含可选标题、标签与日历挂载；Provider 必须返回一个摘要、摘要数组或 `{ items }`。本模块不读取、复制或缓存文件内容。
- 声明 `view: true` 并实现 `readNote(noteId)` 后开放“查看笔记”。返回字符串，或 `{ format: 'markdown | text', text }`。为兼容旧 Provider，`markdown: true + renderMarkdown(noteId)` 仍可提供查看能力。
- 查看内容仅存在于当前弹层。Markdown 经过 `PCRichText` 安全渲染，`text` 使用纯文本展示，Provider 返回的 HTML 不会直接注入页面。
- 默认上传限制：单次最多 8 个文件、单文件 6 MB、合计 10 MB；支持 Markdown、文本、HTML、PDF、DOCX、PPTX 和常见图片。PDF 与图片可在网页内预览；DOCX/PPTX 会提取正文为 Markdown，PDF 同时尽力提取可搜索文本。旧版 DOC/PPT 只保留下载入口。

## AI 读取挂载点

Provider 声明 `aiRead: true` 并实现 `readNotesForAI({ ids, query, limit })` 后，AI 编排层可以调用：

```js
const notes = PCModules.getService('notes');
const context = await notes.readForAI({ ids: ['note-id'], limit: 5 });
```

返回项仅保留 `id、title、format、text、tags、anchor、updatedAt`。入口最多接收 20 个 ID、最多返回 20 条，每条正文最多 200,000 字符；Provider 应在这里完成当前用户授权检查和必要脱敏。调用结果只返回给本次 AI 上下文，不并入 `state.items`，也不进入 `localStorage`。未声明能力时调用会明确失败，防止 AI 默认读取全部私人笔记。

当前仓库自带默认 Provider：进入笔记页时自动连接 `/api/v1/notes`，正文和附件由主程序的 `notes` 模块保存在 `app/data/notes.json`。AI 模块通过只读指令目标 `note` 查询正文；前端仍只缓存摘要。

## 独立 Markdown 编辑页

内置 Provider 声明 `edit: true` 并实现 `openNote(id)`；“新建笔记”和“编辑笔记”进入 `editor.html`，不再在摘要弹层中编辑。外部 Provider 沿用自己的 `openNote` 与创建流程。

- 左侧编辑、右侧实时预览，复用 `PCRichText` 的 Markdown / LaTeX 子集；窄屏上下展示。
- 新建使用 `POST /api/v1/notes`；已有笔记通过 `PATCH /api/v1/notes/:id` 保存，支持标题、正文、标签、格式及状态，携带 `expectedUpdatedAt` 检测冲突。
- 原有附件、来源和日历关联保留；正文不进入浏览器缓存。
- 紧凑顶栏直接编辑标题；标签、附件说明和外观选项收进“属性”，不占用常驻标题区。
- 支持源码行号与配色、撤销 / 重做、分栏 / 阅读切换、Ctrl / Cmd + S、Tab 缩进、常用格式工具（含表格）、同步滚动、未保存提醒；失败后保留当前输入。
- 主页面与编辑页共用白天 / 夜间 / 跟随系统偏好。

## Obsidian 式知识工作区

- 正文支持 `[[标题]]`、`[[标题#章节]]` 与 `[[标题|显示文字]]`；保存时生成出链，详情接口提供反向链接和未链接提及。
- 笔记具备目录、别名、收藏和学习属性（课程、章节、类型、状态、掌握程度、复习日期）；搜索支持 `tag:`、`folder:`、`course:`、`type:`、`status:` 与排除词。
- 笔记首页提供局部/全局知识图谱、表格/卡片/看板、每日笔记、内置学习模板、回收站和 Canvas。
- 自动保存采用 800ms 防抖；服务端最多保留每篇 50 个版本，自动保存快照间隔不少于 5 分钟，手动保存、重命名和删除强制留档。
- 删除默认为软删除；永久删除只能对回收站中的笔记执行。

新增接口包括 `GET /notes/graph`、`GET /notes/:id/links`、`GET /notes/:id/versions`、`POST /notes/:id/restore`，以及 `/note-templates`、`/note-views`、`/note-canvases` 资源组。旧 `notes.json` 会在读取时补齐新字段，不需要破坏性迁移。
