#Requires -Version 5.1
[CmdletBinding()]
param(
    [switch]$SkipInfra,
    [switch]$SkipDbPush,
    [int]$TimeoutSeconds = 150
)

# 原生命令（docker/pnpm）会把进度写到 stderr，Stop 模式下会被当成终止性错误。
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$distro = if ($env:SYLAR_WSL_DISTRO) { $env:SYLAR_WSL_DISTRO } else { 'Ubuntu-24.04' }
$runDir = Join-Path $root '.run'
$logDir = Join-Path $root 'logs'
New-Item -ItemType Directory -Force -Path $runDir, $logDir | Out-Null

function Write-Step([string]$Text) { Write-Host "==> $Text" -ForegroundColor Cyan }

function Test-Port([int]$Port) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $iar = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
        if (-not $iar.AsyncWaitHandle.WaitOne(500)) { return $false }
        $client.EndConnect($iar)
        return $true
    } catch {
        return $false
    } finally {
        $client.Close()
    }
}

function Wait-Port([int]$Port, [string]$Name, [int]$Seconds) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-Port $Port) {
            Write-Host "    $Name 已就绪（端口 $Port）" -ForegroundColor Green
            return $true
        }
        Start-Sleep -Milliseconds 800
    }
    Write-Warning "$Name 未在 $Seconds 秒内监听端口 $Port，请查看 logs/ 下的日志"
    return $false
}

function Save-Pid([string]$Path, [System.Diagnostics.Process]$Process) {
    $Process.Refresh()
    "$($Process.Id)|$($Process.StartTime.Ticks)" | Set-Content -Path $Path -Encoding ASCII
}

if (-not (Test-Path (Join-Path $root '.env'))) {
    throw '未找到根目录 .env：请先复制 .env.example 为 .env 并填写配置'
}

# Windows 路径转 WSL 路径：D:\ws\... -> /mnt/d/ws/...
$wslRoot = '/mnt/' + $root.Substring(0, 1).ToLower() + '/' + (($root.Substring(3)) -replace '\\', '/')

if (-not $SkipInfra) {
    Write-Step "启动基础设施（$distro 中的 Docker）"

    & wsl.exe -d $distro -- pgrep -f 'sleep 1000000000' *> $null
    if ($LASTEXITCODE -ne 0) {
        # WSL 无运行中进程时会自动关机，连带终止容器；用常驻 sleep 保持虚拟机存活。
        # 直接执行 sleep，避免经 shell 传参时参数被拆分。
        $keep = Start-Process -FilePath 'wsl.exe' `
            -ArgumentList @('-d', $distro, '--', 'sleep', '1000000000') `
            -WindowStyle Hidden -PassThru
        Save-Pid (Join-Path $runDir 'wsl.pid') $keep
    }

    & wsl.exe -d $distro -- bash -lc 'docker info >/dev/null 2>&1'
    if ($LASTEXITCODE -ne 0) {
        Write-Host '    Docker 未运行，尝试启动 docker 服务…'
        & wsl.exe -d $distro -- bash -lc 'sudo -n service docker start >/dev/null 2>&1 || service docker start >/dev/null 2>&1' *> $null
        Start-Sleep -Seconds 3
        & wsl.exe -d $distro -- bash -lc 'docker info >/dev/null 2>&1'
        if ($LASTEXITCODE -ne 0) { throw "WSL 中的 Docker 未运行，请先在 $distro 中启动 Docker" }
    }

    & wsl.exe -d $distro -- bash -lc "cd '$wslRoot/apps/bff' && docker compose up -d"
    if ($LASTEXITCODE -ne 0) { throw 'docker compose up 失败' }

    Wait-Port 5432 'PostgreSQL' 90 | Out-Null
    Wait-Port 9000 'MinIO' 60 | Out-Null
}

if (-not $SkipDbPush) {
    Write-Step '同步数据库结构与中文注释'
    # Prisma CLI 不读取仓库根目录的 .env，这里显式注入 DATABASE_URL。
    $dbLine = Get-Content (Join-Path $root '.env') |
        Where-Object { $_ -match '^\s*DATABASE_URL\s*=' } |
        Select-Object -Last 1
    if ($dbLine) {
        $value = $dbLine -replace '^\s*DATABASE_URL\s*=', ''
        # WSL 端口转发对 IPv6 回环不稳定，统一走 127.0.0.1，避免 Prisma 解析到 ::1。
        $env:DATABASE_URL = (($value -replace '^["'']|["'']$', '').Trim()) -replace '@localhost(?=[:/])', '@127.0.0.1'
    }
    & pnpm --filter '@ai-office/bff' db:push
    if ($LASTEXITCODE -ne 0) { throw '数据库结构同步失败' }
}

Write-Step '构建共享包 @ai-office/shared'
& pnpm --filter '@ai-office/shared' build
if ($LASTEXITCODE -ne 0) { throw '共享包构建失败' }

$services = @(
    @{ Name = 'bff'; Filter = '@ai-office/bff' },
    @{ Name = 'web'; Filter = '@ai-office/web' },
    @{ Name = 'runtime'; Filter = '@ai-office/agent-runtime' }
)

foreach ($svc in $services) {
    $pidPath = Join-Path $runDir ($svc.Name + '.pid')
    if (Test-Path $pidPath) {
        $saved = (Get-Content $pidPath -Raw).Trim().Split('|')
        $existing = Get-Process -Id ([int]$saved[0]) -ErrorAction SilentlyContinue
        if ($existing) {
            Write-Host "    $($svc.Name) 已在运行（PID $($saved[0])），跳过" -ForegroundColor Yellow
            continue
        }
        Remove-Item $pidPath -Force
    }

    Write-Step "启动 $($svc.Name)（日志 logs/$($svc.Name).log）"
    $proc = Start-Process -FilePath 'cmd.exe' `
        -ArgumentList @('/c', "pnpm --filter $($svc.Filter) dev") `
        -WorkingDirectory $root -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $logDir ($svc.Name + '.log')) `
        -RedirectStandardError (Join-Path $logDir ($svc.Name + '.err.log'))
    Save-Pid $pidPath $proc
}

Write-Step '等待服务就绪'
$allReady = $true
if (-not (Wait-Port 4000 'BFF' $TimeoutSeconds)) { $allReady = $false }
if (-not (Wait-Port 3000 'Web' $TimeoutSeconds)) { $allReady = $false }
if (-not (Wait-Port 4001 'Agent Runtime' $TimeoutSeconds)) { $allReady = $false }

if ($allReady) {
    Write-Host ''
    Write-Host '项目已启动：' -ForegroundColor Green
    Write-Host '  Web      http://localhost:3000'
    Write-Host '  BFF      http://localhost:4000'
    Write-Host '  Runtime  http://127.0.0.1:4001'
} else {
    Write-Warning '部分服务未就绪，请查看 logs/ 下的日志；修复后重新运行 start.cmd'
    exit 1
}
