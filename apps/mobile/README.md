# WorkSylar 移动客户端（Capacitor）

Android / iOS 复用 Web 工作台；默认 WebView 加载 `CAP_SERVER_URL`（默认 `https://app.worksylar.com`）。

## 首次生成原生工程

```bash
pnpm install
pnpm --filter @ai-office/mobile add:android
pnpm --filter @ai-office/mobile add:ios     # 仅 macOS
pnpm --filter @ai-office/mobile sync
```

生成 `android/`、`ios/` 工程后，用 Android Studio / Xcode 打开，配置签名后打包。

## 本地联调

```bash
# Android 模拟器访问宿主机
CAP_SERVER_URL=http://10.0.2.2:3000 CAP_CLEARTEXT=1 pnpm --filter @ai-office/mobile sync
pnpm --filter @ai-office/mobile open:android
```

## 打包 APK / IPA

```bash
cd apps/mobile/android && ./gradlew assembleRelease   # 需 keystore 与签名配置
# iOS：Xcode Archive → TestFlight / App Store，需 Apple Developer 账号与证书
```

## 限制

- WebView 套壳依赖网络，离线不可用；
- `blob:` 下载、文件分享在 WebView 中可能需要原生插件（Filesystem / Share）补齐；
- 纯 Web 套壳在 App Store 审核有 4.2「minimum functionality」风险，建议补充扫码、推送、离线缓存等原生能力，或走企业分发；
- Android 可自由分发 APK；iOS 必须签名（Ad Hoc / TestFlight / App Store / 企业证书）。
