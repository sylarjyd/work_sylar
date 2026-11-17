# WorkSylar 浏览器应用模式安装器
#
# 适用场景：终端安全软件（深信服 UD Protect、360、腾讯电脑管家等）拦截未签名的
# Electron exe / NSIS 安装器，导致 exe 双击无反应或安装失败。
# 本脚本不运行任何未签名的第三方二进制，只用系统自带的 Edge/Chrome 应用模式
# 安装桌面与开始菜单快捷方式，效果接近桌面客户端（无地址栏、独立窗口）。
#
# 用法：
#   Install-WorkSylar.cmd                              # 使用默认地址
#   Install-WorkSylar.cmd https://app.worksylar.com    # 指定工作台地址
#   powershell -ExecutionPolicy Bypass -File .\Install-WorkSylar.ps1 -Uninstall

[CmdletBinding()]
param(
  [string]$Url = $env:WORKBUDDY_URL,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

$AppName = 'WorkSylar'
$Version = '0.1.0'
$DefaultUrl = 'http://localhost:3000'
$InstallDir = Join-Path $env:LOCALAPPDATA 'Programs\WorkSylarWeb'
$StartMenuDir = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\WorkSylar'
$UninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\WorkSylarAppMode'
$DesktopLnk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'WorkSylar.lnk'
$StartMenuLnk = Join-Path $StartMenuDir 'WorkSylar.lnk'
$LogFile = Join-Path $env:TEMP 'worksylar-appmode.log'

function Write-Log([string]$Message) {
  try {
    Add-Content -LiteralPath $LogFile -Value ("{0} {1}" -f (Get-Date).ToString('s'), $Message) -Encoding UTF8
  } catch {
    # 日志失败不影响安装。
  }
}

trap {
  Write-Log "ERROR: $($_.Exception.Message)"
  Write-Log $_.ScriptStackTrace
  exit 1
}

Write-Log "start pid=$PID user=$env:USERNAME url=$Url uninstall=$($Uninstall.IsPresent)"

function Find-Browser {
  $programFilesX86 = ${env:ProgramFiles(x86)}
  $candidates = @(
    (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'),
    (Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\Application\msedge.exe'),
    (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
    (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
  )
  if ($programFilesX86) {
    $candidates += (Join-Path $programFilesX86 'Microsoft\Edge\Application\msedge.exe')
    $candidates += (Join-Path $programFilesX86 'Google\Chrome\Application\chrome.exe')
  }
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) {
      return $candidate
    }
  }
  foreach ($name in @('msedge.exe', 'chrome.exe')) {
    foreach ($hive in @('HKLM:', 'HKCU:')) {
      $key = "$hive\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\$name"
      try {
        $path = (Get-ItemProperty -LiteralPath $key -ErrorAction Stop).'(default)'
        if ($path -and (Test-Path -LiteralPath $path)) {
          return $path
        }
      } catch {
        # 注册表项不存在时继续尝试下一个浏览器。
      }
    }
  }
  return $null
}

function Remove-Shortcuts {
  foreach ($lnk in @($DesktopLnk, $StartMenuLnk)) {
    if (Test-Path -LiteralPath $lnk) {
      Remove-Item -LiteralPath $lnk -Force -ErrorAction SilentlyContinue
    }
  }
  if (Test-Path -LiteralPath $StartMenuDir) {
    Remove-Item -LiteralPath $StartMenuDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}

if ($Uninstall) {
  Remove-Shortcuts
  if (Test-Path -LiteralPath $UninstallKey) {
    Remove-Item -LiteralPath $UninstallKey -Recurse -Force -ErrorAction SilentlyContinue
  }
  if (Test-Path -LiteralPath $InstallDir) {
    Remove-Item -LiteralPath $InstallDir -Recurse -Force -ErrorAction SilentlyContinue
  }
  Write-Host ''
  Write-Host "已卸载 $AppName（浏览器应用模式）。"
  exit 0
}

if (-not $Url) {
  $Url = $DefaultUrl
}
if ($Url -notmatch '^https?://') {
  throw "工作台地址必须以 http:// 或 https:// 开头：$Url"
}

$browser = Find-Browser
if (-not $browser) {
  throw '未找到 Microsoft Edge 或 Google Chrome，请先安装其中任意一个浏览器。'
}
Write-Log "browser=$browser"

New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
New-Item -ItemType Directory -Path $StartMenuDir -Force | Out-Null
Write-Log "dirs ready installDir=$InstallDir"

# 复制卸载脚本，并生成中文控制台可读的卸载入口。
$uninstallPs1 = Join-Path $InstallDir 'Uninstall.ps1'
Copy-Item -LiteralPath $PSCommandPath -Destination $uninstallPs1 -Force
$uninstallCmd = Join-Path $InstallDir 'Uninstall.cmd'
$uninstallCmdContent = @"
@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Uninstall.ps1" -Uninstall
pause
"@
Set-Content -LiteralPath $uninstallCmd -Value $uninstallCmdContent -Encoding ASCII
Write-Log 'uninstall files written'

$shell = New-Object -ComObject WScript.Shell
Write-Log 'WScript.Shell created'

function New-AppShortcut([string]$Path) {
  $shortcut = $shell.CreateShortcut($Path)
  $shortcut.TargetPath = $browser
  $shortcut.Arguments = "--app=`"$Url`" --window-size=1440,900"
  $shortcut.WorkingDirectory = Split-Path -Parent $browser
  $shortcut.IconLocation = "$browser,0"
  $shortcut.Description = "$AppName 智能工作台"
  $shortcut.Save()
}

New-AppShortcut $DesktopLnk
Write-Log "desktop shortcut created exists=$(Test-Path -LiteralPath $DesktopLnk)"
New-AppShortcut $StartMenuLnk
Write-Log "start menu shortcut created exists=$(Test-Path -LiteralPath $StartMenuLnk)"

New-Item -Path $UninstallKey -Force | Out-Null
Set-ItemProperty -Path $UninstallKey -Name DisplayName -Value "$AppName（浏览器应用模式）"
Set-ItemProperty -Path $UninstallKey -Name DisplayVersion -Value $Version
Set-ItemProperty -Path $UninstallKey -Name Publisher -Value $AppName
Set-ItemProperty -Path $UninstallKey -Name InstallLocation -Value $InstallDir
Set-ItemProperty -Path $UninstallKey -Name DisplayIcon -Value $browser
Set-ItemProperty -Path $UninstallKey -Name UninstallString -Value "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$uninstallPs1`" -Uninstall"
Set-ItemProperty -Path $UninstallKey -Name NoModify -Value 1 -Type DWord
Set-ItemProperty -Path $UninstallKey -Name NoRepair -Value 1 -Type DWord
Write-Log 'uninstall registry written'

Write-Host ''
Write-Host "$AppName 已安装（浏览器应用模式）。"
Write-Host "  工作台地址：$Url"
Write-Host "  浏览器：$browser"
Write-Host "  桌面快捷方式：$DesktopLnk"
Write-Host "  开始菜单：$StartMenuDir"
Write-Host ''
if ($Url -match '^https?://(localhost|127\.0\.0\.1)(:\d+)?') {
  Write-Host '提示：当前指向本地地址，打开前请先启动 Web 工作台。' -ForegroundColor Yellow
}
Write-Host '如需改为其它地址，重新运行 Install-WorkSylar.cmd 并传入 URL。'
