param(
  [string]$Notes = "",
  [string]$NotesFile = "release-notes.txt",
  [switch]$NoCommit
)
# Release helper: publish dist/HMS-latest.apk + version.json for in-app updates.
# Usage: powershell -ExecutionPolicy Bypass -File tools\release.ps1
# Put the changelog (UTF-8) in release-notes.txt — do NOT pass Chinese via -Notes,
# PowerShell 5.1 mangles non-ASCII command-line arguments.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root

if (Test-Path (Join-Path $root $NotesFile)) {
  $Notes = [IO.File]::ReadAllText((Join-Path $root $NotesFile), [Text.Encoding]::UTF8).Trim()
  Write-Output ("notes loaded from " + $NotesFile + " (" + $Notes.Length + " chars)")
}

$gradle = Join-Path $root "android\app\build.gradle"
if (-not (Test-Path $gradle)) { throw "build.gradle not found: $gradle" }

$code = $null
$name = $null
foreach ($line in Get-Content $gradle) {
  $m1 = [regex]::Match($line, '^\s*versionCode\s+(\d+)\s*$')
  if ($m1.Success) { $code = [int]$m1.Groups[1].Value }
  $m2 = [regex]::Match($line, "^\s*versionName\s+['""]([^'""]+)['""]\s*$")
  if ($m2.Success) { $name = $m2.Groups[1].Value }
}
if (-not $code -or -not $name) { throw "cannot read versionCode/versionName from $gradle" }
Write-Output "versionCode=$code versionName=$name"

$relDir = "C:\Users\Administrator\Desktop\hms-release"
$src = Get-ChildItem (Join-Path $relDir "HMS-*-$name.apk") -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $src) { throw "APK for $name not found in $relDir (build it first)" }
Write-Output ("source APK: " + $src.FullName + "  " + $src.Length + " bytes")

$dist = Join-Path $root "dist"
New-Item -ItemType Directory -Force -Path $dist | Out-Null
$latest = Join-Path $dist "HMS-latest.apk"
Copy-Item $src.FullName $latest -Force

$hash = (Get-FileHash $latest -Algorithm SHA256).Hash.ToLower()
$size = (Get-Item $latest).Length
Write-Output "sha256=$hash size=$size"

# 下载源优先用 CloudBase 静态托管（国内 CDN 直连）：实测 1400 KB/s，GitHub Pages 只有 5.5 KB/s。
# 家里人没装梯子也能几秒下完；GitHub 那份 dist/ 仍照旧提交，作为备用源。
$cdnUrl = "https://hms-d4gnh63iw73f09792-1513758162.tcloudbaseapp.com/HMS-latest.apk"
& tcb hosting deploy $latest /HMS-latest.apk -e hms-d4gnh63iw73f09792 2>&1 | Out-Null
if ($LASTEXITCODE -eq 0) {
  Write-Output "uploaded to CloudBase static hosting"
} else {
  Write-Output "WARN: CloudBase upload failed; falling back to GitHub Pages url"
  $cdnUrl = "https://obiectstudy.github.io/hms/dist/HMS-latest.apk"
}

$payload = [ordered]@{
  versionCode = $code
  versionName = $name
  apkUrl      = $cdnUrl
  sha256      = $hash
  size        = $size
  notes       = $Notes
  publishedAt = (Get-Date -Format "yyyy-MM-dd")
}
$json = $payload | ConvertTo-Json
[IO.File]::WriteAllText((Join-Path $root "version.json"), $json, (New-Object System.Text.UTF8Encoding($false)))
Write-Output "version.json written"

if (-not $NoCommit) {
  git add version.json dist/HMS-latest.apk
  git -c core.pager=cat commit -q -m "release: $name (versionCode $code)"
  Write-Output "committed. run: git push origin main"
}
