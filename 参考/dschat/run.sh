#!/usr/bin/env bash
# DeepSeek Chat 启动脚本
set -e
cd "$(dirname "$0")"

# 候选解释器: 环境变量 PYTHON 优先, 其次是常见 macOS 安装路径
CANDIDATES=()
if [ -n "${PYTHON:-}" ]; then
  CANDIDATES+=("$PYTHON")
fi
CANDIDATES+=("/usr/local/bin/python3" "python3")

# 优先选择已安装 openai 的解释器
PYTHON=""
for c in "${CANDIDATES[@]}"; do
  if command -v "$c" >/dev/null 2>&1 && "$c" -c "import openai" >/dev/null 2>&1; then
    PYTHON="$c"
    break
  fi
done

# 若没有已装 openai 的解释器, 回退到第一个可用的
if [ -z "$PYTHON" ]; then
  for c in "${CANDIDATES[@]}"; do
    if command -v "$c" >/dev/null 2>&1; then
      PYTHON="$c"
      break
    fi
  done
fi

if [ -z "$PYTHON" ]; then
  echo "错误: 未找到可用的 Python 3"
  exit 1
fi

echo "使用 Python: $PYTHON ($($PYTHON --version 2>&1))"

# 依赖检查与安装
if ! "$PYTHON" -c "import openai" >/dev/null 2>&1; then
  echo "正在安装依赖 openai ..."
  "$PYTHON" -m pip install --user openai || {
    echo "警告: 依赖安装失败, 尝试继续启动 (若报错请手动安装: $PYTHON -m pip install openai)"
  }
fi

echo "启动 DeepSeek Chat ..."
exec "$PYTHON" chattest.py
