<#
  同步自检：确认服务端的多端同步接口是通的。

  为什么单独做这个：桌面端拿到 404 时会提示"这台服务器上没有同步接口，请升级服务器"，
  看起来像版本落后，实际可能是接口被关了（模块没加载）或网关没转发。
  这里直接打接口，一眼看出是"通 / 404 / 401 / 连不上"。

  ⚠ 本文件必须保存为 UTF-8 with BOM（PowerShell 5.1 的编码要求）。
#>
$ErrorActionPreference = 'SilentlyContinue'

$SessionFile = 'E:\WHYidea\XJTU-Study-Assistant\app\data-www\sessions.json'
$Curl = 'C:\Windows\System32\curl.exe'
$Entries = @('http://studywhy.3q.hair', 'https://study.xjtuwhy.com')

Write-Host ''
Write-Host '   == 多端同步自检 =='
Write-Host ''

if (-not (Test-Path $SessionFile)) {
  Write-Host "   [跳过] 没有账号库：$SessionFile"
  Write-Host '          先在本机网页登录一次，再来看这里。'
  exit 1
}

$store = Get-Content $SessionFile -Raw -Encoding UTF8 | ConvertFrom-Json
$now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$live = @($store.items | Where-Object { $_.expiresAt -gt $now } | Sort-Object createdAt)
if ($live.Count -eq 0) {
  Write-Host '   [跳过] 本机没有仍有效的会话，请先在网页登录一次。'
  exit 1
}

$token = $live[-1].token
$ok = 0
foreach ($base in $Entries) {
  $url = "$base/api/v1/sync/status"
  $body = & $Curl -s -m 20 -H "Cookie: potato_session=$token" $url
  $code = & $Curl -s -o NUL -w '%{http_code}' -m 20 -H "Cookie: potato_session=$token" $url
  if ($code -eq '200') {
    $ok++
    $device = ''
    $last = ''
    try {
      $j = $body | ConvertFrom-Json
      $device = $j.deviceName
      $last = if ($j.lastPushAt) { $j.lastPushAt } else { $j.lastPullAt }
    } catch { }
    Write-Host ("   [OK]   {0,-28} 200   设备={1}  最近={2}" -f $base, $device, $last)
  } elseif ($code -eq '404') {
    Write-Host ("   [FAIL] {0,-28} 404   接口不存在 —— 服务端没加载 sync 模块（不是版本问题）" -f $base)
  } elseif ($code -eq '401') {
    Write-Host ("   [FAIL] {0,-28} 401   会话无效 —— 重新登录一次" -f $base)
  } elseif ($code -eq '000' -or -not $code) {
    Write-Host ("   [FAIL] {0,-28} 连不上" -f $base)
  } else {
    Write-Host ("   [FAIL] {0,-28} {1}" -f $base, $code)
  }
}

Write-Host ''
if ($ok -eq $Entries.Count) {
  Write-Host '   结论：两条入口的同步接口都正常。桌面端点「立即同步」即可。'
} elseif ($ok -gt 0) {
  Write-Host '   结论：至少有一条入口可用，桌面端换那条服务器地址即可。'
} else {
  Write-Host '   结论：都不可用。看服务端日志里是否有 "服务端版不加载模块" 提到 sync。'
}
