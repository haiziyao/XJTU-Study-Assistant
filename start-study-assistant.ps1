param(
  [switch]$Check,
  [ValidateRange(1024, 65535)]
  [int]$Port = 33210
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$appDir = Join-Path $projectRoot 'app'
$packageFile = Join-Path $appDir 'package.json'
$dataDir = Join-Path $appDir 'data'
$appUrl = "http://127.0.0.1:$Port/app/"
$healthUrl = "http://127.0.0.1:$Port/api/v1/ai/status"

function Test-StudyAssistantBackend {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $healthUrl -TimeoutSec 2
    return $response.StatusCode -eq 200
  } catch {
    return $false
  }
}

if (-not (Test-Path -LiteralPath $packageFile)) {
  throw "Cannot find app/package.json. Keep this launcher in the repository root."
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  throw 'Node.js was not found. Install Node.js 20 or newer.'
}

$nodeVersion = (& $node.Source --version).Trim()
$nodeMajor = [int](($nodeVersion -replace '^v', '') -split '\.')[0]
if ($nodeMajor -lt 20) {
  throw "Node.js 20 or newer is required. Current version: $nodeVersion"
}

if ($Check) {
  Write-Host "[OK] Project directory: $projectRoot"
  Write-Host "[OK] Node.js: $nodeVersion"
  Write-Host "[OK] Application URL: $appUrl"
  exit 0
}

if (-not (Test-StudyAssistantBackend)) {
  New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
  $stdoutLog = Join-Path $dataDir 'server.log'
  $stderrLog = Join-Path $dataDir 'server-error.log'
  $pidFile = Join-Path $dataDir 'server.pid'

  $oldPort = $env:PORT
  try {
    $env:PORT = [string]$Port
    $serverProcess = Start-Process `
      -FilePath $node.Source `
      -ArgumentList 'bin/server.js' `
      -WorkingDirectory $appDir `
      -WindowStyle Hidden `
      -RedirectStandardOutput $stdoutLog `
      -RedirectStandardError $stderrLog `
      -PassThru
    Set-Content -LiteralPath $pidFile -Value $serverProcess.Id
  } finally {
    $env:PORT = $oldPort
  }

  $ready = $false
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    if (Test-StudyAssistantBackend) {
      $ready = $true
      break
    }
    Start-Sleep -Milliseconds 500
  }

  if (-not $ready) {
    throw "The backend did not become ready. See $stderrLog"
  }
}

Write-Host "AI Study Assistant is ready: $appUrl"
Start-Process $appUrl
