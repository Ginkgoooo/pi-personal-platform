# pi-personal-platform / export-memory
#
# 打包本机 pi 记忆目录，用于手动同步到另一台电脑。
# 默认只导出：
# - ~/.pi/memory/profile.md
# - ~/.pi/memory/store.jsonl
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File .\scripts\export-memory.ps1
#   powershell -ExecutionPolicy Bypass -File .\scripts\export-memory.ps1 -OutputDir D:\Backup

param(
  [string]$OutputDir = "$(Get-Location)"
)

$ErrorActionPreference = "Stop"

$memoryDir = Join-Path $env:USERPROFILE ".pi\memory"
$profilePath = Join-Path $memoryDir "profile.md"
$storePath = Join-Path $memoryDir "store.jsonl"

if (-not (Test-Path $memoryDir)) {
  throw "Memory directory not found: $memoryDir"
}

$files = @()
if (Test-Path $profilePath) { $files += @{ Source = $profilePath; Name = "profile.md" } }
if (Test-Path $storePath) { $files += @{ Source = $storePath; Name = "store.jsonl" } }

if ($files.Count -eq 0) {
  throw "No memory files found in: $memoryDir"
}

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$computer = $env:COMPUTERNAME
$zipPath = Join-Path $OutputDir "pi-memory-$computer-$stamp.zip"
$tempDir = Join-Path $env:TEMP "pi-memory-export-$stamp"

Remove-Item $tempDir -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $tempDir | Out-Null

try {
  foreach ($file in $files) {
    Copy-Item $file.Source (Join-Path $tempDir $file.Name) -Force
  }

  $manifest = [ordered]@{
    exportedAt = (Get-Date).ToString("o")
    computer = $computer
    user = $env:USERNAME
    sourceMemoryDir = $memoryDir
    files = @($files | ForEach-Object { $_.Name })
    restoreMode = "overwrite"
  }
  $manifest | ConvertTo-Json -Depth 4 | Set-Content -Path (Join-Path $tempDir "manifest.json") -Encoding UTF8

  Compress-Archive -Path (Join-Path $tempDir "*") -DestinationPath $zipPath -Force
  Write-Host "Exported pi memory: $zipPath"
} finally {
  Remove-Item $tempDir -Recurse -Force -ErrorAction SilentlyContinue
}
