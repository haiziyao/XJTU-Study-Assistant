#!/usr/bin/env bash
#
# 把电脑端的前端（app/src/renderer/**）同步进 iOS 壳的内置资源目录 ios/PotatoStudy/Web/。
#
# 为什么需要这个脚本（而不是直接把前端提交进 ios/）：
#   1) iOS 壳要**离线可用**：界面必须打包进 app bundle，不能启动时从电脑端下载；
#   2) 仓库有一条硬约束——不改 app/src/**。所以这里只做**单向拷贝**：源目录永远只读，
#      拷贝产物是构建中间物（每次前端一改就过期），因此不进 git（见 ios/.gitignore）；
#   3) 本地出包、CI 出包都先跑这一遍，保证 ipa 里的界面 == 当前提交的前端。
#
# 拷贝时会做两处「打包期改写」，都只发生在拷贝产物里，不回写源目录：
#
#   a) CSP 白名单放宽（connect-src / img-src）：
#      源文件只白名单了 http://127.0.0.1:*。桌面端在**同一台机器**上跑，所以够用；
#      但 iOS 版连的是**局域网里的另一台电脑**（http://192.168.x.x:3210）。
#      在手机上 127.0.0.1 指向手机自己，原白名单会让 XHR / WebSocket 被 CSP 拦掉，
#      表现成"页面出来了但一直连不上后端"。这里把连接类指令放宽成
#      http:/https:/ws:/wss:（壳本来就要用户自己填后端地址，白名单没有意义）。
#
#   b) 入口地址兜底（只改 index.html）：
#      PWA 免签路径是把 Web/ 目录用静态服务器发给手机，页面 URL 里不会有 ?api=。
#      这里补一小段脚本：http(s) 打开且没带 ?api= 时，按"同主机 3210 端口"兜底，
#      省得在手机键盘上敲一长串带参数的地址。壳内（potato://）不受影响，
#      壳里的地址由 App 的启动页拼好传进来。
#
# 用法：
#   bash ios/sync-web.sh          # 本地出包前
#   CI 里由 .github/workflows/ios.yml 调用
#
# 幂等：每次先删掉旧的 Web/ 再重新拷贝，所以重复执行结果一致。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="$REPO_ROOT/app/src/renderer"
DEST_DIR="$REPO_ROOT/ios/PotatoStudy/Web"

# 电脑端后端的默认端口（app/src/shared/constants.js 的 DEFAULT_PORT）。
# 只用于 PWA 兜底地址，改后端端口的话这里也跟着改。
BACKEND_PORT="${POTATO_BACKEND_PORT:-3210}"

if [ ! -d "$SRC_DIR" ]; then
  echo "[sync-web] 找不到前端源码目录：$SRC_DIR" >&2
  echo "[sync-web] 请在仓库根目录执行（脚本会自己算仓库根，不需要先 cd）。" >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "[sync-web] 需要 python3 做打包期改写（macOS 装了 Xcode Command Line Tools 就有）。" >&2
  exit 1
fi

echo "[sync-web] 源目录：$SRC_DIR"
echo "[sync-web] 目标  ：$DEST_DIR"

rm -rf "$DEST_DIR"
mkdir -p "$(dirname "$DEST_DIR")"
cp -R "$SRC_DIR" "$DEST_DIR"

# macOS 会把 .DS_Store 带进 bundle（无用且会让产物校验变脏），顺手清掉
find "$DEST_DIR" -name '.DS_Store' -delete 2>/dev/null || true

python3 - "$DEST_DIR" "$BACKEND_PORT" <<'PY'
import re
import sys
from pathlib import Path

dest = Path(sys.argv[1])
port = sys.argv[2]

# --- a) CSP：连接类指令放宽到任意 http(s)/ws(s) ------------------------------
# 只动 connect-src / img-src 两段，其它指令（default-src 'self' 等）原样保留：
# 内置资源仍然只允许来自壳自己（potato://app），外部图片与后端连接放开。
CSP_REPLACEMENTS = [
    ("connect-src http://127.0.0.1:* ws://127.0.0.1:*", "connect-src http: https: ws: wss:"),
    ("img-src 'self' data: http://127.0.0.1:*", "img-src 'self' data: http: https:"),
]

patched = []
for name in ("index.html", "views/notes/editor.html"):
    path = dest / name
    if not path.is_file():
        raise SystemExit(f"[sync-web] 前端结构变了：找不到 {name}，请同步更新 ios/sync-web.sh")
    text = path.read_text(encoding="utf-8")
    before = text
    for old, new in CSP_REPLACEMENTS:
        text = text.replace(old, new)
    # 改完必须真的生效：前端哪天换了 CSP 写法，这里要立刻炸而不是静默出包
    if text == before:
        raise SystemExit(f"[sync-web] {name} 的 CSP 与预期不符（源文件可能改过），请同步更新 ios/sync-web.sh")
    if "connect-src http: https: ws: wss:" not in text:
        raise SystemExit(f"[sync-web] {name} 的 connect-src 改写失败")
    path.write_text(text, encoding="utf-8")
    patched.append(name)

# --- b) 入口地址兜底（只改 index.html） --------------------------------------
BOOTSTRAP = """    <!-- iOS 壳：由 ios/sync-web.sh 注入（不回写 app/src/renderer）。
         PWA 免签路径是用静态服务器把本目录发给手机，URL 里通常没有 ?api=；
         这里按"同主机 %s 端口"兜底，省得在手机上敲长地址。
         壳内（potato://）不走这段，地址由 App 启动页拼好传进来。 -->
    <script>
      (function () {
        try {
          var protocol = location.protocol;
          if (protocol !== 'http:' && protocol !== 'https:') return;
          var query = new URLSearchParams(location.search);
          if (query.get('api')) return;
          var root = protocol + '//' + location.hostname + ':%s';
          query.set('api', root + '/api/v1');
          query.set('ws', (protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.hostname + ':%s/ws');
          history.replaceState(null, '', location.pathname + '?' + query.toString() + location.hash);
        } catch (error) {
          /* 兜底失败就退回前端自己的默认值，不影响壳内使用 */
        }
      })();
    </script>
""" % (port, port, port)

index = dest / "index.html"
text = index.read_text(encoding="utf-8")
anchor = '    <script src="kit/theme.js"></script>'
if anchor not in text:
    raise SystemExit("[sync-web] index.html 里找不到注入锚点（kit/theme.js），请同步更新 ios/sync-web.sh")
if "POTATO_IOS_BOOTSTRAP" not in text:
    # 用注释里的标记做幂等保护：重复执行也不会注入两遍
    text = text.replace(anchor, anchor + "\n" + BOOTSTRAP + "    <!-- POTATO_IOS_BOOTSTRAP -->", 1)
    index.write_text(text, encoding="utf-8")

files = sorted(p for p in dest.rglob("*") if p.is_file())
total = sum(p.stat().st_size for p in files)
print(f"[sync-web] 改写：{', '.join(patched)}（CSP 连接白名单 + 入口地址兜底）")
print(f"[sync-web] 完成：{len(files)} 个文件，{total / 1024:.0f} KB -> {dest}")
PY

echo "[sync-web] 自检："
grep -c 'connect-src http: https: ws: wss:' "$DEST_DIR/index.html" | sed 's/^/  index.html connect-src 放宽行数：/'
grep -c 'POTATO_IOS_BOOTSTRAP' "$DEST_DIR/index.html" | sed 's/^/  index.html 兜底脚本标记：/'
test -f "$DEST_DIR/shell/app.js" || { echo "[sync-web] 缺少 shell/app.js" >&2; exit 1; }
test -f "$DEST_DIR/kit/theme.js" || { echo "[sync-web] 缺少 kit/theme.js" >&2; exit 1; }
echo "[sync-web] 好了。接下来：xcodebuild ... （见 ios/README.md）"
