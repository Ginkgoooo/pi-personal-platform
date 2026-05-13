# pi-personal-platform / import-memory
#
# 从 export-memory.ps1 生成的 zip 恢复 pi 记忆。
# 恢复策略：以导入包为准，覆盖本机 ~/.pi/memory/profile.md 和 store.jsonl。
# 覆盖前会自动备份本机现有记忆到 ~/.pi/memory-backups/。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File .\scripts\import-memory.ps1 -ZipPath D:\Backup\pi-memory-XXX.zip

param(
  [Parameter(Mandatory = $true)]
  [string]$ZipPath
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $ZipPath)) {
  throw "Zip file not found: $ZipPath"
}

$memoryDir = Join-Path $env:USERPROFILE ".pi\memory"
$backupDir = Join-Path $env:USERPROFILE ".pi\memory-backups"
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$tempDir = Join-Path $env:TEMP "pi-memory-import-$stamp"
$backupZip = Join-Path $backupDir "pi-memory-before-import-$env:COMPUTERNAME-$stamp.zip"

New-Item -ItemType Directory -Force -Path $memoryDir | Out-Null
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null

Remove-Item $tempDir -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $tempDir | Out-Null

try {
  $currentFiles = @()
  $currentProfile = Join-Path $memoryDir "profile.md"
  $currentStore = Join-Path $memoryDir "store.jsonl"
  if (Test-Path $currentProfile) { $currentFiles += $currentProfile }
  if (Test-Path $currentStore) { $currentFiles += $currentStore }

  if ($currentFiles.Count -gt 0) {
    Compress-Archive -Path $currentFiles -DestinationPath $backupZip -Force
    Write-Host "Backed up current pi memory: $backupZip"
  } else {
    Write-Host "No existing pi memory files to back up."
  }

  Expand-Archive -Path $ZipPath -DestinationPath $tempDir -Force

  $importProfile = Join-Path $tempDir "profile.md"
  $importStore = Join-Path $tempDir "store.jsonl"

  if (-not (Test-Path $importProfile) -and -not (Test-Path $importStore)) {
    throw "Zip does not contain profile.md or store.jsonl at archive root."
  }

  if (Test-Path $importProfile) {
    Copy-Item $importProfile $currentProfile -Force
    Write-Host "Restored: $currentProfile"
  }

  if (Test-Path $importStore) {
    Copy-Item $importStore $currentStore -Force
    Write-Host "Restored: $currentStore"
  }

  Write-Host "Imported pi memory from: $ZipPath"
  Write-Host "Restore mode: overwrite"
} finally {
  Remove-Item $tempDir -Recurse -Force -ErrorAction SilentlyContinue
}
