import Foundation

/// 壳自己的 URL 方案：`potato://app/<内置前端里的相对路径>`。
///
/// 放在这个文件里是因为它是**纯字符串约定**，不依赖 WebKit —— 这样地址解析这套逻辑
/// 可以在 macOS 上用 swiftc 单独编译、跑用例验证（见 ios/README.md 的"自证"一节）。
enum ShellScheme {
    /// 自定义 scheme（由 WebAssetSchemeHandler 提供实现）。
    static let scheme = "potato"
    /// 主机名部分。给自定义 scheme 一个固定的 host，页面才有稳定的来源（storage/CSP 都按来源隔离）。
    static let host = "app"

    /// 入口页面路径。
    static let entryPath = "/index.html"

    static func isOwnURL(_ url: URL) -> Bool {
        return url.scheme == scheme && url.host == host
    }
}

/// 用户填的「电脑端地址」→ 前端真正需要的两个地址。
///
/// 前端认两个查询参数（见 app/src/renderer/shell/app.js 的 resolveInfo）：
///   `?api=http://<电脑IP>:<端口>/api/v1`  REST 基址
///   `?ws=ws://<电脑IP>:<端口>/ws`         WebSocket 地址
/// 启动页只让用户填一个「根地址」（例如 `http://192.168.1.7:3210`），
/// 由这里补全成上面两个，并拼出壳要加载的入口 URL。
///
/// 归一化规则（都为了"用户随手粘一个地址也能用"）：
///   - 不带 scheme 就补 `http://`（局域网后端就是明文 HTTP）；
///   - 结尾斜杠、`/app`、`/api/v1`、`/api` 一律去掉 —— 用户很可能直接把
///     浏览器里那个 `http://<电脑IP>:3210/app` 复制进来；
///   - 只接受 http / https，其它 scheme 直接判为非法（别让用户填出个 file:// 来）。
struct BackendAddress: Equatable {
    /// 归一化后的根地址，例如 `http://192.168.1.7:3210`（不带结尾斜杠）。
    let root: String
    /// REST 基址，例如 `http://192.168.1.7:3210/api/v1`。
    let apiBase: String
    /// WebSocket 地址，例如 `ws://192.168.1.7:3210/ws`（https → wss）。
    let wsURL: String
    /// 健康检查地址（`/api/v1/health`），启动页的"测试连接"用它。
    let healthURL: URL?

    /// 启动页第一次打开时输入框里的默认值。
    ///
    /// 注意：电脑端后端自己的默认端口是 3210（app/src/shared/constants.js 的 DEFAULT_PORT）。
    /// 这里按 iOS 版的约定给 3341，连不上就把端口改成电脑端实际的端口 —— 启动页和 README 都写了。
    static let defaultInput = "http://127.0.0.1:3341"

    /// 解析用户输入。返回 nil 表示地址不可用（调用方负责提示）。
    static func parse(_ input: String) -> BackendAddress? {
        var text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { return nil }
        // 只填 "192.168.1.7:3210" 也认
        if !text.contains("://") { text = "http://" + text }

        guard let parsed = URLComponents(string: text) else { return nil }
        guard let scheme = parsed.scheme?.lowercased(), scheme == "http" || scheme == "https" else { return nil }
        guard let host = parsed.host, !host.isEmpty else { return nil }

        // 去掉用户可能顺手带进来的路径：结尾斜杠 / /app / /api/v1 / /api
        var path = parsed.path
        while path.hasSuffix("/") { path.removeLast() }
        let trimmedSuffixes = ["/api/v1", "/api", "/app"]
        for suffix in trimmedSuffixes where path.hasSuffix(suffix) {
            path.removeLast(suffix.count)
        }
        // 剩下还有路径的话（比如 /foo/bar）说明不是根地址，不猜，判非法
        if !path.isEmpty { return nil }

        // 用 URLComponents 重建，IPv6 的方括号交给它处理
        var normalized = URLComponents()
        normalized.scheme = scheme
        normalized.host = host
        normalized.port = parsed.port
        guard let rootURL = normalized.url else { return nil }
        let root = rootURL.absoluteString
        if root.isEmpty { return nil }

        // "http://host:port" → "host:port"（IPv6 会保留方括号）
        let authority = String(root.dropFirst(scheme.count + 3))
        if authority.isEmpty { return nil }

        let wsScheme = scheme == "https" ? "wss" : "ws"
        return BackendAddress(
            root: root,
            apiBase: root + "/api/v1",
            wsURL: wsScheme + "://" + authority + "/ws",
            healthURL: URL(string: root + "/api/v1/health")
        )
    }

    /// 壳要加载的入口 URL：`potato://app/index.html?api=...&ws=...`
    func pageURL() -> URL? {
        var components = URLComponents()
        components.scheme = ShellScheme.scheme
        components.host = ShellScheme.host
        components.path = ShellScheme.entryPath
        components.queryItems = [
            URLQueryItem(name: "api", value: apiBase),
            URLQueryItem(name: "ws", value: wsURL),
        ]
        return components.url
    }

    /// 给壳内 URL 补上 `api` / `ws` 查询参数（缺哪个补哪个），没得补就返回 nil。
    ///
    /// 为什么要补：前端的笔记编辑器返回首页时只带回了 `?api=`（见
    /// app/src/renderer/views/notes/editor.js 的 updateReturnUrl），`?ws=` 会丢，
    /// 回到首页后 WebSocket 就会掉到前端写死的 127.0.0.1 默认值上 —— 在手机上等于掉线。
    /// 壳在导航发生时补回去，前端不用改一行代码。
    static func completeConnectionParams(_ url: URL, address: BackendAddress) -> URL? {
        guard ShellScheme.isOwnURL(url) else { return nil }
        let path = url.path
        guard path.isEmpty || path == "/" || path == ShellScheme.entryPath else { return nil }
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }

        var items = components.queryItems ?? []
        var existing = Set<String>()
        for item in items { existing.insert(item.name) }

        var changed = false
        if !existing.contains("api") {
            items.append(URLQueryItem(name: "api", value: address.apiBase))
            changed = true
        }
        if !existing.contains("ws") {
            items.append(URLQueryItem(name: "ws", value: address.wsURL))
            changed = true
        }
        guard changed else { return nil }
        components.queryItems = items
        return components.url
    }
}
