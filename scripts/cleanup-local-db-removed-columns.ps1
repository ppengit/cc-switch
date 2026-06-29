param(
  [string]$DbPath = (Join-Path $env:USERPROFILE ".cc-switch\cc-switch.db")
)

$ErrorActionPreference = "Stop"

$running = Get-Process -Name "cc-switch" -ErrorAction SilentlyContinue
if ($running) {
  Write-Error "cc-switch.exe is running. Close it manually, then rerun this script. No changes were made."
  exit 2
}

$sqlite = Get-Command sqlite3 -ErrorAction SilentlyContinue
if (-not $sqlite) {
  Write-Error "sqlite3 was not found in PATH."
  exit 3
}

if (-not (Test-Path -LiteralPath $DbPath)) {
  Write-Error "Database file not found: $DbPath"
  exit 4
}

$resolvedDb = (Resolve-Path -LiteralPath $DbPath).Path
$dbDir = Split-Path -Parent $resolvedDb
$backupDir = Join-Path $dbDir "backups"
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null

$quickCheck = & $sqlite.Source $resolvedDb "PRAGMA quick_check;"
if ($quickCheck -ne "ok") {
  Write-Error "Database quick_check failed before cleanup: $quickCheck"
  exit 5
}

$columnsToDrop = @(
  "response_rescue_enabled",
  "response_rescue_empty_2xx_enabled",
  "response_rescue_429_enabled",
  "response_rescue_max_retries"
)

$tableInfo = & $sqlite.Source $resolvedDb "PRAGMA table_info(proxy_config);"
$existingColumns = @{}
foreach ($line in $tableInfo) {
  $parts = $line -split "\|"
  if ($parts.Count -ge 2) {
    $existingColumns[$parts[1]] = $true
  }
}

$presentColumns = $columnsToDrop | Where-Object { $existingColumns.ContainsKey($_) }
if ($presentColumns.Count -eq 0) {
  Write-Output "No removed response_rescue columns found. Database is already clean."
  exit 0
}

$stamp = Get-Date -Format "yyyyMMdd_HHmmss"
$backupPath = Join-Path $backupDir "manual_pre_removed_columns_cleanup_$stamp.db"
Copy-Item -LiteralPath $resolvedDb -Destination $backupPath -Force

$sql = New-Object System.Collections.Generic.List[string]
$sql.Add("BEGIN;")
foreach ($column in $presentColumns) {
  $sql.Add("ALTER TABLE proxy_config DROP COLUMN $column;")
}
$sql.Add("COMMIT;")
$sql.Add("PRAGMA quick_check;")

$result = & $sqlite.Source $resolvedDb ($sql -join " ")
if ($result -ne "ok") {
  Write-Error "Database quick_check failed after cleanup: $result. Backup: $backupPath"
  exit 6
}

Write-Output "Cleanup complete."
Write-Output "Backup: $backupPath"
