@echo off
chcp 65001 >nul
rem WorkSylar 浏览器应用模式安装器
rem 适用于 Electron exe / NSIS 安装包被终端安全软件拦截的机器：
rem 使用系统自带 Edge/Chrome 的应用模式安装桌面与开始菜单快捷方式。
rem
rem 用法：
rem   Install-WorkSylar.cmd                              （默认地址）
rem   Install-WorkSylar.cmd https://app.worksylar.com    （指定工作台地址）

setlocal
set "URL=%~1"
if "%URL%"=="" set "URL=%WORKBUDDY_URL%"
if "%URL%"=="" set "URL=http://localhost:3000"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-WorkSylar.ps1" -Url "%URL%"
set "RC=%ERRORLEVEL%"
echo.
if not "%RC%"=="0" (
  echo 安装失败，错误码 %RC%。请查看上方提示后重试。
) else (
  echo 安装完成。
)
pause
exit /b %RC%
