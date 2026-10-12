#!/usr/bin/env bash
#
# 本地自检（**不需要 Xcode**，只用 Command Line Tools 里的 swiftc）：
# 把地址解析那套纯逻辑（BackendAddress.swift / AppSettings.swift）编成一个命令行程序跑一遍，
# 验证「用户随手粘进来的地址」到底会不会被解析成壳需要的 ?api= / ?ws=。
#
# 为什么值得单独做这个：
#   iOS 工程在本机没法编译（没有 Xcode / iOS SDK），CI 又是"一次就要过"，
#   所以能量化验证的部分尽量在本地先跑起来 —— 地址拼错、参数被百分号编码搞坏、
#   笔记编辑器返回首页丢 ?ws= 这类问题，全都是"编译过但用不了"的隐形坑。
#
# 用法：bash ios/verify-swift.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="$REPO_ROOT/ios/PotatoStudy"

if ! command -v swiftc >/dev/null 2>&1; then
  echo "[verify-swift] 找不到 swiftc：装一下 Xcode Command Line Tools（xcode-select --install）。" >&2
  exit 1
fi

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/potato-ios-verify.XXXXXX")"
trap 'rm -rf "$WORK_DIR"' EXIT

cp "$SRC_DIR/BackendAddress.swift" "$SRC_DIR/AppSettings.swift" "$WORK_DIR/"

cat > "$WORK_DIR/main.swift" <<'SWIFT'
import Foundation

var failures = 0

func check(_ condition: Bool, _ label: String) {
    if condition {
        print("  ok   " + label)
    } else {
        failures += 1
        print("  FAIL " + label)
    }
}

print("[verify-swift] 1) 默认地址（启动页输入框的初始值）")
let fallback = BackendAddress.parse(BackendAddress.defaultInput)
check(fallback != nil, "默认地址能解析：" + BackendAddress.defaultInput)
check(fallback?.root == "http://127.0.0.1:3341", "root     = " + (fallback?.root ?? "nil"))
check(fallback?.apiBase == "http://127.0.0.1:3341/api/v1", "apiBase  = " + (fallback?.apiBase ?? "nil"))
check(fallback?.wsURL == "ws://127.0.0.1:3341/ws", "wsURL    = " + (fallback?.wsURL ?? "nil"))
check(fallback?.healthURL?.absoluteString == "http://127.0.0.1:3341/api/v1/health", "health   = " + (fallback?.healthURL?.absoluteString ?? "nil"))

print("[verify-swift] 2) 用户可能粘进来的各种写法，都要归一到同一个地址")
let want = "http://192.168.1.7:3210"
let messy = [
    "192.168.1.7:3210",
    "http://192.168.1.7:3210",
    "http://192.168.1.7:3210/",
    "http://192.168.1.7:3210/app",
    "http://192.168.1.7:3210/app/",
    "http://192.168.1.7:3210/api/v1",
    "   http://192.168.1.7:3210   ",
]
for raw in messy {
    let parsed = BackendAddress.parse(raw)
    check(parsed?.root == want, "「" + raw + "」→ " + (parsed?.root ?? "nil"))
}

print("[verify-swift] 3) https 要自动换成 wss（以后挂反代也能用）")
let secure = BackendAddress.parse("https://study.example.com")
check(secure?.root == "https://study.example.com", "root  = " + (secure?.root ?? "nil"))
check(secure?.apiBase == "https://study.example.com/api/v1", "apiBase = " + (secure?.apiBase ?? "nil"))
check(secure?.wsURL == "wss://study.example.com/ws", "wsURL = " + (secure?.wsURL ?? "nil"))

print("[verify-swift] 4) 写错的地址必须被判非法（别让用户填个 file:// 或半截地址进去）")
for raw in ["", "   ", "ftp://192.168.1.7:3210", "http://", "http://192.168.1.7:3210/foo/bar"] {
    check(BackendAddress.parse(raw) == nil, "「" + raw + "」判为非法")
}

print("[verify-swift] 5) 壳入口 URL：参数要能被前端原样读回（URLSearchParams）")
if let address = fallback, let page = address.pageURL() {
    print("        " + page.absoluteString)
    check(page.scheme == ShellScheme.scheme, "scheme = " + (page.scheme ?? "nil"))
    check(page.host == ShellScheme.host, "host   = " + (page.host ?? "nil"))
    check(page.path == ShellScheme.entryPath, "path   = " + page.path)
    let items = URLComponents(url: page, resolvingAgainstBaseURL: false)?.queryItems ?? []
    let api = items.first { $0.name == "api" }?.value
    let ws = items.first { $0.name == "ws" }?.value
    check(api == address.apiBase, "?api 原样读回 = " + (api ?? "nil"))
    check(ws == address.wsURL, "?ws  原样读回 = " + (ws ?? "nil"))
} else {
    check(false, "默认地址拼不出入口 URL")
}

print("[verify-swift] 6) 笔记编辑器返回首页时会丢 ?ws=，壳要补回来")
if let address = BackendAddress.parse("http://192.168.1.7:3210") {
    let back = URL(string: "potato://app/?view=notes&api=http://192.168.1.7:3210/api/v1")!
    let fixed = BackendAddress.completeConnectionParams(back, address: address)
    check(fixed != nil, "返回首页的地址被补了参数")
    check(fixed?.absoluteString.contains("ws=") == true, "补上了 ?ws=：" + (fixed?.absoluteString ?? "nil"))
    check(fixed?.absoluteString.contains("view=notes") == true, "原有参数没被丢掉")

    let complete = URL(string: "potato://app/index.html?api=a&ws=b")!
    check(BackendAddress.completeConnectionParams(complete, address: address) == nil, "参数齐全时不动 URL")

    let editor = URL(string: "potato://app/views/notes/editor.html?id=n1")!
    check(BackendAddress.completeConnectionParams(editor, address: address) == nil, "编辑器页本身不补参数")

    let outside = URL(string: "https://example.com/app")!
    check(BackendAddress.completeConnectionParams(outside, address: address) == nil, "外部地址不管")
}

print("[verify-swift] 7) 壳内地址识别（用来决定「就地打开」还是「交给 Safari」）")
check(ShellScheme.isOwnURL(URL(string: "potato://app/index.html")!), "potato://app/... 算壳内")
check(!ShellScheme.isOwnURL(URL(string: "https://app/index.html")!), "https://app/... 不算壳内")
check(!ShellScheme.isOwnURL(URL(string: "potato://other/index.html")!), "potato://other/... 不算壳内")

print("")
if failures == 0 {
    print("[verify-swift] 全部通过")
} else {
    print("[verify-swift] 失败 " + String(failures) + " 项")
}
exit(failures == 0 ? 0 : 1)
SWIFT

SDK_PATH="$(xcrun --show-sdk-path 2>/dev/null || true)"
if [ -z "$SDK_PATH" ]; then
  echo "[verify-swift] 拿不到 macOS SDK 路径（xcode-select 指向哪里？）。" >&2
  exit 1
fi

echo "[verify-swift] 用 swiftc 编译纯逻辑部分（BackendAddress + AppSettings）..."
# 模块缓存放到临时目录：本机 ~/Library/Caches 未必可写（沙箱/权限），放这里最稳
swiftc -swift-version 5 -module-cache-path "$WORK_DIR/modulecache" -sdk "$SDK_PATH" \
  -o "$WORK_DIR/verify" \
  "$WORK_DIR/BackendAddress.swift" "$WORK_DIR/AppSettings.swift" "$WORK_DIR/main.swift"

"$WORK_DIR/verify"
