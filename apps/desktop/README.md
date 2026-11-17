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
pnpm --filter @ai-office/desktop dist:win:x64       # NSIS 安装包 + ZIP（本机快速验证）
pnpm --filter @ai-office/desktop dist:win           # 全量 Windows 产物
pnpm --filter @ai-office/desktop dist:win:setup     # 仅 NSIS 安装包
pnpm --filter @ai-office/desktop dist:win:zip       # 仅解压即用包
pnpm --filter @ai-office/desktop dist:win:portable  # 单文件便携版
pnpm --filter @ai-office/desktop dist:mac           # macOS DMG（需在 macOS 上执行）
pnpm --filter @ai-office/desktop dist:linux         # AppImage + deb
```

产物在 `apps/desktop/release/`：

| 产物 | 用途 | 说明 |
| --- | --- | --- |
| `WorkSylar-Setup-<ver>-win-<arch>.exe` | 标准安装包 | NSIS 助手式安装，默认按当前用户安装，无需管理员权限 |
| `WorkSylar-<ver>-win-<arch>.zip` | 解压即用 | 解压后运行 `win-unpacked/WorkSylar.exe` |
| `WorkSylar-Portable-<ver>-win-<arch>.exe` | 单文件便携版 | 运行时会解压到 `%TEMP%`；TEMP 不可写时改用 ZIP |

> 旧版本把便携版命名为 `WorkSylar-<ver>-win-x64.exe`，容易被当成安装包分发；
> 现已将 Setup / Portable / ZIP 分开命名，`dist:win` 可直接产出 NSIS 安装包。

## 运行地址

默认 `http://localhost:3000`（当前阶段连本地工作台）。安装后要连其他地址：

```powershell
$env:WORKBUDDY_URL="https://app.worksylar.com"
& "$env:LOCALAPPDATA\Programs\WorkSylar\WorkSylar.exe"
```

或直接修改 `main.cjs` 的默认值后重新打包。

## 安装/启动异常：被终端安全软件拦截

若双击安装包或 `WorkSylar.exe` 无窗口、进程立即退出（本机实测装有深信服
Sangfor UD Protect + 腾讯电脑管家），说明 exe 在执行 `main.cjs` 之前就被拦截：

- 进程退出码 `-2147483645`（`0x80000003`，STATUS_BREAKPOINT）；
- `WORKBUDDY_DEBUG=1` 也不生成 `%TEMP%\worksylar-boot.log`，排除应用自身崩溃；
- 安装器可能只完成文件解压，快捷方式与卸载注册项被中断。

**根因**：安装器与 Electron exe 均未签名，终端安全软件对未知可执行文件默认拒绝。
按优先级处理：

1. **代码签名（根治）**：准备 OV/EV 代码签名证书，在 CI 配置 `CSC_LINK` /
   `CSC_KEY_PASSWORD` 后重新打包。证书受信任后 SmartScreen 与安全软件才会放行。
2. **加白名单（企业内网）**：由管理员把 `WorkSylar-Setup-*.exe` 或安装目录加入
   安全软件白名单。
3. **浏览器应用模式（无需签名，立即可用）**：运行 `Install-WorkSylar.cmd`，
   用系统自带 Edge/Chrome 应用模式安装桌面与开始菜单快捷方式，并写入控制面板卸载项：

   ```bat
   Install-WorkSylar.cmd
   Install-WorkSylar.cmd https://app.worksylar.com
   ```

   卸载：控制面板 → 应用 → WorkSylar（浏览器应用模式），或运行安装目录下的
   `Uninstall.cmd`。也可直接双击 `WorkSylar.cmd` 免安装启动。

   分发时请把 `Install-WorkSylar.cmd` 与 `Install-WorkSylar.ps1` 放在一起打包。

## 说明

- 桌面版加载远端页面，升级 Web 即同步升级客户端；离线能力需要另行做静态导出或本地服务。
- 使用 `contextIsolation + sandbox + 禁用 nodeIntegration`；站外链接交给系统浏览器。
- macOS 正式分发需要 Developer ID 证书与 notarize；Windows 建议配置代码签名，减少 SmartScreen 提示。
- 跨平台构建不能互相替代：mac 包必须在 macOS 构建，Linux 包建议在 Linux/CI 构建。
