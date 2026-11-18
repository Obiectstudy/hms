param([string]$Version = "1.6.0")
$ErrorActionPreference = "Continue"
. C:\Users\Administrator\Desktop\hms\android\env.ps1
$bt = Join-Path $env:ANDROID_HOME "build-tools\34.0.0"
$apk = (Get-ChildItem "C:\Users\Administrator\Desktop\hms-release\HMS-*.apk" | Where-Object { $_.Name -like "*$Version*" }).FullName
$site = "C:\Users\Administrator\Desktop\hms"
if (-not $apk) { Write-Output "APK NOT FOUND for $Version"; exit 1 }
Write-Output ("APK    : " + (Split-Path $apk -Leaf))
Write-Output ("Bytes  : " + (Get-Item $apk).Length)
Write-Output ("SHA256 : " + (Get-FileHash $apk -Algorithm SHA256).Hash.ToLower())
Write-Output "--- badging ---"
& (Join-Path $bt "aapt2.exe") dump badging $apk 2>$null | Select-String -Pattern "^package:" | Select-Object -First 1
Write-Output "--- permissions ---"
& (Join-Path $bt "aapt2.exe") dump permissions $apk 2>$null | Select-String -Pattern "INSTALL_PACKAGES|INTERNET"
Write-Output "--- signature ---"
& (Join-Path $bt "apksigner.bat") verify --min-sdk-version 21 $apk 2>&1 | Out-Null
Write-Output ("apksigner exit: " + $LASTEXITCODE)
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($apk)
try {
  $n = 0; $bad = 0
  foreach ($e in $zip.Entries) {
    if ($e.FullName -notlike "assets/www/*" -or $e.Name -eq "") { continue }
    $rel = $e.FullName.Substring("assets/www/".Length)
    $local = Join-Path $site ($rel -replace "/", "\")
    $n++
    if (-not (Test-Path $local)) { Write-Output ("MISSING " + $rel); $bad++; continue }
    if ($e.Length -ne (Get-Item $local).Length) { Write-Output ("SIZE-DIFF " + $rel); $bad++ }
  }
  Write-Output ("--- assets/www: " + $n + " files, mismatch=" + $bad + " ---")
  foreach ($probe in @(
    @{ f = "assets/www/js/nutrition.js"; k = "EXERCISE_TYPES" },
    @{ f = "assets/www/js/nutrition.js"; k = "bmiGaps" },
    @{ f = "assets/www/views/weight.js"; k = "bmi-figure" },
    @{ f = "assets/www/views/exercise.js"; k = "rememberIntensity" },
    @{ f = "assets/www/views/food.js"; k = "saveDayTemplate" },
    @{ f = "assets/www/views/dashboard.js"; k = "meal-fold" }
  )) {
    $entry = $zip.Entries | Where-Object { $_.FullName -eq $probe.f }
    if (-not $entry) { Write-Output ("MISS " + $probe.f); continue }
    $r = New-Object System.IO.StreamReader($entry.Open()); $txt = $r.ReadToEnd(); $r.Close()
    Write-Output ("probe " + $probe.k + " in " + (Split-Path $probe.f -Leaf) + ": " + ($txt -match [regex]::Escape($probe.k)))
  }
} finally { $zip.Dispose() }