# XJTU-Study-Assistant

西安交通大学「AI 智学」程序 —— 一个**框架 + 可插拔功能模块**的学习助理。
后端 Node.js（零运行时依赖），前端提供 Electron 测试窗口与浏览器页面；已接入日历/待办与思源学堂。

## 仓库结构

| 目录 | 说明 |
| --- | --- |
| [`app/`](app/) | **应用本体**：框架（`src/core`）+ 功能模块（`src/modules`）+ 前端（`src/renderer`） |
| [`参考/`](参考/) | 参考实现（dschat 2，Python），只读，不作为运行依赖 |

## 快速开始

```bash
cd app

npm run start:server          # 只跑后端（零运行时依赖，推荐联调）
# 浏览器打开 http://127.0.0.1:3210/app

npm test                      # 全部用例（53 个，含前端加载自检）

npm install && npm run dev:app   # Electron 测试窗口（可选，需下载 ~130MB 运行时）
```

后端不需要 `npm install` 就能跑通全部接口与页面 —— Electron 只是可选的外壳。

## 加一个功能

**新增一个功能 = 新建一个目录 + 新建一个文件**，不需要修改框架代码：

```
app/src/modules/<你的模块>/module.js      # 后端：模块描述符（框架靠目录扫描发现它）
app/src/renderer/views/<你的模块>.js      # 前端：PCModules.register 自我登记
app/src/renderer/views/<你的模块>.css     # 样式（类名加模块前缀）
app/test/<你的模块>.test.js               # 测试（npm test 自动收录）
```

登记处只有两行：`app/src/renderer/index.html` 里加一个 `<script>` 和一个 `<link>`。

- 📘 **[模块开发指南](app/docs/模块开发指南.md)** —— 契约、示例、清单、常见错误（**动手前必读**）
- 📗 [接口文档](app/docs/接口文档.md) —— 数据模型、REST、WebSocket、AI 接入契约
- 📙 [app/README.md](app/README.md) —— 架构与设计要点
- 📕 [CHANGELOG](app/CHANGELOG.md)

## 当前模块

| 模块 | 能力 |
| --- | --- |
| `calendar` | 日历事件 + 日程（时段）+ 提醒 + 结构化重复 + 顺延 + ICS 导出 + 中文指令添加 |
| `lms` | 思源学堂：统一身份认证登录、课程/作业/直播拉取、预览后同步到日历、自动同步 |
| 框架级 | 三栏测试界面、对话指令（自然语言 → 草稿确认 → 落库）、指令日志、设置、AI 接入契约 |
| 规划中 | 学情 / 拍题 / 网课（左栏已占位，实现同名视图即自动接管） |

## 开发约定

1. `app/src/core/` 与 `app/src/shared/` 是**框架层**，功能开发不要去改。
2. 自己的功能全部放进 `app/src/modules/<你的模块>/` 与 `app/src/renderer/views/<你的模块>.js`。
3. 两个人不会改到同一个文件 —— 这是本仓库的结构目标，请一起维护它。
