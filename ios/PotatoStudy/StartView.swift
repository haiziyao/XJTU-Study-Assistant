import SwiftUI

/// 启动页：填电脑端地址 → 测试 → 进壳。
///
/// 这一版是局域网传输版，所以启动页只干一件事：**告诉壳后端在哪台电脑上**。
/// 没有登录、没有账号、没有云 —— 数据都在那台电脑上（见根 README 的 iOS 一节）。
struct StartView: View {
    /// 内置前端是否打进了 app（false = 出包前忘了跑 ios/sync-web.sh）。
    let webBundled: Bool
    /// 用户点「连接并打开」时回调。
    let onConnect: (BackendAddress) -> Void

    @EnvironmentObject private var settings: AppSettings
    @State private var input: String = ""
    @State private var testing = false
    @State private var testMessage: String?
    @State private var testOK = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                header
                if !webBundled { missingWebCard }
                addressCard
                checklistCard
            }
            .padding(20)
            .frame(maxWidth: 620, alignment: .leading)
        }
        .background(Color(UIColor.systemGroupedBackground))
        .onAppear {
            if input.isEmpty { input = settings.server }
        }
    }

    // MARK: 各块

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("智学 · iOS 局域网版")
                .font(.title2)
                .bold()
            Text("界面是打包在 app 里的，离线就能打开；数据都在你自己的电脑上，手机和电脑连同一个 Wi-Fi 就能互传。")
                .font(.subheadline)
                .foregroundColor(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var missingWebCard: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("这个包没有内置前端")
                .font(.headline)
            Text("出包前先跑一次 ios/sync-web.sh（它把 app/src/renderer 拷到 ios/PotatoStudy/Web/），再重新构建。")
                .font(.footnote)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(UIColor.secondarySystemBackground))
        .cornerRadius(12)
    }

    private var addressCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("电脑端地址")
                .font(.headline)
            Text("填电脑上的后端地址（局域网 IP + 端口），例如 http://192.168.1.7:3210")
                .font(.footnote)
                .foregroundColor(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            TextField("http://192.168.1.7:3210", text: $input)
                .textFieldStyle(RoundedBorderTextFieldStyle())
                .font(.system(.body, design: .monospaced))
                .keyboardType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled(true)
                .submitLabel(.go)
                .onSubmit { connect() }

            if let address = parsed {
                VStack(alignment: .leading, spacing: 4) {
                    addressRow("接口", address.apiBase)
                    addressRow("推送", address.wsURL)
                }
            } else {
                Text("地址不合法：写成 http://<电脑IP>:<端口> 的样子；端口不能漏。")
                    .font(.footnote)
                    .foregroundColor(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }

            HStack(spacing: 12) {
                Button("连接并打开") { connect() }
                    .buttonStyle(.borderedProminent)
                    .disabled(parsed == nil)

                Button(testing ? "测试中…" : "测试连接") { test() }
                    .disabled(testing || parsed == nil)

                if testing {
                    ProgressView().progressViewStyle(CircularProgressViewStyle())
                }
                Spacer(minLength: 0)
            }

            if let message = testMessage {
                Text(message)
                    .font(.footnote)
                    .foregroundColor(testOK ? Color.green : Color.orange)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(UIColor.secondarySystemBackground))
        .cornerRadius(14)
    }

    private var checklistCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("连不上就按这个顺序查")
                .font(.headline)
            hint("1", "电脑端要用局域网模式启动（默认只监听本机，手机连不上）：", "cd app && HOST=0.0.0.0 npm run start:server")
            hint("2", "电脑端默认端口是 3210；上面默认填的 3341 只是占位，按你电脑端实际端口改。", "app/src/shared/constants.js 的 DEFAULT_PORT")
            hint("3", "手机和电脑连同一个 Wi-Fi（手机热点也行），电脑防火墙要放行那个端口。", "")
            hint("4", "第一次连接会弹「想查找并连接到本地网络上的设备」，点「允许」。点错了去：设置 → 隐私与安全性 → 本地网络，重新打开。", "")
            hint("5", "数据只在局域网里走，不经过任何服务器；这一版壳里没有账号逻辑。", "")
            Text("不想自签安装的话，还有 PWA 免签路径（Safari 打开 → 添加到主屏幕），做法见 ios/README.md。")
                .font(.footnote)
                .foregroundColor(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(UIColor.secondarySystemBackground))
        .cornerRadius(14)
    }

    // MARK: 小组件

    private func addressRow(_ name: String, _ value: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Text(name)
                .font(.caption)
                .foregroundColor(.secondary)
                .frame(width: 30, alignment: .leading)
            Text(value)
                .font(.system(.caption, design: .monospaced))
                .foregroundColor(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func hint(_ index: String, _ text: String, _ command: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .top, spacing: 8) {
                Text(index)
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .frame(width: 14, alignment: .leading)
                Text(text)
                    .font(.footnote)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if !command.isEmpty {
                Text(command)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundColor(.secondary)
                    .padding(.leading, 22)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    // MARK: 动作

    private var parsed: BackendAddress? {
        return BackendAddress.parse(input)
    }

    private func connect() {
        guard let address = parsed else { return }
        settings.server = input
        settings.remember()
        onConnect(address)
    }

    private func test() {
        guard let address = parsed else { return }
        testing = true
        testMessage = nil
        BackendProbe.check(address) { result in
            testing = false
            testOK = result.ok
            testMessage = result.message
        }
    }
}
