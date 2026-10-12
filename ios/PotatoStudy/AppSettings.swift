import Combine
import Foundation

/// iOS 壳的配置：只有一件事 —— 电脑端地址。
///
/// 这一版是**局域网传输版**：壳里没有账号体系、没有内置服务端、没有联网服务逻辑
/// （那些属于后面的 ios-online 分支）。壳只做两件事：
///   1) 渲染打包进 app 的离线前端界面；
///   2) 把界面里的请求指到用户填的那台电脑上。
///
/// 地址存在 UserDefaults 里，下次打开还是它。
final class AppSettings: ObservableObject {
    private static let serverKey = "potato.server"

    /// 当前输入框里的地址（连接成功后会写回 UserDefaults）。
    @Published var server: String

    init() {
        let defaults = UserDefaults.standard
        let stored = defaults.string(forKey: AppSettings.serverKey)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if let stored = stored, !stored.isEmpty {
            server = stored
        } else {
            server = BackendAddress.defaultInput
        }
    }

    /// 解析当前输入；nil 表示地址不合法。
    var address: BackendAddress? {
        return BackendAddress.parse(server)
    }

    /// 记住这次填的地址。
    func remember() {
        UserDefaults.standard.set(server, forKey: AppSettings.serverKey)
    }
}

/// 「测试连接」：拿 `/api/v1/health` 敲一下电脑端，确认地址填对了。
///
/// 除了验证地址，它还有一个副作用是**必要的**：
/// iOS 14+ 访问局域网必须先拿到"本地网络"权限，而权限弹窗是系统在
/// **本 App 发起第一次局域网连接**时弹的（用 URLSession 走 App 自己的网络栈最可靠）。
/// 所以用户点一次"测试连接"，既验地址、又把弹窗引出来。
enum BackendProbe {
    /// 探测结果：成功与否 + 一句给人看的话。
    struct Result {
        let ok: Bool
        let message: String
    }

    static func check(_ address: BackendAddress, completion: @escaping (Result) -> Void) {
        guard let url = address.healthURL else {
            completion(Result(ok: false, message: "地址不合法"))
            return
        }
        var request = URLRequest(url: url)
        request.timeoutInterval = 8
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.httpMethod = "GET"

        let task = URLSession.shared.dataTask(with: request) { data, response, error in
            let result: Result
            if let error = error {
                let nsError = error as NSError
                if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorNotConnectedToInternet {
                    result = Result(ok: false, message: "连不上：如果刚才弹了「本地网络」权限，请点允许，然后再测一次。")
                } else if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorTimedOut {
                    result = Result(ok: false, message: "超时：检查电脑端是否用 HOST=0.0.0.0 启动、手机与电脑是否同一个 Wi-Fi。")
                } else {
                    result = Result(ok: false, message: "连不上：" + error.localizedDescription)
                }
            } else if let http = response as? HTTPURLResponse {
                if http.statusCode == 200 {
                    result = Result(ok: true, message: "电脑端在线（HTTP 200），可以连接了。")
                } else {
                    result = Result(ok: false, message: "电脑端返回 HTTP \(http.statusCode)，端口或路径不对？")
                }
            } else {
                result = Result(ok: false, message: "没有拿到响应，检查地址是否写全（含端口）。")
            }
            DispatchQueue.main.async {
                completion(result)
            }
        }
        task.resume()
    }
}
