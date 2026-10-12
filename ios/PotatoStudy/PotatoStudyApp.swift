import SwiftUI
import WebKit

/// 应用入口：一个纯 WKWebView 壳（**局域网传输版**）。
///
/// 这一版刻意不写任何账号 / 内容服务端逻辑 —— 那些属于后面的 `ios-online` 分支。
/// 壳只做两件事：
///   1) 把打包在 app 里的离线前端渲染出来（`potato://app/index.html`）；
///   2) 把界面里的 REST / WebSocket 请求指到用户填的那台电脑上。
@main
struct PotatoStudyApp: App {
    @StateObject private var settings = AppSettings()

    var body: some Scene {
        WindowGroup {
            RootView().environmentObject(settings)
        }
    }
}

/// 两个界面二选一：没连之前是启动页（填/改地址），连上之后是壳浏览器。
struct RootView: View {
    @EnvironmentObject private var settings: AppSettings
    @State private var connected: BackendAddress?

    /// 内置前端在不在（忘了跑 ios/sync-web.sh 的话是 false，启动页会直接提示）。
    private let webBundled = WebAssetSchemeHandler.isWebBundled

    var body: some View {
        Group {
            if let address = connected {
                BrowserView(address: address, onClose: { connected = nil })
            } else {
                StartView(webBundled: webBundled, onConnect: { address in connected = address })
            }
        }
    }
}
