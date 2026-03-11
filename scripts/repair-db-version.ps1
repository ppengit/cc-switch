$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$SchemaPath = Join-Path $RepoRoot "src-tauri\src\database\mod.rs"

if (-not (Test-Path $SchemaPath)) {
  throw "Schema definition not found: $SchemaPath"
}

$SchemaContent = Get-Content $SchemaPath -Raw
$SchemaMatch = [regex]::Match($SchemaContent, "SCHEMA_VERSION:\s*i32\s*=\s*(\d+)")
if (-not $SchemaMatch.Success) {
  throw "Unable to determine SCHEMA_VERSION from $SchemaPath"
}

$TargetVersion = [int]$SchemaMatch.Groups[1].Value
$HomeDir = [Environment]::GetFolderPath("UserProfile")
$ConfigDir = Join-Path $HomeDir ".cc-switch"
$DbPath = Join-Path $ConfigDir "cc-switch.db"

if (-not (Test-Path $DbPath)) {
  Write-Output "No database found at $DbPath"
  exit 0
}

$SqlitePath = (Get-Command sqlite3 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -First 1)
if (-not $SqlitePath) {
  throw "sqlite3 was not found in PATH."
}

$CurrentVersion = [int](& $SqlitePath $DbPath "PRAGMA user_version;")
Write-Output "Database: $DbPath"
Write-Output "Current user_version: $CurrentVersion"
Write-Output "Target schema version: $TargetVersion"

if ($CurrentVersion -le $TargetVersion) {
  Write-Output "No repair needed."
  exit 0
}

$BackupDir = Join-Path $ConfigDir "backups"
New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
$Timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
$BackupPath = Join-Path $BackupDir "db_version_repair_$Timestamp.db"
Copy-Item -LiteralPath $DbPath -Destination $BackupPath
Write-Output "Backup created: $BackupPath"

& $SqlitePath $DbPath "PRAGMA user_version = $TargetVersion;"
$UpdatedVersion = [int](& $SqlitePath $DbPath "PRAGMA user_version;")

if ($UpdatedVersion -ne $TargetVersion) {
  throw "Repair failed. user_version is still $UpdatedVersion"
}

Write-Output "Database user_version repaired to $UpdatedVersion"
