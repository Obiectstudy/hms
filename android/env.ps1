# Toolchain locations for the APK build. Dot-source it before any build command:
#   . .\android\env.ps1
# Pure ASCII on purpose: Windows PowerShell 5.1 reads BOM-less .ps1 files as ANSI.
$root = $PSScriptRoot
$env:JAVA_HOME = Join-Path $root '.tools\jdk'
$env:ANDROID_HOME = Join-Path $root '.tools\android-sdk'
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
$env:GRADLE_HOME = Join-Path $root '.tools\gradle-8.7'

# This machine's JVM is only permitted to write inside the repository workspace, so every cache,
# temp and SDK-metadata directory a Java process touches has to live under android\.tools.
$env:GRADLE_USER_HOME = Join-Path $root '.tools\gradle-home'
$env:ANDROID_USER_HOME = Join-Path $root '.tools\android-home'
$tmp = Join-Path $root '.tools\tmp'
New-Item -ItemType Directory -Force -Path $env:GRADLE_USER_HOME, $env:ANDROID_USER_HOME, $tmp | Out-Null
$env:JAVA_TOOL_OPTIONS = "-Djava.io.tmpdir=$($tmp -replace '\\', '/')"

$env:PATH = @(
    (Join-Path $env:JAVA_HOME 'bin'),
    (Join-Path $env:GRADLE_HOME 'bin'),
    (Join-Path $env:ANDROID_HOME 'build-tools\34.0.0'),
    (Join-Path $env:ANDROID_HOME 'platform-tools'),
    (Join-Path $env:ANDROID_HOME 'cmdline-tools\latest\bin'),
    $env:PATH
) -join ';'

Write-Host "JAVA_HOME=$env:JAVA_HOME"
Write-Host "ANDROID_HOME=$env:ANDROID_HOME"
Write-Host "GRADLE_USER_HOME=$env:GRADLE_USER_HOME"
