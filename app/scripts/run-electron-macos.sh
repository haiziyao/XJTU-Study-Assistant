#!/usr/bin/env bash
#
# 在 macOS 上启动 Electron 测试窗口（适配宿主沙箱环境）。
#
# 背景：本机环境里直接运行 node_modules 里的 Electron 二进制会在启动阶段
# 以 EXC_BREAKPOINT (SIGTRAP) 崩溃，原因是进程继承了宿主（DeepSeek Harness）的
# 沙箱 profile 与环境变量。经 LaunchServices（open 命令）启动的 app 由 launchd
# 赋予独立环境，可以正常运行；而 `open ... --args <app目录>` 的方式无法正确加载
# 未打包的应用，因此本脚本把应用（package.json + src）放进 Electron.app 的
# Contents/Resources/app 里，再用 open 启动，等价于一个已打包的应用。
#
# 用法：
#   bash scripts/run-electron-macos.sh
#   POTATO_ELECTRON_BUNDLE=/path/to/ElectronTest.app bash scripts/run-electron-macos.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC_APP="$ROOT/node_modules/electron/dist/Electron.app"
# 默认放在工作区内（宿主沙箱只允许写工作区；放 ~/Library 会被拒绝）
BUNDLE="${POTATO_ELECTRON_BUNDLE:-$ROOT/.electron-bundle/ElectronTest.app}"

if [ ! -d "$SRC_APP" ]; then
  echo "找不到 Electron 运行时：$SRC_APP" >&2
  echo "请先 npm install；若二进制下载失败，按 README「方式 B」用镜像安装。" >&2
  exit 1
fi

if [ ! -d "$BUNDLE" ]; then
  echo "首次运行：复制 Electron 运行时到"
  echo "  $BUNDLE"
  mkdir -p "$(dirname "$BUNDLE")"
  ditto "$SRC_APP" "$BUNDLE"
  xattr -cr "$BUNDLE" 2>/dev/null || true
  codesign --force --deep --sign - "$BUNDLE" >/dev/null 2>&1 || true
fi

APP_DIR="$BUNDLE/Contents/Resources/app"
rm -rf "$APP_DIR"
mkdir -p "$APP_DIR/data"
# 只同步运行所需文件，排除 node_modules / 本地数据 / 系统垃圾文件
(
  cd "$ROOT"
  tar --exclude='./node_modules' --exclude='./data' --exclude='./.git' --exclude='.DS_Store' \
    -cf - package.json src
) | (cd "$APP_DIR" && tar -xf -)

# 让打包进 .app 的测试窗口与项目共用同一份数据（主进程读取 data-dir.txt）
# POTATO_DATA_DIR 可以指定别处的数据目录，方便用假数据做演示而不污染真实数据
DATA_DIR="${POTATO_DATA_DIR:-$ROOT/data}"
mkdir -p "$DATA_DIR" "$APP_DIR"
printf '%s' "$DATA_DIR" > "$APP_DIR/data-dir.txt"

# 关掉上一次由本脚本启动的实例，避免端口逐次递增
pkill -f "$BUNDLE/Contents/MacOS/Electron" 2>/dev/null || true
sleep 1

open -n "$BUNDLE"
sleep 3

echo
echo "Electron 测试窗口已启动。"
echo "  运行日志：$APP_DIR/data/electron-main.log"
echo "  数据目录：$DATA_DIR"
echo "  若窗口被其它应用挡在后面，可执行：open \"$BUNDLE\""
echo "  停止：pkill -f \"$BUNDLE/Contents/MacOS/Electron\""
