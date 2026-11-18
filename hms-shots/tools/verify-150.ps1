$ErrorActionPreference = "Continue"
. C:\Users\Administrator\Desktop\hms\android\env.ps1
$bt = Join-Path $env:ANDROID_HOME "build-tools\34.0.0"
$apk = (Get-ChildItem "C:\Users\Administrator\Desktop\hms-release\HMS-*.apk" | Where-Object { $_.Name -like "*1.5.0*" }).FullName
$site = "C:\Users\Administrator\Desktop\hms"
Write-Output ("APK: " + $apk)
Write-Output ("size: " + (Get-Item $apk).Length)
Write-Output ("sha256: " + (Get-FileHash $apk -Algorithm SHA256).Hash.ToLower())
& (Join-Path $bt "aapt2.exe") dump badging $apk 2>$null | Select-String -Pattern "^package:" | Select-Object -First 1
& (Join-Path $bt "aapt2.exe") dump permissions $apk 2>$null | Select-String -Pattern "INSTALL_PACKAGES|INTERNET"
& (Join-Path $bt "apksigner.bat") verify --min-sdk-version 21 $apk 2>$null | Out-Null
Write-Output ("apksigner exit: " + $LASTEXITCODE)
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($apk)
$checked = 0; $mismatch = 0
try {
  foreach ($e in $zip.Entries) {
    if ($e.FullName -notlike "assets/www/*" -or $e.Name -eq "") { continue }
    $rel = $e.FullName.Substring("assets/www/".Length)
    $local = Join-Path $site ($rel -replace "/", "\")
    if (-not (Test-Path $local)) { Write-Output ("MISSING " + $rel); $mismatch++; continue }
    $checked++
    if ($e.Length -ne (Get-Item $local).Length) { Write-Output ("SIZE-DIFF " + $rel); $mismatch++ }
  }
  Write-Output ("assets/www files=" + $checked + " mismatch=" + $mismatch)
} finally { $zip.Dispose() }
