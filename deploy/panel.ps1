<#
  AI 智学 · 一键启动面板（真正的界面）

  为什么主体在这里而不是 .bat 里：批处理文件必须按控制台代码页（本机 936/GBK）保存，
  而项目里的文本是 UTF-8。来回转码时中文会被替换成 U+FFFD（控制台里显示成"锟斤拷"），
  而且 cmd 解析批处理时还会因为多字节字符吞换行。PowerShell 走 .NET 的 Console，
  在 cp936 控制台上直接输出中文是正确的，所以把横幅、菜单、状态全放这里，
  桌面上那个 .bat 只负责用绝对路径把它叫起来（纯 ASCII，零编码风险）。

  ⚠ 本文件必须保存为 UTF-8 with BOM。
#>

$Deploy  = 'E:\WHYidea\XJTU-Study-Assistant\deploy'
$Primary = 'http://studywhy.3q.hair'
$Backup  = 'https://study.xjtuwhy.com'
$AppDir  = 'E:\WHYidea\XJTU-Study-Assistant\app'
$FrpDir  = 'E:\WHYidea\frp_0.61.1_windows_amd64'
$Curl    = 'C:\Windows\System32\curl.exe'
$DoWork  = Join-Path $Deploy 'start-study-assistant.ps1'

$Title = 'AI 智学 - 一键启动面板'
try { $Host.UI.RawUI.WindowTitle = $Title } catch { }

function Show-Banner {
  Write-Host ''
  Write-Host '  ======================================================================  ' -ForegroundColor DarkCyan
  Write-Host '                                                                          ' -ForegroundColor DarkCyan
  Write-Host '        ####     A I   智 学     ####            一 键 启 动 面 板        ' -ForegroundColor Cyan
  Write-Host '        XJTU-Study-Assistant          ·          公网部署                ' -ForegroundColor DarkGray
  Write-Host '                                                                          ' -ForegroundColor DarkCyan
  Write-Host '        本地服务  127.0.0.1:8866   ->   本地反代  127.0.0.1:9000          ' -ForegroundColor DarkGray
  Write-Host ("        出口 1    {0,-42}" -f $Primary) -ForegroundColor DarkGray
  Write-Host ("        出口 2    {0,-42}" -f $Backup) -ForegroundColor DarkGray
  Write-Host '                                                                          ' -ForegroundColor DarkCyan
  Write-Host '  ======================================================================  ' -ForegroundColor DarkCyan
  Write-Host ''
}

function Get-Code([string]$Url, [int]$Timeout = 8) {
  if (-not (Test-Path $Curl)) { return '无curl' }
  $code = & $Curl -s -o NUL -w '%{http_code}' -m $Timeout $Url 2>$null
  if (-not $code -or $code -eq '000') { return '连不上' }
  return "$code"
}

function Show-QuickLine {
  Write-Host '  ----------------------------------------------------------------------' -ForegroundColor DarkGray
  foreach ($pair in @(@('主入口 passnat', $Primary), @('备用   香港  ', $Backup))) {
    $code = Get-Code ($pair[1] + '/')
    $color = if ($code -eq '200') { 'Green' } else { 'Red' }
    Write-Host ("    {0}   " -f $pair[0]) -NoNewline
    Write-Host ("{0,-8}" -f $code) -ForegroundColor $color -NoNewline
    Write-Host $pair[1] -ForegroundColor DarkGray
  }
  Write-Host '  ----------------------------------------------------------------------' -ForegroundColor DarkGray
}

function Invoke-Step([string]$Script, [string[]]$Extra = @()) {
  if (-not (Test-Path $Script)) { Write-Host "  找不到脚本：$Script" -ForegroundColor Red; return $false }
  & $Script @Extra
  return ($LASTEXITCODE -eq 0 -or $null -eq $LASTEXITCODE)
}

function Show-Menu {
  Write-Host ''
  Write-Host '    [1] 启动 / 重启全部        [2] 查看详细状态' -ForegroundColor White
  Write-Host '    [3] 停止全部              [4] 多端同步自检' -ForegroundColor White
  Write-Host '    [5] 打开主入口（passnat，快）' -ForegroundColor White
  Write-Host '    [6] 打开备用入口（香港，HTTPS）' -ForegroundColor White
  Write-Host '    [7] 打开项目文件夹        [8] 看日志' -ForegroundColor White
  Write-Host '    [0] 退出' -ForegroundColor White
  Write-Host ''
}

function Wait-Key {
  Write-Host ''
  Write-Host '  按回车返回菜单...' -ForegroundColor DarkGray -NoNewline
  [void](Read-Host)
}

# ------------------------------------------------------------------ 主循环
Clear-Host
Show-Banner

Write-Host '  正在挂载，请稍候（约 30-60 秒，穿隧道逐层校验比较慢）' -ForegroundColor Yellow
Write-Host ''
$ok = Invoke-Step $DoWork
if ($ok) {
  Write-Host ''
  Write-Host '  [OK] 本地服务 / 本地反代 / 两条公网入口 全部通过。' -ForegroundColor Green
} else {
  Write-Host ''
  Write-Host '  [警告] 有环节失败 —— 看上面标了 [FAIL] 的行。' -ForegroundColor Red
}

while ($true) {
  Write-Host ''
  Show-QuickLine
  Show-Menu
  $pick = Read-Host '   请选择编号后回车'
  if ([string]::IsNullOrWhiteSpace($pick)) { break }

  switch ($pick.Trim()) {
    '1' {
      Clear-Host; Show-Banner
      Write-Host '  重新挂载中...' -ForegroundColor Yellow
      [void](Invoke-Step $DoWork)
      Show-QuickLine
      Wait-Key
    }
    '2' {
      Clear-Host; Show-Banner
      [void](Invoke-Step (Join-Path $Deploy 'status.ps1'))
      Wait-Key
    }
    '3' {
      Clear-Host; Show-Banner
      Write-Host '  停止本套服务（不动 passnat / 土豆麻将 / dschat）' -ForegroundColor Yellow
      Write-Host ''
      [void](Invoke-Step (Join-Path $Deploy 'unmount.ps1'))
      Wait-Key
    }
    '4' {
      Clear-Host; Show-Banner
      [void](Invoke-Step (Join-Path $Deploy 'check-sync.ps1'))
      Wait-Key
    }
    '5' { Start-Process $Primary }
    '6' { Start-Process $Backup }
    '7' { Start-Process explorer.exe $AppDir }
    '8' {
      Clear-Host; Show-Banner
      Write-Host '  日志位置（同时打开文件夹）' -ForegroundColor Yellow
      Write-Host ''
      Write-Host "    本地服务   $AppDir\data-www\www.log"
      Write-Host "    服务错误   $AppDir\data-www\www-error.log"
      Write-Host "    本地反代   $Deploy\logs\local-proxy.log"
      Write-Host "    反代错误   $Deploy\logs\local-proxy-error.log"
      Write-Host "    frp 隧道   $FrpDir\frpc-study.log"
      Write-Host ''
      Start-Process explorer.exe (Join-Path $Deploy 'logs')
      Wait-Key
    }
    '0' { break }
    default {
      Write-Host '   无效编号。' -ForegroundColor Red
      Start-Sleep -Seconds 1
    }
  }
  if ($pick.Trim() -eq '0') { break }
}

Write-Host ''
Write-Host '  再见。' -ForegroundColor DarkGray
Start-Sleep -Milliseconds 600
