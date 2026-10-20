# Bootstrap the build toolchain into android/.tools (no installers, no admin rights).
# Idempotent: every artifact is skipped when its final marker already exists.
# Mirrors are the domestic ones: the upstream GitHub / services.gradle.org links are unreachable
# from this machine (measured at 0-20 KB/s), while these answer at 2-13 MB/s.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$tools = Join-Path $root '.tools'
$dl = Join-Path $tools 'downloads'
New-Item -ItemType Directory -Force -Path $tools, $dl | Out-Null

$jdkZipUrl  = 'https://mirrors.huaweicloud.com/openjdk/17.0.2/openjdk-17.0.2_windows-x64_bin.zip'
$clZipUrl   = 'https://mirrors.cloud.tencent.com/AndroidSDK/commandlinetools-win-11076708_latest.zip'
$gradleUrl  = 'https://mirrors.cloud.tencent.com/gradle/gradle-8.7-bin.zip'

function Get-File([string]$url, [string]$out) {
  if (Test-Path $out) { Write-Host "[skip] $out"; return }
  Write-Host "[get ] $url"
  $tmp = "$out.part"
  & curl.exe -L --fail --silent --show-error -o $tmp $url
  if ($LASTEXITCODE -ne 0) { throw "download failed ($LASTEXITCODE): $url" }
  Move-Item -Force $tmp $out
  Write-Host "[done] $out ($([math]::Round((Get-Item $out).Length / 1MB, 1)) MB)"
}

# 1. JDK 17 --------------------------------------------------------------------
$jdkMarker = Join-Path $tools 'jdk\bin\javac.exe'
if (-not (Test-Path $jdkMarker)) {
  $jdkZip = Join-Path $dl 'openjdk-17.0.2-windows-x64.zip'
  Get-File $jdkZipUrl $jdkZip
  $jdkTmp = Join-Path $tools 'jdk-unzip'
  Remove-Item -Recurse -Force $jdkTmp -ErrorAction SilentlyContinue
  Expand-Archive -LiteralPath $jdkZip -DestinationPath $jdkTmp -Force
  $inner = Get-ChildItem $jdkTmp -Directory | Select-Object -First 1
  if (Test-Path (Join-Path $tools 'jdk')) { Remove-Item -Recurse -Force (Join-Path $tools 'jdk') }
  Move-Item $inner.FullName (Join-Path $tools 'jdk')
  Remove-Item -Recurse -Force $jdkTmp
}

# 2. Android command-line tools -------------------------------------------------
$sdk = Join-Path $tools 'android-sdk'
$sdkManager = Join-Path $sdk 'cmdline-tools\latest\bin\sdkmanager.bat'
if (-not (Test-Path $sdkManager)) {
  $clZip = Join-Path $dl 'cmdline-tools.zip'
  Get-File $clZipUrl $clZip
  $clTmp = Join-Path $tools 'clt-unzip'
  Remove-Item -Recurse -Force $clTmp -ErrorAction SilentlyContinue
  Expand-Archive -LiteralPath $clZip -DestinationPath $clTmp -Force
  New-Item -ItemType Directory -Force -Path (Join-Path $sdk 'cmdline-tools') | Out-Null
  Move-Item (Join-Path $clTmp 'cmdline-tools') (Join-Path $sdk 'cmdline-tools\latest')
  Remove-Item -Recurse -Force $clTmp
}

$env:JAVA_HOME = Join-Path $tools 'jdk'
$env:PATH = "$env:JAVA_HOME\bin;$env:PATH"
& "$env:JAVA_HOME\bin\java.exe" -version

# 3. SDK packages ---------------------------------------------------------------
# dl.google.com is the default repository index; it is unreliable here, so point sdkmanager at the
# Tencent mirror (same repository XML + archives).
$env:SDK_TEST_BASE_URL = 'https://mirrors.cloud.tencent.com/AndroidSDK/'
$need = @()
if (-not (Test-Path (Join-Path $sdk 'platforms\android-34\android.jar'))) { $need += 'platforms;android-34' }
if (-not (Test-Path (Join-Path $sdk 'build-tools\34.0.0\aapt2.exe'))) { $need += 'build-tools;34.0.0' }
if (-not (Test-Path (Join-Path $sdk 'platform-tools\adb.exe'))) { $need += 'platform-tools' }
if ($need.Count -gt 0) {
  Write-Host "[sdk ] installing: $($need -join ', ')"
  $yes = (1..200 | ForEach-Object { 'y' }) -join "`n"
  $yes | & $sdkManager --sdk_root=$sdk --licenses | Out-Null
  & $sdkManager --sdk_root=$sdk @need
  if ($LASTEXITCODE -ne 0) { throw "sdkmanager failed with exit code $LASTEXITCODE" }
}

# 4. Gradle 8.7 ----------------------------------------------------------------
$gradleHome = Join-Path $tools 'gradle-8.7'
if (-not (Test-Path (Join-Path $gradleHome 'bin\gradle.bat'))) {
  $gz = Join-Path $dl 'gradle-8.7-bin.zip'
  Get-File $gradleUrl $gz
  $tmpG = Join-Path $tools 'gradle-unzip'
  Remove-Item -Recurse -Force $tmpG -ErrorAction SilentlyContinue
  Expand-Archive -LiteralPath $gz -DestinationPath $tmpG -Force
  Move-Item (Join-Path $tmpG 'gradle-8.7') $gradleHome
  Remove-Item -Recurse -Force $tmpG
}

Write-Host '[ok  ] toolchain ready'
Write-Host "JAVA_HOME=$env:JAVA_HOME"
Write-Host "ANDROID_HOME=$sdk"
Write-Host "GRADLE_HOME=$gradleHome"
