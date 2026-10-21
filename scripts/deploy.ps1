#Requires -Version 5.1
[CmdletBinding()]
param(
    # 停止并移除容器（保留数据卷）；配合 -Purge 连数据卷一起删除。
    [switch]$Down,
    [switch]$Purge,
    # 同时部署运营端（默认只部署客户端栈）。
    [switch]$WithAdmin,
    # 只构建并启动运营端（内网部署场景）。
    [switch]$AdminOnly,
    # 跳过镜像构建（仅复用已有镜像）。
    [switch]$NoBuild,
    # 启动后持续输出日志（Ctrl+C 退出，不影响容器）。
    [switch]$Logs,
    [string]$EnvFile = '.env.docker'
)

if ($WithAdmin -and $AdminOnly) { throw '-WithAdmin 与 -AdminOnly 不能同时使用' }

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$root = Split-Path -Parent $PSScriptRoot

function Write-Step([string]$Text) { Write-Host "==> $Text" -ForegroundColor Cyan }

# PowerShell 5.1 在 ErrorActionPreference=Stop 下会把原生命令的 stderr 当成
# 终止错误（docker 的弃用提示、compose 的构建进度都走 stderr），因此原生命令
# 一律在 Continue 下执行，只用 $LASTEXITCODE 判断成败。
function Invoke-Native([string]$Exe, [string[]]$Arguments, [switch]$Quiet) {
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        if ($Quiet) {
            & $Exe @Arguments 2>&1 | Out-Null
        } else {
            & $Exe @Arguments
        }
        return $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $prev
    }
}

function Get-ComposeArgs {
    if ((Invoke-Native 'docker' @('info') -Quiet) -ne 0) {
        throw 'Docker 未运行：请先启动 Docker Desktop / docker 服务'
    }
    if ((Invoke-Native 'docker' @('compose', 'version') -Quiet) -eq 0) {
        return 'docker', 'compose'
    }
    if ((Get-Command docker-compose -ErrorAction SilentlyContinue) -and
        ((Invoke-Native 'docker-compose' @('--version') -Quiet) -eq 0)) {
        return 'docker-compose'
    }
    throw '未找到 Docker Compose：请安装 Docker Desktop 或 docker-compose 插件'
}

function Invoke-Compose([string[]]$ComposeArgs) {
    $compose = @(Get-ComposeArgs)
    $exe = $compose[0]
    $prefix = @()
    if ($compose.Count -gt 1) { $prefix = $compose[1..($compose.Count - 1)] }
    $fileArgs = @()
    if (Test-Path $EnvFile) { $fileArgs = @('--env-file', $EnvFile) }
    $code = Invoke-Native $exe (@($prefix) + @($fileArgs) + @($ComposeArgs))
    if ($code -ne 0) { throw "compose 命令失败（退出码 $code）" }
}

function New-Hex([int]$Bytes) {
    $buf = New-Object byte[] $Bytes
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($buf) } finally { $rng.Dispose() }
    return -join ($buf | ForEach-Object { $_.ToString('x2') })
}

function Read-DotEnv([string]$Path) {
    $map = @{}
    if (-not (Test-Path $Path)) { return $map }
    foreach ($line in Get-Content -LiteralPath $Path -Encoding UTF8) {
        if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
            $map[$matches[1]] = $matches[2].Trim().Trim('"').Trim("'")
        }
    }
    return $map
}

function Set-DotEnvValue([string]$Path, [string]$Key, [string]$Value) {
    $lines = @(Get-Content -LiteralPath $Path -Encoding UTF8)
    $pattern = '^\s*' + [regex]::Escape($Key) + '\s*='
    $found = $false
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match $pattern) {
            $lines[$i] = "$Key=$Value"
            $found = $true
            break
        }
    }
    if (-not $found) { $lines += "$Key=$Value" }
    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllLines((Resolve-Path -LiteralPath $Path).Path, $lines, $encoding)
}

function Initialize-EnvFile {
    if (Test-Path $EnvFile) { return }
    Write-Step "生成 $EnvFile（随机密钥；模型配置优先复用根 .env）"
    Copy-Item -LiteralPath '.env.docker.example' -Destination $EnvFile

    $secrets = @{
        POSTGRES_PASSWORD    = (New-Hex 16)
        MINIO_ROOT_PASSWORD  = (New-Hex 16)
        JWT_SECRET           = (New-Hex 32)
        CONNECTOR_ENC_KEY    = (New-Hex 32)
        AGENT_RUNTIME_TOKEN  = (New-Hex 24)
        INTERNAL_TOKEN       = (New-Hex 24)
        ALERT_WEBHOOK_SECRET = (New-Hex 24)
    }
    foreach ($key in $secrets.Keys) { Set-DotEnvValue $EnvFile $key $secrets[$key] }

    $dev = Read-DotEnv '.env'
    $reuse = @(
        'DEEPSEEK_API_KEY', 'MODEL_BASE_URL', 'MODEL_NAME', 'TAVILY_API_KEY',
        'EMBEDDING_BASE_URL', 'EMBEDDING_API_KEY', 'EMBEDDING_MODEL', 'EMBEDDING_DIM'
    )
    foreach ($key in $reuse) {
        if ($dev.ContainsKey($key) -and $dev[$key]) { Set-DotEnvValue $EnvFile $key $dev[$key] }
    }
    Write-Host "    已生成 $EnvFile；如需更换模型/地址，请编辑后重新运行" -ForegroundColor Yellow
}

function Test-ComposeProjectRunning {
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $names = & docker ps --filter 'label=com.docker.compose.project=ai-office' --format '{{.Names}}' 2>$null
        if ($LASTEXITCODE -ne 0) { return $false }
        return [bool](@($names | Where-Object { $_ }).Count -gt 0)
    } finally {
        $ErrorActionPreference = $prev
    }
}

function Wait-Http([string]$Url, [int]$Seconds) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $res = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 3
            if ($res.StatusCode -ge 200 -and $res.StatusCode -lt 400) { return $true }
        } catch {
            # 容器尚未就绪。
        }
        Start-Sleep -Seconds 2
    }
    return $false
}

Set-Location $root

if ($Down) {
    Write-Step '停止容器'
    # 带上 admin profile，确保之前用 -WithAdmin 启动的运营端也被清理。
    $downArgs = @('--profile', 'admin', 'down', '--remove-orphans')
    if ($Purge) {
        Write-Host '    同时删除数据卷（数据库/对象存储/Redis 全部清空）' -ForegroundColor Yellow
        $downArgs += '-v'
    }
    Invoke-Compose $downArgs
    Write-Host '已停止。' -ForegroundColor Green
    exit 0
}

if (-not (Test-Path $EnvFile)) { Initialize-EnvFile }
$envMap = Read-DotEnv $EnvFile
if (-not $envMap['POSTGRES_PASSWORD'] -or -not $envMap['JWT_SECRET'] -or -not $envMap['CONNECTOR_ENC_KEY']) {
    throw "$EnvFile 缺少必填密钥：请删除该文件后重新运行，或参照 .env.docker.example 手工填写"
}
$webPort = if ($envMap['WEB_PORT']) { [int]$envMap['WEB_PORT'] } else { 3000 }
$bffPort = if ($envMap['BFF_PORT']) { [int]$envMap['BFF_PORT'] } else { 4000 }
$adminPort = if ($envMap['ADMIN_WEB_PORT']) { [int]$envMap['ADMIN_WEB_PORT'] } else { 3001 }
$adminBind = if ($envMap['ADMIN_WEB_BIND']) { $envMap['ADMIN_WEB_BIND'] } else { '127.0.0.1' }
# 绑定到指定内网网卡时用该地址探活；0.0.0.0 与回环都走 127.0.0.1。
$adminHost = if ($adminBind -eq '0.0.0.0') { '127.0.0.1' } else { $adminBind }

if (-not (Test-ComposeProjectRunning)) {
    $ports = @()
    if (-not $AdminOnly) { $ports += $webPort; $ports += $bffPort }
    if ($AdminOnly -or $WithAdmin) { $ports += $adminPort }
    foreach ($port in $ports) {
        $listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
        if ($listener) {
            throw "端口 $port 已被占用：请先停止占用进程（或修改 $EnvFile 中的端口配置）"
        }
    }
}

if ($AdminOnly) {
    $upArgs = @('--profile', 'admin', 'up', '-d', '--no-deps')
    if (-not $NoBuild) { $upArgs += '--build' }
    $upArgs += 'admin-web'
    Write-Step '构建并启动运营端（独立部署，不启动客户端栈）'
} else {
    $upArgs = @('up', '-d', '--remove-orphans')
    if ($WithAdmin) { $upArgs = @('--profile', 'admin') + $upArgs }
    if (-not $NoBuild) { $upArgs += '--build' }
    Write-Step '构建并启动容器（首次构建约数分钟）'
}
Invoke-Compose $upArgs

Write-Step '等待服务就绪'
$failed = $false
if (-not $AdminOnly) {
    $bffReady = Wait-Http "http://127.0.0.1:$bffPort/api/health" 240
    $webReady = Wait-Http "http://127.0.0.1:$webPort/" 120
    if (-not ($bffReady -and $webReady)) {
        Write-Warning '部分服务未在预期时间内就绪，请查看日志：'
        Invoke-Compose @('ps')
        Invoke-Compose @('logs', '--tail', '80', 'bff', 'agent-runtime', 'web')
        $failed = $true
    }
}
if ($AdminOnly -or $WithAdmin) {
    if (-not (Wait-Http "http://${adminHost}:$adminPort/login" 120)) {
        Write-Warning '运营端未在预期时间内就绪，请查看日志：'
        Invoke-Compose @('logs', '--tail', '80', 'admin-web')
        $failed = $true
    }
}
if ($failed) { exit 1 }

$composeText = (@(Get-ComposeArgs) -join ' ')
Write-Host ''
Write-Host '部署完成：' -ForegroundColor Green
if (-not $AdminOnly) {
    Write-Host "  Web      http://localhost:$webPort"
    Write-Host "  BFF      http://localhost:$bffPort  （健康检查 /api/health）"
}
if ($AdminOnly -or $WithAdmin) {
    Write-Host "  运营端   http://${adminHost}:$adminPort  （绑定 $adminBind，请勿直接暴露公网）"
}
if ($AdminOnly) {
    Write-Host "  日志     $composeText --env-file $EnvFile logs -f admin-web"
} else {
    Write-Host "  日志     $composeText --env-file $EnvFile logs -f bff"
    Write-Host "  提升管理员 $composeText --env-file $EnvFile exec bff node scripts/promote-admin.mjs <邮箱>"
}
Write-Host "  停止     .\deploy.cmd -Down   （加 -Purge 连数据卷删除）"
if (-not $AdminOnly -and -not $envMap['DEEPSEEK_API_KEY']) {
    Write-Warning 'DEEPSEEK_API_KEY 为空：Agent 将使用 Mock 模型，仅用于链路验证'
}
if (-not $AdminOnly -and -not $envMap['EMBEDDING_API_KEY']) {
    Write-Warning 'EMBEDDING_API_KEY 为空：知识库文档向量化不可用'
}

if ($Logs) { Invoke-Compose @('logs', '-f', '--tail', '100') }
