# Скачивает статическую сборку ffmpeg (GPL, BtbN) для упаковки в установщик.
# Использование: pwsh scripts/fetch-ffmpeg.ps1 [-Url <zip>]
param([string]$Url = $env:FFMPEG_URL)
$ErrorActionPreference = "Stop"
$dest = Join-Path $PSScriptRoot "..\src-tauri\resources\ffmpeg"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
if (-not $Url) {
  # последняя стабильная ветка (nX.Y), а не ночная master
  $headers = @{ "User-Agent" = "timelapse-studio-ci" }
  if ($env:GITHUB_TOKEN) { $headers["Authorization"] = "Bearer $env:GITHUB_TOKEN" }
  $rel = Invoke-RestMethod -Headers $headers "https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/tags/latest"
  $asset = $rel.assets |
    Where-Object { $_.name -match '^ffmpeg-n(\d+)\.(\d+)-latest-win64-gpl-\d+\.\d+\.zip$' } |
    Sort-Object { [int]($_.name -replace '^ffmpeg-n(\d+)\.(\d+).*$', '$1') * 100 + [int]($_.name -replace '^ffmpeg-n(\d+)\.(\d+).*$', '$2') } |
    Select-Object -Last 1
  if (-not $asset) { throw "Не найдена стабильная сборка ffmpeg" }
  $Url = $asset.browser_download_url
}
Write-Host "ffmpeg: $Url"
$zip = Join-Path $env:RUNNER_TEMP "ffmpeg.zip"
if (-not $env:RUNNER_TEMP) { $zip = Join-Path ([IO.Path]::GetTempPath()) "ffmpeg.zip" }
Invoke-WebRequest -Uri $Url -OutFile $zip
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("ff-" + [guid]::NewGuid())
Expand-Archive $zip -DestinationPath $tmp
$bin = Get-ChildItem $tmp -Recurse -Filter ffmpeg.exe | Select-Object -First 1
Copy-Item $bin.FullName $dest -Force
Copy-Item (Join-Path $bin.DirectoryName "ffprobe.exe") $dest -Force
$lic = Get-ChildItem $tmp -Recurse -Filter "LICENSE*" | Select-Object -First 1
if ($lic) { Copy-Item $lic.FullName (Join-Path $PSScriptRoot "..\LICENSES\ffmpeg-LICENSE.txt") -Force }
& (Join-Path $dest "ffmpeg.exe") -hide_banner -version | Select-Object -First 1
