# 多端客户端：桌面安装包与移动端

目标：Web 工作台已经跑通，桌面（Windows / macOS / Linux）与移动（Android / iOS）
直接复用同一套前端，不再维护第二套 UI。

## 一、可行性结论

| 端 | 方案 | 复用程度 | 结论 |
| --- | --- | --- | --- |
| Windows / macOS / Linux | Electron 套壳远端工作台 | **100% 复用**，升级 Web 即同步升级 | 可行，已落地 `apps/desktop` |
| Android APK | Capacitor WebView 加载远端 | **100% 复用** | 可行，已落地 `apps/mobile`；需 Android SDK 出包 |
| iOS IPA | Capacitor WebView | **100% 复用** | 技术可行，但必须 macOS + Apple 开发者账号签名；纯 Web 套壳有审核风险 |

关键前提：当前 `apps/web` 是 Next.js 服务端渲染，**不能像纯静态站一样塞进安装包离线运行**，
所以桌面/移动壳默认加载部署好的 `https://app.worksylar.com`（可配置成本地或内网地址）。
如果要求离线使用，需要额外做静态导出 + 本地 BFF，工作量会显著增加。

## 二、桌面端（Electron）

目录：`apps/desktop`

```bash
pnpm install
pnpm --filter @ai-office/desktop dev      # 连本地 http://localhost:3000
pnpm --filter @ai-office/desktop dist     # 当前系统安装包
```

产物：`apps/desktop/release/`

- Windows：NSIS 安装包（x64 + arm64）
- macOS：DMG（Intel + Apple Silicon）
- Linux：AppImage + deb

安全基线：`contextIsolation + sandbox + 无 nodeIntegration`，站外链接走系统浏览器，
默认拒绝摄像头/麦克风权限。

签名/公证：

- macOS 需要 Apple Developer ID 证书并 notarize，否则 Gatekeeper 拦截；
- Windows 建议 EV/OV 代码签名，降低 SmartScreen 警告；
- Linux 无需签名。

## 三、移动端（Capacitor）

目录：`apps/mobile`

```bash
pnpm install
pnpm --filter @ai-office/mobile add:android   # 生成 android/
pnpm --filter @ai-office/mobile add:ios       # 仅 macOS
pnpm --filter @ai-office/mobile sync
```

- 服务地址：`CAP_SERVER_URL`（默认 `https://app.worksylar.com`）；
- 本地联调：`CAP_SERVER_URL=http://10.0.2.2:3000 CAP_CLEARTEXT=1`；
- Android 出包：`cd apps/mobile/android && ./gradlew assembleRelease`（需 keystore）；
- iOS 出包：Xcode Archive → TestFlight / App Store（需证书与 Provisioning Profile）。

移动端已知限制：

1. **文件下载/分享**：WebView 对 `blob:` 下载支持有限，需要在壳里补 Filesystem/Share 插件；
2. **扫码/拍照/推送**：需按业务补 Capacitor 插件（扫码登录、消息推送）；
3. **App Store 4.2**：纯 WebView 套壳可能被判“minimum functionality”，
   建议补原生能力或先走 TestFlight / 企业分发；Android 无此限制；
4. iOS 不能分发 APK 概念，只能 IPA + 签名（Ad Hoc / TestFlight / App Store / 企业证书）。

## 四、构建矩阵

| 目标 | 构建机 | 必需工具 | 是否需要证书 |
| --- | --- | --- | --- |
| Windows exe | Windows | Node + electron-builder | 建议签名 |
| macOS dmg | macOS | Xcode CLT + electron-builder | 必须（分发） |
| Linux AppImage/deb | Linux | Node + electron-builder | 否 |
| Android apk | Linux/macOS/Windows | JDK 21 + Android SDK | release 需 keystore |
| iOS ipa | macOS | Xcode + CocoaPods | 必须 |

CI：`.github/workflows/clients.yml` 已配置桌面三平台矩阵与 Android Debug APK。
正式发布时把 Android `assembleDebug` 换成 `assembleRelease` 并注入 keystore secrets。

## 五、工作量与建议

- 桌面壳：1–2 天（含图标、菜单、外链、签名流程接入）；
- Android：1–2 天（生成工程、图标启动图、返回键与下载插件、出包）；
- iOS：2–3 天 + 审核周期（证书、隐私清单、4.2 风险）；
- 若后续要离线/推送/扫码，另计 3–5 天。

建议顺序：**桌面（Windows 先发）→ Android APK → iOS TestFlight**。
