import SwiftUI
import UIKit

/// 壳的主界面：一条很薄的顶栏 + 整屏网页面。
///
/// 顶栏刻意只放「改地址 / 看当前地址 / 刷新」三件事：这一版的目标是
/// 把电脑端那套界面原样搬到手机上，而不是在手机上手搓第二套导航。
struct BrowserView: View {
    /// 电脑端地址（启动页已解析好）。
    let address: BackendAddress
    /// 返回启动页改地址。
    let onClose: () -> Void

    @State private var reloadToken = 0
    @State private var isLoading = true
    @State private var errorMessage: String?

    var body: some View {
        VStack(spacing: 0) {
            topBar
            ZStack(alignment: .top) {
                WebViewContainer(
                    address: address,
                    reloadToken: reloadToken,
                    isLoading: $isLoading,
                    errorMessage: $errorMessage
                )
                if isLoading {
                    ProgressView()
                        .progressViewStyle(LinearProgressViewStyle())
                        .frame(maxWidth: .infinity)
                }
            }
        }
        .background(Color(UIColor.systemBackground))
    }

    private var topBar: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                Button("地址") { onClose() }
                    .font(.footnote)
                Spacer(minLength: 0)
                Text(address.root)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundColor(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: 0)
                Button("刷新") { reloadToken += 1 }
                    .font(.footnote)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)

            Divider()

            if let message = errorMessage {
                errorBanner(message)
            }
        }
    }

    private func errorBanner(_ message: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Text(message)
                .font(.caption)
                .foregroundColor(.white)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
            Button("重试") {
                errorMessage = nil
                reloadToken += 1
            }
            .font(.caption)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.orange)
    }
}
