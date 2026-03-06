param(
  [Parameter(Mandatory = $true)]
  [string]$RepoPath,
  [string]$CommitMessage = "chore: release",
  [switch]$AllowEmptyCommit,
  [switch]$SkipBuild,
  [switch]$SkipOpen
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Invoke-Checked {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Command,
    [string[]]$Args = @()
  )

  & $Command @Args
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed: $Command $($Args -join ' ')"
  }
}

if (-not (Test-Path -Path $RepoPath -PathType Container)) {
  throw "Repository path does not exist: $RepoPath"
}

$gitDir = Join-Path $RepoPath ".git"
if (-not (Test-Path -Path $gitDir)) {
  throw "Not a git repository: $RepoPath"
}

Push-Location $RepoPath
try {
  $branch = (git branch --show-current).Trim()
  if ([string]::IsNullOrWhiteSpace($branch)) {
    throw "Unable to determine current branch."
  }

  Invoke-Checked -Command "git" -Args @("add", "-A")

  & git diff --cached --quiet
  $diffExitCode = $LASTEXITCODE
  if ($diffExitCode -gt 1) {
    throw "Failed while checking staged diff."
  }
  $hasStagedChanges = ($diffExitCode -eq 1)

  if ($hasStagedChanges -or $AllowEmptyCommit.IsPresent) {
    $commitArgs = @("commit")
    if (-not $hasStagedChanges -and $AllowEmptyCommit.IsPresent) {
      $commitArgs += "--allow-empty"
    }
    $commitArgs += @("-m", $CommitMessage)
    Invoke-Checked -Command "git" -Args $commitArgs
  }
  else {
    Write-Host "No staged changes detected; skip commit."
  }

  Invoke-Checked -Command "git" -Args @("push", "origin", $branch)

  if (-not $SkipBuild.IsPresent) {
    Invoke-Checked -Command "pnpm" -Args @("build")
  }
  else {
    Write-Host "Skip build as requested."
  }

  $packageJsonPath = Join-Path $RepoPath "package.json"
  $version = ""
  if (Test-Path -Path $packageJsonPath) {
    $packageJson = Get-Content -Path $packageJsonPath -Raw | ConvertFrom-Json
    $version = [string]$packageJson.version
  }

  $distPath = Join-Path $RepoPath "dist"
  $artifacts = @()
  if (Test-Path -Path $distPath -PathType Container) {
    $artifacts = @(Get-ChildItem -Path $distPath -File | Select-Object -ExpandProperty Name)
  }

  Write-Host "Branch: $branch"
  if (-not [string]::IsNullOrWhiteSpace($version)) {
    Write-Host "Version: $version"
  }

  if ($artifacts.Count -gt 0) {
    Write-Host "Artifacts:"
    foreach ($artifact in $artifacts) {
      Write-Host " - $artifact"
    }
  }
  else {
    Write-Host "No artifacts found in: $distPath"
  }

  Write-Host "Output: $distPath"

  if (-not $SkipOpen.IsPresent) {
    if (-not (Test-Path -Path $distPath -PathType Container)) {
      throw "Cannot open output folder because it does not exist: $distPath"
    }
    Start-Process -FilePath "explorer.exe" -ArgumentList $distPath
  }
  else {
    Write-Host "Skip opening output directory as requested."
  }
}
finally {
  Pop-Location
}
