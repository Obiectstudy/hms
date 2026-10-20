# One-shot reproducible release build: sync assets -> signed APK -> copy to the release folder.
# Usage:  powershell -ExecutionPolicy Bypass -File C:\Users\Administrator\Desktop\hms\android\build.ps1
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'env.ps1')

& (Join-Path $PSScriptRoot 'sync-assets.ps1')

Push-Location $PSScriptRoot
try {
    & (Join-Path $PSScriptRoot 'gradlew.bat') assembleRelease --no-daemon
    if ($LASTEXITCODE -ne 0) { throw "gradle assembleRelease failed ($LASTEXITCODE)" }
} finally {
    Pop-Location
}

$apk = Join-Path $PSScriptRoot 'app\build\outputs\apk\release\app-release.apk'
if (-not (Test-Path $apk)) { throw "APK not produced: $apk" }

# The release file name is Chinese; build it from code points so this script stays pure ASCII
# (PowerShell 5.1 decodes BOM-less .ps1 files as ANSI and would mangle the literal).
# The version comes from app/build.gradle so the APK name can never drift from the manifest.
$cjk = [string]([char]0x5065) + [string]([char]0x5EB7)   # "health"
$match = [regex]::Match((Get-Content -Raw (Join-Path $PSScriptRoot 'app\build.gradle')), "versionName\s+'([^']+)'")
if (-not $match.Success) { throw 'versionName not found in app/build.gradle' }
$versionName = $match.Groups[1].Value

$outDir = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'hms-release'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$final = Join-Path $outDir ("HMS-$cjk-$versionName.apk")
Copy-Item -LiteralPath $apk -Destination $final -Force

$hash = (Get-FileHash -LiteralPath $final -Algorithm SHA256).Hash.ToLower()
Write-Host ''
Write-Host "Version  : $versionName"
Write-Host "APK      : $final"
Write-Host "Bytes    : $((Get-Item -LiteralPath $final).Length)"
Write-Host "SHA256   : $hash"
