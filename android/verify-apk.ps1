# Verifies a signed release APK against the delivery contract (4 checks, real tool output).
# Usage: powershell -ExecutionPolicy Bypass -File android\verify-apk.ps1 -Apk <path>
param(
    [Parameter(Mandatory = $true)][string]$Apk
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'env.ps1')
# PowerShell 5.1 turns a native command's stderr into a terminating error, and every wrapper batch
# file here echoes JAVA_TOOL_OPTIONS. Verification does not write temp files, so drop the var.
Remove-Item Env:JAVA_TOOL_OPTIONS -ErrorAction SilentlyContinue

if (-not (Test-Path -LiteralPath $Apk)) { throw "APK not found: $Apk" }
$item = Get-Item -LiteralPath $Apk
Write-Host "APK   : $($item.FullName)"
Write-Host "Bytes : $($item.Length)"
Write-Host "SHA256: $((Get-FileHash -LiteralPath $Apk -Algorithm SHA256).Hash.ToLower())"
Write-Host ''

Write-Host '===== 1a. apksigner verify (as-is: minSdk 24, apksigner skips the v1 pass) ====='
$out = & apksigner.bat verify --verbose --print-certs -in $Apk 2>&1
$code = $LASTEXITCODE
$out | ForEach-Object { Write-Host $_ }
if ($code -ne 0) { throw "apksigner verify failed ($code)" }
Write-Host ''
Write-Host '===== 1b. apksigner verify --min-sdk-version 21 (forces the v1/JAR check) ====='
$out = & apksigner.bat verify --verbose --print-certs --min-sdk-version 21 -in $Apk 2>&1
$code = $LASTEXITCODE
$out | ForEach-Object { Write-Host $_ }
if ($code -ne 0) { throw "apksigner verify (v1 forced) failed ($code)" }
Write-Host ''

Write-Host '===== 2. aapt2 dump badging ====='
& aapt2.exe dump badging $Apk 2>&1 | Select-String -Pattern '^package:|^sdkVersion:|^targetSdkVersion:|^application-label:|^application:|^launchable-activity:' | ForEach-Object { Write-Host $_.Line }
Write-Host ''

Write-Host '===== 3. assets/www payload ====='
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead($Apk)
try {
    $www = @($zip.Entries | Where-Object { $_.FullName -like 'assets/www/*' -and $_.Length -gt 0 })
    foreach ($e in $www) { Write-Host ("{0,-40} {1,8} bytes" -f $e.FullName, $e.Length) }
    Write-Host "assets/www file count: $($www.Count)"
    $must = @('assets/www/index.html', 'assets/www/sw.js', 'assets/www/js/store.js', 'assets/www/views/food.js', 'assets/www/icons/icon-512.png')
    $names = @($www | ForEach-Object { $_.FullName })
    foreach ($m in $must) {
        if ($names -notcontains $m) { throw "missing in APK: $m" }
        Write-Host "present: $m"
    }
} finally { $zip.Dispose() }
Write-Host ''

Write-Host '===== 4. dex + installable shape ====='
$zip = [System.IO.Compression.ZipFile]::OpenRead($Apk)
try {
    $dex = @($zip.Entries | Where-Object { $_.FullName -like '*.dex' })
    foreach ($d in $dex) { Write-Host ("{0,-20} {1,9} bytes" -f $d.FullName, $d.Length) }
    if ($dex.Count -eq 0) { throw 'no classes.dex in APK' }
    $apkMb = [math]::Round($item.Length / 1MB, 2)
    Write-Host "APK size: $($item.Length) bytes ($apkMb MB)"
    if ($apkMb -lt 1 -or $apkMb -gt 8) { throw "APK size out of expected 1-8 MB range: $apkMb MB" }
} finally { $zip.Dispose() }

Write-Host ''
Write-Host 'ALL CHECKS PASSED'
