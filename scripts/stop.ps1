#Requires -Version 5.1
[CmdletBinding()]
param(
    [switch]$Infra
)

# 原生命令（docker/wsl）会把进度写到 stderr，Stop 模式下会被当成终止性错误。
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$distro = if ($env:SYLAR_WSL_DISTRO) { $env:SYLAR_WSL_DISTRO } else { 'Ubuntu-24.04' }
$runDir = Join-Path $root '.run'

function Write-Step([string]$Text) { Write-Host "==> $Text" -ForegroundColor Cyan }

function Stop-FromPidFile([string]$Path, [string]$Name) {
    if (-not (Test-Path $Path)) { return }
    $saved = (Get-Content $Path -Raw).Trim().Split('|')
    $procId = [int]$saved[0]
    $ticks = if ($saved.Length -gt 1) { [long]$saved[1] } else { -1 }
    $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
    # PID 会被系统复用：只有启动时间吻合才终止，避免误杀无关进程。
    if ($proc -and ($ticks -lt 0 -or $proc.StartTime.Ticks -eq $ticks)) {
        Write-Host "    停止 $Name（PID $procId）"
        & taskkill.exe /PID $procId /T /F *> $null
    } else {
        Write-Host "    $Name 进程已退出" -ForegroundColor Yellow
    }
    Remove-Item $Path -Force -ErrorAction SilentlyContinue
}

Write-Step '停止应用服务'
foreach ($name in @('runtime', 'admin', 'web', 'bff')) {
    Stop-FromPidFile (Join-Path $runDir ($name + '.pid')) $name
}

if ($Infra) {
    Write-Step '停止基础设施容器'
    $wslRoot = '/mnt/' + $root.Substring(0, 1).ToLower() + '/' + (($root.Substring(3)) -replace '\\', '/')
    & wsl.exe -d $distro -- bash -lc "cd '$wslRoot/apps/bff' && docker compose stop" *> $null
    Stop-FromPidFile (Join-Path $runDir 'wsl.pid') 'WSL 保活进程'
    # 兜底清理脚本之外启动的同名保活进程。
    & wsl.exe -d $distro -- bash -lc "pkill -f 'sleep 1000000000'" *> $null
}

Write-Host '已停止。' -ForegroundColor Green
