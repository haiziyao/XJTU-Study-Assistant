#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ChatTest — DeepSeek 网页聊天应用 (本地 Web 服务)

参考官方文档: https://api-docs.deepseek.com/zh-cn/

特性:
  - 多会话历史 (侧边栏, SQLite 持久化)
  - 图片输入 (deepseek-flash 视觉)
  - 流式输出 (SSE) + 思考过程单独展示
  - 独立设置页 (/settings)
  - Markdown + MathJax LaTeX + 代码高亮

运行: python3 chattest.py
访问: http://localhost:8799
"""

from app.server import main

if __name__ == "__main__":
    main()
