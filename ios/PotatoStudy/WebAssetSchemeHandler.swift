import Foundation
import WebKit

/// 壳自己的 URL 方案实现：`potato://app/<内置前端里的相对路径>` → app bundle 里的 `Web/` 目录。
///
/// 为什么不用 `file://` 直接加载 `Web/index.html`：
///   1) `file://` 页面在 WebKit 里来源是不透明的，`localStorage` 有可能直接抛 SecurityError。
///      前端大量用 localStorage 记偏好（主题、草稿、权限档位、上次视图），一抛就等于整个界面废掉。
///      自定义方案有正常的 (scheme, host) 来源，DOM 存储按来源隔离，行为和普通网页一致。
///   2) `index.html` 的 CSP 第一条是 `default-src 'self'`。`file://` 下 `'self'` 到底匹配什么，
///      各版本 WebKit 行为不一致（可能连自己的 js/css 都被拦）；自定义方案下
///      `'self'` == `potato://app`，内置资源一定放得开。
///   3) 页面要连局域网里的 http 后端，来源固定成 `potato://app` 也方便排查 CSP / CORS 问题。
///
/// 实现上刻意做成**同步**：所有响应在 `start` 里读完就回，不排队、不异步，
/// 因此不存在"任务已被 stop 还去回调"那类崩溃（WKURLSchemeTask 的经典坑）。
final class WebAssetSchemeHandler: NSObject, WKURLSchemeHandler {
    /// 内置前端在 app bundle 里的落点：`PotatoStudy.app/Web/`
    /// （project.pbxproj 里把 Web/ 作为"文件夹引用"整体拷进 bundle，见 Resources 构建阶段）
    static var webRoot: URL {
        let base = Bundle.main.resourceURL ?? Bundle.main.bundleURL
        return base.appendingPathComponent("Web", isDirectory: true)
    }

    /// 内置前端到底在不在。不在说明出包前忘了跑 `ios/sync-web.sh`，启动页会直接提示。
    static var isWebBundled: Bool {
        return FileManager.default.fileExists(atPath: webRoot.appendingPathComponent("index.html").path)
    }

    private let root: URL

    override init() {
        root = WebAssetSchemeHandler.webRoot.standardizedFileURL
        super.init()
    }

    // MARK: - WKURLSchemeHandler

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url else {
            fail(urlSchemeTask, code: NSURLErrorBadURL, message: "请求缺少 URL")
            return
        }
        guard let file = resolve(url) else {
            fail(urlSchemeTask, code: NSURLErrorFileDoesNotExist, message: "内置资源不存在：" + url.path)
            return
        }
        guard let data = try? Data(contentsOf: file) else {
            fail(urlSchemeTask, code: NSURLErrorCannotOpenFile, message: "内置资源读取失败：" + file.lastPathComponent)
            return
        }
        let headers = [
            "Content-Type": WebAssetSchemeHandler.mimeType(for: file.pathExtension),
            "Content-Length": String(data.count),
            // 壳内资源随 app 一起更新，本地读盘很快；不缓存省得改了前端看不到效果
            "Cache-Control": "no-cache",
        ]
        guard let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers) else {
            fail(urlSchemeTask, code: NSURLErrorUnknown, message: "构造响应失败")
            return
        }
        urlSchemeTask.didReceive(response)
        urlSchemeTask.didReceive(data)
        urlSchemeTask.didFinish()
    }

    /// 本实现同步完成，没有需要中断的异步工作。
    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
        // 空实现即可：start 里已经同步走完（didFinish 或 didFailWithError）
    }

    // MARK: - 路径解析

    /// URL → bundle 内的真实文件；路径越界（`../..`）或文件不存在返回 nil。
    private func resolve(_ url: URL) -> URL? {
        var relative = url.path
        if relative.isEmpty || relative == "/" {
            relative = ShellScheme.entryPath
        } else if relative.hasSuffix("/") {
            relative += "index.html"
        }
        let decoded = relative.removingPercentEncoding ?? relative
        var trimmed = decoded
        while trimmed.hasPrefix("/") { trimmed.removeFirst() }
        if trimmed.isEmpty { return nil }

        let candidate = root.appendingPathComponent(trimmed).standardizedFileURL
        // 目录穿越防护：标准化之后必须仍在 Web/ 里面
        let rootPath = root.path.hasSuffix("/") ? root.path : root.path + "/"
        guard candidate.path.hasPrefix(rootPath) else { return nil }

        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: candidate.path, isDirectory: &isDirectory) else { return nil }
        if isDirectory.boolValue { return nil }
        return candidate
    }

    private func fail(_ task: WKURLSchemeTask, code: Int, message: String) {
        let error = NSError(domain: NSURLErrorDomain, code: code, userInfo: [NSLocalizedDescriptionKey: message])
        task.didFailWithError(error)
    }

    /// 前端用到的类型就这些（js/css/html/json/图片/字体）；缺的类型一律按二进制发，不会拦。
    private static func mimeType(for pathExtension: String) -> String {
        switch pathExtension.lowercased() {
        case "html", "htm": return "text/html; charset=utf-8"
        case "js", "mjs": return "text/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json", "map": return "application/json; charset=utf-8"
        case "svg": return "image/svg+xml"
        case "txt", "md": return "text/plain; charset=utf-8"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "gif": return "image/gif"
        case "webp": return "image/webp"
        case "ico": return "image/x-icon"
        case "woff": return "font/woff"
        case "woff2": return "font/woff2"
        case "ttf": return "font/ttf"
        case "wasm": return "application/wasm"
        case "mp3": return "audio/mpeg"
        case "mp4": return "video/mp4"
        case "pdf": return "application/pdf"
        default: return "application/octet-stream"
        }
    }
}
