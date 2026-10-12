# iOS 局域网传输版（PotatoStudy）

手机上的「智学」：**界面离线内置**，数据全部留在家里的电脑上，手机与电脑连同一个 Wi-Fi 就能互传。
这一版定位是**局域网传输**，所以壳里**没有账号体系、没有云服务**（那些留给后面的 `ios-online` 分支）。

| 你想要的 | 走哪条路 | 需要什么 |
| --- | --- | --- |
| 装成一个真正的 App（有图标、能后台） | ① CI 产出的未签名 `.ipa` → Sideloadly 自签 | 一台电脑跑 Sideloadly + 一个免费 Apple ID |
| 自己在本机出包 | ② 装 Xcode 后本地 `xcodebuild` | Mac + Xcode（约 10 GB） |
| 不想签名、不想等 7 天过期 | ③ PWA：Safari 打开 → 添加到主屏幕 | 只要电脑上有 python3 |

三条路用的是**同一份前端**（`app/src/renderer`），功能一样，区别只在"怎么装到手机上"。

---

## 1. 先让电脑端能被手机连上

手机连的是**电脑上跑的后端**（HTTP + WebSocket）。后端默认只监听 `127.0.0.1`，手机连不上，所以要显式放开：

```bash
cd app
HOST=0.0.0.0 PORT=3210 npm run start:server      # macOS / Linux
# Windows PowerShell：
# $env:HOST="0.0.0.0"; $env:PORT="3210"; npm run start:server
```

- 电脑的局域网 IP：macOS `ipconfig getifaddr en0`，Windows `ipconfig`（看 IPv4 地址），
  一般是 `192.168.x.x` / `10.x.x.x`。
- 默认端口是 **3210**（`app/src/shared/constants.js` 的 `DEFAULT_PORT`）。
  App 启动页默认填的是 `http://127.0.0.1:3341`，那只是占位 —— **按你电脑端实际端口改**。
- 电脑防火墙要放行这个端口（macOS 第一次会弹"是否允许 node 接受传入连接"，点允许）。
- 后端没有鉴权，**只在你信任的 Wi-Fi 下这么开**（宿舍/家里）；校园公共 Wi-Fi 建议别开 `0.0.0.0`。

---

## 2. 路①：从 CI 拿未签名 ipa，用 Sideloadly 自签

仓库根的 [`.github/workflows/ios.yml`](../.github/workflows/ios.yml) 在 GitHub 的 macOS runner 上构建未签名包
（本机不需要 Xcode）。

1. 推送 `ios` 分支（或到 Actions 页面手动 `workflow_dispatch`）→ 等绿。
2. 打开 Actions → 那次运行 → 页面底部 **Artifacts** → 下载 `PotatoStudy-unsigned-ipa`（zip 里就是 `PotatoStudy-unsigned.ipa`）。
3. 装到手机（Sideloadly）：

   | 步骤 | 说明 |
   | --- | --- |
   | 1 | 电脑装 [Sideloadly](https://sideloadly.io/)（Windows / macOS），iPhone 用数据线连电脑，手机上点"信任此电脑" |
   | 2 | 打开 Sideloadly，把 `PotatoStudy-unsigned.ipa` 拖进 IPA 框（或点选），设备会自动识别 |
   | 3 | Apple ID 填**你自己的免费 Apple ID**（只在本地签名用；账号密码是发给 Apple 的，Sideloadly 不存） |
   | 4 | 点 **Start**，中途会让你输 Apple ID 密码 / 双重验证码；进度条走完即安装完成 |
   | 5 | 手机上打开 App 会提示"不受信任的开发者" → **设置 → 通用 → VPN 与设备管理 → 开发者 App → 信任你的 Apple ID** |
   | 6 | iOS 16 及以上还要：**设置 → 隐私与安全性 → 开发者模式**，打开并重启一次手机 |

4. 免费 Apple ID 的限制（不是这个 App 的限制，是苹果的规则）：

   - **签名有效期 7 天**：过期后 App 打不开（图标变灰/闪退），重新用 Sideloadly 签一次即可，数据不丢；
   - **同时最多 3 个**自签 App（每台设备，免费账号）；
   - 需要信任证书（上面第 5 步），换电脑/换 Apple ID 都要重新信任；
   - 想要自动续签可以用 AltStore / SideStore 之类的工具，本仓库不依赖它们。
   - 自签时 Sideloadly 会把 bundle id 改成它自己生成的（`com.why012123.potatostudy` 只是工程里的原始值），
     所以**不用担心这个 id 被谁占用**。
   - 手机系统要求 **iOS 15 或更新**（工程部署目标是 15.0；更老的系统装不上，这是为了少踩
     WKWebView/存储那一代的老坑）。

---

## 3. 路②：本机出包（需要 Xcode）

本机没有 Xcode 的话跳过这节，用路①；有 Xcode（或装了 Command Line Tools 又想要 GUI 调试）就按下面来。

```bash
# 0) 装好 Xcode 后，把命令行工具指过去（只装 CLT 是编不出 iOS App 的）
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
xcodebuild -version

# 1) 把电脑端的前端同步进工程（这一步不可省：Web/ 不入库，是构建中间物）
cd /path/to/XJTU-Study-Assistant
bash ios/sync-web.sh

# 2) 构建（不签名）
xcodebuild -project ios/PotatoStudy.xcodeproj \
  -scheme PotatoStudy \
  -sdk iphoneos \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -derivedDataPath build \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY=""

# 3) 打成 .ipa（.ipa 就是一个装了 Payload/ 目录的 zip）
rm -rf Payload PotatoStudy-unsigned.ipa
mkdir -p Payload
cp -R build/Build/Products/Release-iphoneos/PotatoStudy.app Payload/
zip -qry PotatoStudy-unsigned.ipa Payload
rm -rf Payload
```

拿到 `PotatoStudy-unsigned.ipa` 之后，跟路①第 3 步一样用 Sideloadly 自签。

- 想用 Xcode 图形界面调试：直接打开 `ios/PotatoStudy.xcodeproj`，在 Signing & Capabilities 里
  选自己的 Team（工程里是 `CODE_SIGN_STYLE = Automatic`，没写死团队），插上手机 Run 即可。
- `-destination 'generic/platform=iOS'` 不是必须的，但写上更稳：不写时 xcodebuild 会去猜目的地，
  在没有真机/模拟器匹配的机器上会报 "Unable to find a destination matching..."。

---

## 4. 路③：PWA 免签（不想签名就走这条）

思路：把**内置前端那份副本**用静态服务器发给手机，Safari 里"添加到主屏幕"，
就是一个没有签名的"App"（图标、全屏、离线界面都有，只是没有后台能力）。

```bash
# 1) 生成内置前端副本（PWA 用同一份，CSP 已被 sync-web.sh 放宽到能连局域网）
cd /path/to/XJTU-Study-Assistant
bash ios/sync-web.sh

# 2) 用系统自带 python3 把它发到局域网（换端口就改 8080）
cd ios/PotatoStudy/Web
python3 -m http.server 8080 --bind 0.0.0.0
```

手机上（Safari）：

1. 打开 `http://<电脑IP>:8080/`；
   - 页面会自动按"同一台电脑的 3210 端口"连后端（`sync-web.sh` 注入的兜底逻辑）；
   - 后端不在 3210 就带上参数：
     `http://<电脑IP>:8080/?api=http://<电脑IP>:3341/api/v1&ws=ws://<电脑IP>:3341/ws`
2. 点底部分享按钮 → **添加到主屏幕** → 起个名字（比如"智学"）。
3. 从主屏幕图标打开就是全屏界面；第一次访问局域网同样会弹"本地网络"权限，点允许。

两个已知点，先说清楚免得踩：

- **别用手机浏览器直接开 `http://<电脑IP>:3210/app`**：那是给本机浏览器调试用的页面，
  它自带的 CSP 只白名单了 `http://127.0.0.1:*`，在手机上会拦掉对电脑 IP 的请求。
  PWA 走的是上面这份（`sync-web.sh` 放宽过 CSP 的）副本，所以能连上。
- PWA 在后台会被系统挂起，WebSocket 断线后回到前台要几秒重连；这是 Safari 的机制，不是 App 的 bug。

---

## 5. 局域网权限（第一次一定会弹）

iOS 14 起，访问局域网设备必须显式授权。App 的 `Info.plist` 声明了：

```xml
<key>NSLocalNetworkUsageDescription</key>
<string>用于在同一 Wi-Fi 下与你的电脑互传学习数据：…</string>
```

- 第一次连电脑（启动页点"测试连接"，或直接"连接并打开"）会弹
  **"智学"想要查找并连接到本地网络上的设备** → 点**允许**。
- 点错了/拒了：**设置 → 隐私与安全性 → 本地网络 → 智学** 打开；
  不打开的话请求会被系统直接掐掉，界面表现成"一直连不上后端"。
- 权限弹窗**必须由 App 自己发起一次局域网请求**才会出现，所以启动页专门留了"测试连接"按钮 ——
  它既验地址，又负责把弹窗引出来（用 `URLSession` 走 App 自己的网络栈，最可靠）。

关于明文 HTTP：电脑端是 `http://192.168.x.x:3210`，`Info.plist` 里只开
`NSAppTransportSecurity → NSAllowsLocalNetworking`（只放开私有网段/`.local`/不带点的主机名），
**刻意不用** `NSAllowsArbitraryLoads` —— 那是对所有域名放开明文，为了连自己家的电脑不值得拆掉全网的安全阀。
代价是：壳里打开**公网 http** 的网页/资源会被 ATS 拦掉（https 正常）。

---

## 6. 这个工程长什么样

```
ios/
├── PotatoStudy/                 # App 源码（SwiftUI，零第三方依赖）
│   ├── PotatoStudyApp.swift     # 入口 + 启动页/壳二选一
│   ├── StartView.swift          # 启动页：填电脑端地址、测试连接、排查清单
│   ├── BrowserView.swift        # 壳主界面：薄顶栏 + 整屏网页面
│   ├── WebViewContainer.swift   # WKWebView 包装（导航策略 / 外链 / 错误上报 / localStorage 兜底）
│   ├── WebAssetSchemeHandler.swift  # potato:// 方案：把内置前端喂给 WKWebView
│   ├── BackendAddress.swift     # 地址解析（用户随手粘的地址 → ?api= / ?ws=）
│   ├── AppSettings.swift        # 地址持久化 + "测试连接"探测
│   ├── Info.plist               # 局域网权限 / ATS / 可选文件共享
│   ├── Assets.xcassets/         # AppIcon（1024 单尺寸）
│   └── Web/                     # ← 内置前端，由 sync-web.sh 生成，**不入库**
├── PotatoStudy.xcodeproj/       # 手写工程（含共享 scheme，xcodebuild -scheme 要用）
├── sync-web.sh                  # 同步前端 + 打包期改写（CSP / 入口地址兜底）
├── verify-swift.sh              # 不需要 Xcode 的本地自检（地址解析逻辑跑用例）
└── README.md                    # 就是本文
```

几个"为什么这么写"：

- **为什么是纯 WKWebView 壳**：手机端不需要第二套 UI，电脑端那套前端已经是完整的；
  壳只负责"渲染 + 把请求指到电脑"。这样电脑端改界面，手机端只要重新同步一次前端。
- **为什么用自定义 `potato://` 方案而不是 `file://` 直接开**：
  1. `file://` 页面在 WebKit 里来源不透明，`localStorage` 可能直接抛 `SecurityError`，
     而前端大量用它记偏好（主题、草稿、权限档位）；
  2. `index.html` 的 CSP 第一条是 `default-src 'self'`，`file://` 下 `'self'` 匹配什么各版本不一致，
     有可能连自己的 js/css 都被拦；自定义方案下 `'self'` == `potato://app`，内置资源一定放得开。
- **为什么前端要拷一份**：`app/src/**` 是仓库的框架层，不许改；而且内置资源必须离线可用，
  所以 `sync-web.sh` 只做单向拷贝，拷贝产物不进 git（见 `ios/.gitignore`）。
- **为什么手写 `project.pbxproj`**：这样**不装 xcodegen / CocoaPods / SPM 也能构建**。
  工程是 `objectVersion = 56`（Xcode 14+ 都能读），只有 1 个 target、7 个 Swift 文件、
  1 个资源目录 + 1 个文件夹引用，没有任何第三方依赖和构建脚本阶段。
- **为什么前端要"改写 CSP"**：源文件的 `connect-src` 只白名单 `http://127.0.0.1:*`（桌面端同机跑够用），
  手机连的是**另一台机器**，不改写就会页面正常、但所有请求被 CSP 拦掉。
  改写只发生在 `Web/` 副本里，源目录一个字节都不动。
- **没做账号/联网**：`ios-online` 分支的事，这一版壳里连"登录"这个概念都没有。

---

## 7. 排错

| 现象 | 最可能的原因 | 怎么办 |
| --- | --- | --- |
| 页面出来了，但一直"正在连接后端…" | 后端没开 `HOST=0.0.0.0`，或端口不对，或不在同一 Wi-Fi | 电脑上 `HOST=0.0.0.0 npm run start:server`；启动页地址改成 `http://<电脑IP>:3210` |
| 启动页"测试连接"超时 | 电脑防火墙拦了 / 手机在蜂窝数据 / IP 写错 | 放行端口；确认手机 Wi-Fi 与电脑同一网段；`ipconfig getifaddr en0` 重新确认 IP |
| 弹了"本地网络"没点允许 | 系统把请求掐了 | 设置 → 隐私与安全性 → 本地网络 → 智学，打开后重连 |
| 白屏 / 提示"这个包没有内置前端" | 出包前没跑 `ios/sync-web.sh`（`Web/` 不入库，新克隆的仓库里没有） | 跑一次 `bash ios/sync-web.sh` 再构建 |
| xcodebuild 报 "does not contain a scheme named PotatoStudy" | `.xcodeproj/xcshareddata/xcschemes/PotatoStudy.xcscheme` 被删了 | 从仓库里恢复（共享 scheme 必须跟着工程提交） |
| xcodebuild 报签名相关错误 | 命令行带了签名设置 | 加上 `CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO` |
| App 打开闪退回桌面 | 免费证书 7 天过期了 | 重新用 Sideloadly 签一次 |
| iOS 16+ 提示"需要开发者模式" | 系统要求 | 设置 → 隐私与安全性 → 开发者模式，打开并重启 |
| 手机浏览器直接开电脑端 `/app` 连不上 | 那个页面自带的 CSP 只允许连 `127.0.0.1` | 走 PWA 那节的 `Web/` 副本（CSP 已放宽） |

---

## 8. 本机没有 Xcode 时能做的自检（这个仓库就是这么验的）

真机编译只能在 macOS runner（CI）上证明，但下面这些在本机就能跑，能把"一次就过"的概率抬高：

```bash
# 1) Info.plist 语法 + 关键键
plutil -lint ios/PotatoStudy/Info.plist
plutil -p ios/PotatoStudy/Info.plist | grep -E 'NSLocalNetworkUsageDescription|NSAllowsLocalNetworking'

# 2) 手写工程文件也是老式 plist，可以校验语法
plutil -lint ios/PotatoStudy.xcodeproj/project.pbxproj

# 3) 前端同步脚本（会真的拷一遍）
bash -n ios/sync-web.sh && bash ios/sync-web.sh

# 4) 地址解析逻辑跑用例（用 CLT 自带的 swiftc，不需要 Xcode）
bash ios/verify-swift.sh

# 5) workflow YAML
ruby -ryaml -e 'YAML.load_file(".github/workflows/ios.yml"); puts "yaml ok"'

# 6) 只想验语法（没装 Xcode，也没有 iOS SDK 时）：
swiftc -parse ios/PotatoStudy/*.swift
```

**本机装不了 iOS App 的边界**：编译、actool（AppIcon）、真机运行这三件事只有 Xcode/CI 能证明；
本仓库把这些都交给 `.github/workflows/ios.yml`，并在 CI 里先跑 `plutil -lint` 和 `sync-web.sh`，
让失败尽量停在"便宜"的步骤上。
