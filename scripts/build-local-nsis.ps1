# Manual usage:
# 1. From repo root:
#    powershell -ExecutionPolicy Bypass -NoProfile -File .\scripts\build-local-nsis.ps1
# 2. Via package script:
#    pnpm build:local:nsis
# 3. Via bundle wrapper:
#    .\release\release\bundle\build-local-nsis.cmd

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$targetDir = Join-Path $repoRoot "release"
$bundleDir = Join-Path $targetDir "release\bundle\nsis"
$tempConfigPath = Join-Path $env:TEMP "cc-switch-tauri-local-nsis.json"

Push-Location $repoRoot
try {
  if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    throw "pnpm was not found in PATH."
  }

  $env:CARGO_TARGET_DIR = $targetDir

  @'
{"bundle":{"createUpdaterArtifacts":false}}
'@ | Set-Content -Path $tempConfigPath -Encoding ascii

  & pnpm tauri build --bundles nsis --config $tempConfigPath
  if ($LASTEXITCODE -ne 0) {
    throw "Tauri NSIS build failed with exit code: $LASTEXITCODE"
  }

  if (-not (Test-Path $bundleDir)) {
    throw "NSIS bundle directory was not found: $bundleDir"
  }

  $artifact = Get-ChildItem -Path $bundleDir -Filter "*setup.exe" |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

  if (-not $artifact) {
    throw "Build finished, but no NSIS installer was found."
  }

  $sizeMb = [Math]::Round($artifact.Length / 1MB, 2)
  Write-Host ""
  Write-Host "NSIS installer generated:"
  Write-Host "Path : $($artifact.FullName)"
  Write-Host "Size : $sizeMb MB"
  Write-Host "Time : $($artifact.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss'))"
}
finally {
  if (Test-Path $tempConfigPath) {
    Remove-Item -LiteralPath $tempConfigPath -Force -ErrorAction SilentlyContinue
  }
  Pop-Location
}
