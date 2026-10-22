<#
  挂载 XJTU-Study-Assistant 公网版：本地服务 + 本地反代 + frp 隧道，并**逐层校验到公网**。

  与 dschat 那套（E:\WHYidea\dschat\run.bat + cleanup.ps1）对齐的做法：
    1. 先清理残留再启动 —— 端口占用或重复 frpc 会抢同一个代理名而注册失败；
    2. 每步都检查前置条件（node / 配置文件是否存在），缺了要喊出来，不静默继续；
    3. 幂等：已在跑的跳过，可安全反复执行（看护任务每 5 分钟跑一次）。

  比原来的版本多的一层（也正是之前踩的坑）：
    原来看护只校验 http://127.0.0.1:8866，于是**隧道死了照样报 ok** ——
    结果 study.xjtuwhy.com 整站 404，而任务记录显示"上次结果 0（成功）"。
    现在必须校验到公网域名，任何一层不通就 exit 1，看护任务能把它记成失败。

  用法：
    .\start-study-assistant.ps1                     # 常规（幂等）
    .\start-study-assistant.ps1 -Clean              # 先全清再起
    .\start-study-assistant.ps1 -PublicUrl 'http://xxx.yyy'   # 换成你的 HTTP 隧道域名
    .\start-study-assistant.ps1 -Quiet              # 只在出错时输出（看护用）

  ⚠ 本文件必须保存为 UTF-8 with BOM。
    Windows PowerShell 5.1 会把无 BOM 的 UTF-8 当 GBK 解码，中文注释被拆坏后
    会直接破坏脚本逻辑（曾导致进程检测全失效、误起重复 frpc）。
#>
param(
  [switch]$Clean,
  # 对外入口（可多个，逐个校验）。第一条是主入口。
  # passnat 的 HTTP 隧道比香港快约 20 倍（实测 0.1s vs 2.5s），所以放第一位。
  # 只关心某一条时：-PublicUrl 'http://studywhy.3q.hair'
  [string[]]$PublicUrl = @('http://studywhy.3q.hair', 'https://study.xjtuwhy.com'),
  [switch]$Quiet
)

$ErrorActionPreference = 'Stop'

$AppDir    = 'E:\WHYidea\XJTU-Study-Assistant\app'
$Node      = 'C:\Program Files\nodejs\node.exe'
$FrpDir    = 'E:\WHYidea\frp_0.61.1_windows_amd64'
$FrpStudy  = 'E:\WHYidea\XJTU-Study-Assistant\deploy\frpc-study.toml'
$LogDir    = Join-Path $AppDir 'data-www'
$ProxyDir  = 'E:\WHYidea\XJTU-Study-Assistant\deploy'
$ProxyLog  = Join-Path $ProxyDir 'logs'
$Curl      = 'C:\Windows\System32\curl.exe'
$WwwPort   = 8866
$ProxyPort = 9000

New-Item -ItemType Directory -Force -Path $LogDir, $ProxyLog | Out-Null

$script:Problems = New-Object System.Collections.Generic.List[string]

function Say([string]$msg) { if (-not $Quiet) { Write-Host $msg } }
function Note([string]$msg) { Write-Host $msg }

# 返回值会被 PS 5.1 展开成标量，调用处一律用 @() 包一层再判数量。
function Get-OurProcess([string]$name, [string]$pattern) {
  $procs = Get-CimInstance Win32_Process -Filter "Name='$name'" -ErrorAction SilentlyContinue
  @($procs | Where-Object { $_.CommandLine -and $_.CommandLine -match $pattern })
}

function Get-Status([string]$url) {
  # 用 curl 取状态码：Invoke-WebRequest 遇到 401/302 会抛异常，状态码不好取。
  if (-not (Test-Path $Curl)) { return -1 }
  # 0 = 连接层失败。passnat 那条在连续探测下**偶尔会丢一个连接**（实测立刻重测即 200），
  # 所以这里失败重试一次，别把隧道抖动报成"服务挂了"——假 FAIL 比漏报更伤信任。
  for ($try = 1; $try -le 2; $try++) {
    $code = & $Curl -s -o NUL -w '%{http_code}' -m 25 $url 2>$null
    if ($code -and [int]$code -ne 0) { return [int]$code }
    if ($try -lt 2) { Start-Sleep -Milliseconds 700 }
  }
  return 0
}

function Get-WsStatus([string]$url) {
  if (-not (Test-Path $Curl)) { return -1 }
  # 同样重试一次：隧道抖动不等于 WebSocket 真的不通。
  for ($try = 1; $try -le 2; $try++) {
    $code = & $Curl -s -o NUL -w '%{http_code}' -m 25 `
      -H 'Connection: Upgrade' -H 'Upgrade: websocket' `
      -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' -H 'Sec-WebSocket-Version: 13' $url 2>$null
    if ($code -and [int]$code -ne 0) { return [int]$code }
    if ($try -lt 2) { Start-Sleep -Milliseconds 700 }
  }
  return 0
}

# ------------------------------------------------------------- 0) 前置检查
Say ''
Say '=== 0) 前置检查 ==='
$needed = @(
  $Node,
  $FrpStudy,
  (Join-Path $FrpDir 'frpc.exe'),
  (Join-Path $ProxyDir 'local-proxy.js'),
  (Join-Path $AppDir 'bin\www.js')
)
foreach ($need in $needed) {
  if (Test-Path $need) { Say "  [ok]   $need" }
  else { Say "  [FAIL] 缺少 $need"; $script:Problems.Add("缺少文件: $need") }
}
if ($script:Problems.Count -gt 0) { Note ' 前置检查未通过，终止。'; exit 1 }

# --------------------------------------------------------------- 1) 清理
# 只清"属于本套"的进程，按**配置文件名**精确匹配：
# passnat 的 frpc、土豆麻将的 frpc-maj、dschat 的 frpc.toml 一律不动。
Say ''
Say '=== 1) 清理残留 ==='
$ours = @(
  @{ Name = 'node.exe'; Pattern = 'bin[\\/]www\.js';  Label = 'www' }
  @{ Name = 'node.exe'; Pattern = 'local-proxy\.js';  Label = 'local-proxy' }
  @{ Name = 'frpc.exe'; Pattern = 'frpc-study\.toml'; Label = 'frpc-study' }
)
foreach ($item in $ours) {
  $found = @(Get-OurProcess $item.Name $item.Pattern)
  $keep = $null
  # 每样只留最早启动的那一个；重复的会抢同一个代理名 / 端口
  if (-not $Clean -and $found.Count -ge 1) {
    $keep = ($found | Sort-Object CreationDate | Select-Object -First 1)
  }
  foreach ($proc in $found) {
    if ($keep -and $proc.ProcessId -eq $keep.ProcessId) { continue }
    Say "  [kill] $($item.Label) pid=$($proc.ProcessId)"
    Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
  }
  if ($keep) { Say "  [keep] $($item.Label) pid=$($keep.ProcessId)" }
}
if ($Clean) { Start-Sleep -Seconds 2 }

# ----------------------------------------------------------- 2) 本地服务
Say ''
Say '=== 2) 本地服务（bin/www.js）==='
$www = @(Get-OurProcess 'node.exe' 'bin[\\/]www\.js')
if ($www.Count -gt 0) {
  Say "  [skip] 已在运行 pid=$($www.ProcessId -join ',')"
} else {
  $env:POTATO_WWW_PORT           = "$WwwPort"
  $env:POTATO_WWW_HOST           = '127.0.0.1'
  $env:POTATO_WWW_TRUST_PROXY    = '1'
  # 对外是 http 隧道（没备案，拿不到 443）：给 Cookie 加 Secure 会被浏览器丢弃，
  # 表现就是「登录成功却一直卡在登录页」。只有确认对外 https 时才改回 '1'。
  $env:POTATO_WWW_SECURE_COOKIES = '0'
  $p = Start-Process -FilePath $Node -ArgumentList 'bin/www.js' -WorkingDirectory $AppDir `
        -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $LogDir 'www.log') `
        -RedirectStandardError  (Join-Path $LogDir 'www-error.log') -PassThru
  Say "  [start] pid=$($p.Id)"
}

# ------------------------------------------------------------- 3) 本地反代
Say ''
Say "=== 3) 本地反代（127.0.0.1:$ProxyPort -> $WwwPort）==="
$proxy = @(Get-OurProcess 'node.exe' 'local-proxy\.js')
if ($proxy.Count -gt 0) {
  Say "  [skip] 已在运行 pid=$($proxy.ProcessId -join ',')"
} else {
  $p2 = Start-Process -FilePath $Node -ArgumentList (Join-Path $ProxyDir 'local-proxy.js') `
        -WorkingDirectory $ProxyDir -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $ProxyLog 'local-proxy.log') `
        -RedirectStandardError  (Join-Path $ProxyLog 'local-proxy-error.log') -PassThru
  Say "  [start] pid=$($p2.Id)"
}

# --------------------------------------------------------------- 4) 隧道
Say ''
Say '=== 4) frp 隧道（study.xjtuwhy.com）==='
$frpc = @(Get-OurProcess 'frpc.exe' 'frpc-study\.toml')
if ($frpc.Count -gt 0) {
  Say "  [skip] 已在运行 pid=$($frpc.ProcessId -join ',')"
} else {
  $p3 = Start-Process -FilePath (Join-Path $FrpDir 'frpc.exe') -ArgumentList '-c', $FrpStudy `
        -WorkingDirectory $FrpDir -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $ProxyLog 'frpc-study.log') `
        -RedirectStandardError  (Join-Path $ProxyLog 'frpc-study-error.log') -PassThru
  Say "  [start] pid=$($p3.Id)"
}

# ------------------------------------------------- 5) 逐层校验（验到公网）
Say ''
Say '=== 5) 逐层校验 ==='
Start-Sleep -Seconds 6

# L1 / L2 只验一次：两条公网入口共用同一套本地服务与反代。
Say '  -- 本地 --'
$local = @(
  @{ Name = 'L1 本地服务'; Url = "http://127.0.0.1:$WwwPort/";   Expect = 200 }
  @{ Name = 'L2 本地反代'; Url = "http://127.0.0.1:$ProxyPort/"; Expect = 200 }
)
foreach ($layer in $local) {
  $got = Get-Status $layer.Url
  if ($got -eq $layer.Expect) {
    Say ("  [ok]   {0,-12} {1}" -f $layer.Name, $got)
  } else {
    Say ("  [FAIL] {0,-12} 期望 {1}，实际 {2}" -f $layer.Name, $layer.Expect, $got)
    $script:Problems.Add("$($layer.Name) 期望 $($layer.Expect) 实际 $got")
  }
}

# 每条公网入口各验一遍。任一条不通就算失败 —— 想只盯某一条，用 -PublicUrl 只传它。
$total = @($PublicUrl).Count
$idx = 0
foreach ($base in $PublicUrl) {
  $idx++
  $hostLabel = ([Uri]$base).Host
  Say ""
  Say ("  -- 公网 {0}/{1}：{2} --" -f $idx, $total, $hostLabel)

  $layers = @(
    @{ Name = '入口';   Path = '/';               Expect = 200 }
    @{ Name = '登录页'; Path = '/login/';         Expect = 200 }
    @{ Name = 'CSS';    Path = '/login/login.css'; Expect = 200 }
    @{ Name = 'JS';     Path = '/login/login.js'; Expect = 200 }
    @{ Name = '账号接口'; Path = '/auth/config';   Expect = 200 }
    @{ Name = '登录取向'; Path = '/app';           Expect = 302 }
  )
  foreach ($layer in $layers) {
    $got = Get-Status ($base.TrimEnd('/') + $layer.Path)
    if ($got -eq $layer.Expect) {
      Say ("    [ok]   {0,-8} {1}" -f $layer.Name, $got)
    } else {
      Say ("    [FAIL] {0,-8} 期望 {1}，实际 {2}" -f $layer.Name, $layer.Expect, $got)
      $script:Problems.Add("[$hostLabel] $($layer.Name) 期望 $($layer.Expect) 实际 $got")
    }
  }

  # /ws 未登录必须回 401：说明 WebSocket 升级一路打到应用（AI 流式回复靠它）。
  $ws = Get-WsStatus ($base.TrimEnd('/') + '/ws')
  if ($ws -eq 401) {
    Say ("    [ok]   {0,-8} 401" -f 'WebSocket')
  } else {
    Say ("    [FAIL] {0,-8} 期望 401，实际 {1}" -f 'WebSocket', $ws)
    $script:Problems.Add("[$hostLabel] WebSocket 期望 401 实际 $ws")
  }
}

# --------------------------------------------------------------- 结论
Say ''
if ($script:Problems.Count -eq 0) {
  Say ("全部就绪：{0}" -f ($PublicUrl -join '  |  '))
  exit 0
}
Note '以下环节有问题：'
foreach ($item in $script:Problems) { Note "  - $item" }
Note ''
Note '定位提示：'
Note "  L1 挂 -> 看 $LogDir\www-error.log"
Note "  L2 挂 -> 看 $ProxyLog\local-proxy-error.log"
Note "  L3 挂 -> 看 $ProxyLog\frpc-study.log（没有 'start proxy success' 就是隧道没注册上）"
Note '       passnat 那条不在本脚本管理范围：去 passnat 客户端看隧道状态（本地 9000 是否在转）。'
exit 1
