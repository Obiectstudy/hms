$ErrorActionPreference = "Continue"
. C:\Users\Administrator\Desktop\hms\android\env.ps1
$bt = Join-Path $env:ANDROID_HOME "build-tools\34.0.0"
$apk = (Get-ChildItem "C:\Users\Administrator\Desktop\hms-release\HMS-*.apk" | Where-Object { $_.Name -like "*1.3.0*" }).FullName
$site = "C:\Users\Administrator\Desktop\hms"

Write-Output ("APK: " + $apk)
Write-Output ("size: " + (Get-Item $apk).Length)
Write-Output ("sha256: " + (Get-FileHash $apk -Algorithm SHA256).Hash.ToLower())
$badge = & (Join-Path $bt "aapt2.exe") dump badging $apk 2>$null | Select-String -Pattern "^package:" | Select-Object -First 1
Write-Output ($badge.ToString())
& (Join-Path $bt "apksigner.bat") verify --min-sdk-version 21 $apk 2>$null | Out-Null
Write-Output ("apksigner exit: " + $LASTEXITCODE)

Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($apk)
$checked = 0
$mismatch = 0
try {
  foreach ($e in $zip.Entries) {
    if ($e.FullName -notlike "assets/www/*" -or $e.Name -eq "") { continue }
    $rel = $e.FullName.Substring("assets/www/".Length)
    $local = Join-Path $site ($rel -replace "/", "\")
    if (-not (Test-Path $local)) { Write-Output ("MISSING " + $rel); $mismatch++; continue }
    $a = $e.Length
    $b = (Get-Item $local).Length
    $checked++
    if ($a -ne $b) { Write-Output ("SIZE-DIFF " + $rel + " apk=" + $a + " disk=" + $b); $mismatch++ }
  }
  Write-Output ("assets/www files=" + $checked + " mismatch=" + $mismatch)
} finally { $zip.Dispose() }
