@echo off
chcp 65001 >nul
rem WorkSylar 桌面快捷启动（Edge/Chrome 应用模式）
rem 适用于 Electron exe 被终端安全软件拦截的机器；窗口无地址栏，体验接近桌面客户端。
setlocal
set "URL=%WORKBUDDY_URL%"
if "%URL%"=="" set "URL=http://localhost:3000"

set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if exist "%EDGE%" (
  start "" "%EDGE%" --app="%URL%" --window-size=1440,900
  exit /b 0
)

set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if exist "%CHROME%" (
  start "" "%CHROME%" --app="%URL%" --window-size=1440,900
  exit /b 0
)

echo 未找到 Edge 或 Chrome，请安装其一，或直接浏览器访问 %URL%
pause
