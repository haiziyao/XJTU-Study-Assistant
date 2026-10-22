<#
  一键启动面板用的「详细状态」。
  所有中文输出与探测都在这里做 —— 放 batch 里会被引号/编码反复坑。

  ⚠ 本文件必须保存为 UTF-8 with BOM（PowerShell 5.1 的编码要求）。
#>
$ErrorActionPreference = 'SilentlyContinue'

$Curl = 'C:\Windows\System32\curl.exe'
$Primary = 'http://studywhy.3q.hair'
$Backup = 'https://study.xjtuwhy.com'

function Get-Status([string]$url, [int]$timeout = 8) {
  if (-not (Test-Path $Curl)) { return '无curl' }
  $code = & $Curl -s -o NUL -w '%{http_code}' -m $timeout $url 2>$null
  if (-not $code) { return '连不上' }
  return $code
}

function Show-Probe([string]$label, [string]$url, [string]$expect, [int]$timeout = 8) {
  $got = Get-Status $url $timeout
  $mark = if ($got -eq $expect) { '[ok]  ' } else { '[FAIL]' }
  Write-Host ("   {0} {1,-22} {2,-8} 期望 {3}" -f $mark, $label, $got, $expect)
}

Write-Host ''
Write-Host '   == 逐层状态 =='
Write-Host ''
Show-Probe 'L1 本地服务 8866' 'http://127.0.0.1:8866/' '200'
Show-Probe 'L2 本地反代 9000' 'http://127.0.0.1:9000/' '200'
Show-Probe 'L3 主入口 首页'   "$Primary/"          '200'
Show-Probe 'L3 主入口 登录页' "$Primary/login/"    '200'
Show-Probe 'L3 主入口 /app'   "$Primary/app"       '302'
Show-Probe 'L3 主入口 /ws'    "$Primary/ws"        '401'
Show-Probe 'L3 备用   首页'   "$Backup/"           '200' 20
Show-Probe 'L3 备用   /app'   "$Backup/app"        '302' 20

Write-Host ''
Write-Host '   == 进程 =='
$procs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue
foreach ($p in $procs) {
  if ($p.Name -eq 'node.exe') {
    if ($p.CommandLine -match 'bin[\\/]www\.js') { Write-Host ("      {0,-13} pid={1}" -f 'www', $p.ProcessId) }
    elseif ($p.CommandLine -match 'local-proxy') { Write-Host ("      {0,-13} pid={1}" -f 'local-proxy', $p.ProcessId) }
  } elseif ($p.Name -eq 'frpc.exe') {
    $tag = if ($p.CommandLine -match 'frpc-study\.toml') { 'study 隧道' }
           elseif ($p.CommandLine -match 'frpc-maj\.toml') { '土豆麻将' }
           elseif ($p.CommandLine -match 'frpc\.toml') { 'dschat' }
           else { 'passnat' }
    Write-Host ("      {0,-13} pid={1}" -f $tag, $p.ProcessId)
  }
}

Write-Host ''
Write-Host '   == 看护任务 =='
$info = Get-ScheduledTaskInfo -TaskName 'XJTU-Study-Assistant' -ErrorAction SilentlyContinue
if ($info) {
  $text = switch ($info.LastTaskResult) {
    0 { '成功' }
    267009 { '正在运行' }
    default { '失败' }
  }
  Write-Host ("      结果 = {0}  ({1})   上次 {2}" -f $info.LastTaskResult, $text, $info.LastRunTime)
} else {
  Write-Host '      没有注册计划任务'
}
