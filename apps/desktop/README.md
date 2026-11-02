# WorkSylar 桌面客户端（Electron）

直接复用 Web 工作台：窗口加载线上/本地地址，不复制业务代码。

## 开发

```bash
pnpm install
# 终端 A：启动 web + bff
pnpm --filter @ai-office/web dev
# 终端 B：桌面壳（默认连本地 3000）
pnpm --filter @ai-office/desktop dev
# 或指定地址
$env:WORKBUDDY_URL="https://app.worksylar.com"; pnpm --filter @ai-office/desktop start
```

## 打包

```bash
pnpm --filter @ai-office/desktop dist:win:portable  # Windows 单文件（已验证可产出）
pnpm --filter @ai-office/desktop dist:win           # Windows NSIS 安装包
pnpm --filter @ai-office/desktop dist:mac           # macOS DMG（需在 macOS 上执行）
pnpm --filter @ai-office/desktop dist:linux         # AppImage + deb
```

产物在 `apps/desktop/release/`。

**Windows 已验证产物**：`WorkSylar-0.1.0-win-x64.exe`（portable，约 74MB）。
当前构建机上 NSIS 安装包在最后一步被系统安全策略拦截（electron-builder 无法执行
未签名的安装器），因此先用 portable 单文件分发；签名后或换 CI 构建即可产出 NSIS。

## 运行地址

默认 `http://localhost:3000`（当前阶段连本地工作台）。安装后要连其他地址：

```powershell
$env:WORKBUDDY_URL="https://app.worksylar.com"
& "$env:LOCALAPPDATA\Programs\WorkSylar\WorkSylar.exe"
```

或直接修改 `main.cjs` 的默认值后重新打包。

## 说明

- 桌面版加载远端页面，升级 Web 即同步升级客户端；离线能力需要另行做静态导出或本地服务。
- 使用 `contextIsolation + sandbox + 禁用 nodeIntegration`；站外链接交给系统浏览器。
- macOS 正式分发需要 Developer ID 证书与 notarize；Windows 建议配置代码签名，减少 SmartScreen 提示。
- 跨平台构建不能互相替代：mac 包必须在 macOS 构建，Linux 包建议在 Linux/CI 构建。
