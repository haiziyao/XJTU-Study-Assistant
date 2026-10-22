<#
  卸下 XJTU-Study-Assistant 这一套（服务 + 反代 + 隧道），对应 dschat 的 cleanup.ps1。

  只停"属于本套"的进程，按**配置文件名**精确匹配：
    - www          node.exe  + bin/www.js
    - local-proxy  node.exe  + local-proxy.js
    - frpc-study   frpc.exe  + frpc-study.toml
  一律不动：passnat 的 frpc、土豆麻将的 frpc-maj.toml、dschat 的 frpc.toml。

  ⚠ 本文件必须保存为 UTF-8 with BOM（PowerShell 5.1 的编码要求，见挂载脚本顶部说明）。
#>
$ErrorActionPreference = 'SilentlyContinue'

function Stop-OurProcess([string]$name, [string]$pattern, [string]$label) {
  $procs = Get-CimInstance Win32_Process -Filter "Name='$name'"
  $hits = @($procs | Where-Object { $_.CommandLine -and $_.CommandLine -match $pattern })
  if ($hits.Count -eq 0) { Write-Host "  [skip] $label 没在跑"; return }
  foreach ($proc in $hits) {
    Write-Host "  [stop] $label pid=$($proc.ProcessId)"
    Stop-Process -Id $proc.ProcessId -Force
  }
}

Write-Host '=== 卸下 XJTU-Study-Assistant ==='
Stop-OurProcess 'frpc.exe' 'frpc-study\.toml'  'frpc-study（隧道）'
Stop-OurProcess 'node.exe' 'local-proxy\.js'   'local-proxy（反代）'
Stop-OurProcess 'node.exe' 'bin[\\/]www\.js'   'www（本地服务）'

Start-Sleep -Seconds 2
Write-Host ''
foreach ($port in @(8866, 9000)) {
  $busy = Get-NetTCPConnection -State Listen -LocalPort $port
  Write-Host ("  端口 {0}: {1}" -f $port, $(if ($busy) { "仍被占用 pid=$($busy.OwningProcess)" } else { '已释放' }))
}
Write-Host ''
Write-Host '完成。看护计划任务仍在运行，5 分钟内会把这套重新拉起来；'
Write-Host '要彻底停掉请先执行：Unregister-ScheduledTask -TaskName ''XJTU-Study-Assistant'' -Confirm:$false'
