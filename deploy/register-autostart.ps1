# 注册计划任务：让学习助理（www + frpc）自动保持运行。
#   - 登录时拉起一次
#   - 之后每 5 分钟做一次看护（脚本幂等，已在跑就跳过，不会重复起进程）
# 幂等：重复执行会覆盖同名任务。
#
# 注意：本文件必须以 UTF-8 with BOM 保存。Windows PowerShell 5.1 会把无 BOM 的
# UTF-8 当成 GBK 解码，中文注释被拆坏后会直接破坏脚本逻辑。

$ErrorActionPreference = 'Stop'

$TaskName = 'XJTU-Study-Assistant'
$Script   = 'E:\WHYidea\XJTU-Study-Assistant\deploy\start-study-assistant.ps1'
$PsExe    = 'C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe'

if (-not (Test-Path -LiteralPath $Script)) {
  throw "找不到启动脚本: $Script"
}

$action = New-ScheduledTaskAction -Execute $PsExe `
  -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f $Script)

# 触发器 1：登录
$triggerLogon = New-ScheduledTaskTrigger -AtLogOn -User ("{0}\{1}" -f $env:USERDOMAIN, $env:USERNAME)

# 触发器 2：一分钟起算，每 5 分钟重复一次。
# 不传 -RepetitionDuration 即为无限期；传 [TimeSpan]::MaxValue 会生成
# P99999999DT... 被任务计划程序判为超范围（0x80041318），注册会失败。
$triggerWatch = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes 5)

$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $TaskName -Action $action `
  -Trigger $triggerLogon, $triggerWatch -Settings $settings `
  -Description 'XJTU-Study-Assistant 公网版：自动拉起 bin/www.js 与 frpc-study 隧道，并每 5 分钟看护' -Force -ErrorAction Stop | Out-Null

$t = Get-ScheduledTask -TaskName $TaskName
if (@($t.Triggers).Count -lt 2) {
  throw "注册后只有 $(@($t.Triggers).Count) 个触发器，看护触发器没生效"
}

Write-Host "[ok] 任务已注册: $($t.TaskName)  状态=$($t.State)  触发器数=$(@($t.Triggers).Count)"
foreach ($tr in $t.Triggers) {
  Write-Host "       - $($tr.CimClass.CimClassName)  重复间隔=$($tr.Repetition.Interval)"
}
Write-Host ""
Write-Host "如需删除: Unregister-ScheduledTask -TaskName '$TaskName' -Confirm:`$false"
