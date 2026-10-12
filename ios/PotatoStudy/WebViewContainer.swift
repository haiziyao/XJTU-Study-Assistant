import SwiftUI
import UIKit
import WebKit

/// 把 WKWebView 包给 SwiftUI：整屏加载**打包在 app 里的**前端，并把界面里的请求指到用户填的电脑端。
///
/// 壳里没有 HTTP 服务器、没有第三方依赖：内置资源由 `potato://` 方案供（见 WebAssetSchemeHandler），
/// 业务请求（HTTP + WebSocket）由页面自己直连电脑端后端。
struct WebViewContainer: UIViewRepresentable {
    /// 电脑端地址（已在启动页解析好）。
    let address: BackendAddress
    /// 变一次就重新加载一次，供顶栏「刷新」用。
    let reloadToken: Int
    @Binding var isLoading: Bool
    @Binding var errorMessage: String?

    func makeCoordinator() -> Coordinator {
        return Coordinator(self)
    }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.setURLSchemeHandler(WebAssetSchemeHandler(), forURLScheme: ShellScheme.scheme)
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        // localStorage 兜底：真遇到不支持的实现时，至少让界面能跑起来（见下面的脚本注释）
        configuration.userContentController.addUserScript(WebViewContainer.storageFallbackScript)

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = true
        webView.scrollView.keyboardDismissMode = .interactive
        webView.isOpaque = true
        webView.backgroundColor = UIColor.systemBackground

        let entry = address.pageURL()
        context.coordinator.loadedEntry = entry
        context.coordinator.loadedToken = reloadToken
        if let entry = entry {
            webView.load(URLRequest(url: entry))
        } else {
            // 正常情况下走不到这里（启动页已经校验过地址）；真到了也别在视图更新里改状态
            DispatchQueue.main.async {
                context.coordinator.report("地址不合法，无法打开内置界面。请返回上一页重新填写。")
            }
        }
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        context.coordinator.parent = self

        let entry = address.pageURL()
        guard let entry = entry else { return }
        let urlChanged = context.coordinator.loadedEntry != entry
        let tokenChanged = context.coordinator.loadedToken != reloadToken
        guard urlChanged || tokenChanged else { return }

        context.coordinator.loadedEntry = entry
        context.coordinator.loadedToken = reloadToken
        webView.load(URLRequest(url: entry))
    }

    /// 导航回调：壳内导航自己处理，外链交给 Safari，加载失败报到界面上。
    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        var parent: WebViewContainer
        var loadedEntry: URL?
        var loadedToken: Int

        init(_ parent: WebViewContainer) {
            self.parent = parent
            self.loadedToken = parent.reloadToken
        }

        // MARK: 加载状态

        func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
            parent.isLoading = true
            parent.errorMessage = nil
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            parent.isLoading = false
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            report(error.localizedDescription, from: error)
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            report(error.localizedDescription, from: error)
        }

        /// 渲染进程被系统回收（内存吃紧）时自动重载，免得留一片白屏。
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            report("系统回收了界面进程，已自动重载。")
            webView.reload()
        }

        /// 报一条错误给界面（取消不算错误，别糊用户一脸）。
        func report(_ message: String, from error: Error? = nil) {
            if let error = error as NSError? {
                if error.domain == NSURLErrorDomain && error.code == NSURLErrorCancelled { return }
            }
            parent.isLoading = false
            parent.errorMessage = message
        }

        // MARK: 导航策略

        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = navigationAction.request.url else {
                decisionHandler(.allow)
                return
            }

            // 壳内导航：把丢掉的 ?ws= 补回来（笔记编辑器返回首页时只带回了 ?api=），
            // 否则回到首页后 WebSocket 会掉到前端写死的 127.0.0.1 默认值上 —— 手机上等于掉线。
            if ShellScheme.isOwnURL(url) {
                if let fixed = BackendAddress.completeConnectionParams(url, address: parent.address), fixed != url {
                    decisionHandler(.cancel)
                    webView.load(URLRequest(url: fixed))
                    return
                }
                decisionHandler(.allow)
                return
            }

            // 外部网页：壳里不开浏览器（也没有地址栏），交给系统 Safari。
            if url.scheme == "http" || url.scheme == "https" {
                if navigationAction.navigationType == .linkActivated || navigationAction.targetFrame == nil {
                    UIApplication.shared.open(url, options: [:], completionHandler: nil)
                    decisionHandler(.cancel)
                    return
                }
            }

            decisionHandler(.allow)
        }

        /// 前端里有 `window.open(url, '_blank')` 的地方（例如打开 AI 给出的网页链接）。
        /// 壳没有多窗口：壳内地址就地加载，外部地址交给 Safari。
        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            guard let url = navigationAction.request.url else { return nil }
            if ShellScheme.isOwnURL(url) {
                webView.load(URLRequest(url: url))
            } else if url.scheme == "http" || url.scheme == "https" {
                UIApplication.shared.open(url, options: [:], completionHandler: nil)
            }
            return nil
        }
    }

    /// localStorage 兜底脚本（documentStart 注入）。
    ///
    /// 自定义方案下 DOM 存储应当可用，但这是整个界面的**单点依赖**：
    /// 前端 `readStored()` 一抛异常，主题、草稿、权限档位全废。
    /// 所以这里探测一次，真不可用就换成内存实现 —— 偏好存不住（下次打开回到默认），
    /// 但数据和后端在电脑上，什么都不会丢。
    static let storageFallbackScript = WKUserScript(
        source: WebViewContainer.storageFallbackSource,
        injectionTime: .atDocumentStart,
        forMainFrameOnly: false
    )

    private static let storageFallbackSource = """
    (function () {
      try {
        window.localStorage.setItem('__potato_probe__', '1');
        window.localStorage.removeItem('__potato_probe__');
        return;
      } catch (error) {
        /* 不可用，下面换成内存实现 */
      }
      var memory = {};
      var keys = [];
      var shim = {
        getItem: function (key) {
          key = String(key);
          return Object.prototype.hasOwnProperty.call(memory, key) ? memory[key] : null;
        },
        setItem: function (key, value) {
          key = String(key);
          if (!Object.prototype.hasOwnProperty.call(memory, key)) { keys.push(key); }
          memory[key] = String(value);
        },
        removeItem: function (key) {
          key = String(key);
          delete memory[key];
          var at = keys.indexOf(key);
          if (at >= 0) { keys.splice(at, 1); }
        },
        clear: function () {
          memory = {};
          keys = [];
        },
        key: function (index) {
          return index >= 0 && index < keys.length ? keys[index] : null;
        }
      };
      Object.defineProperty(shim, 'length', { get: function () { return keys.length; } });
      try {
        Object.defineProperty(window, 'localStorage', { configurable: true, get: function () { return shim; } });
      } catch (error) {
        /* 连 window 上都装不上就只能这样了：前端会退回它自己的默认值 */
      }
    })();
    """
}
