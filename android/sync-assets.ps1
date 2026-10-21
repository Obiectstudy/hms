# Copies the web app into app/src/main/assets/www and verifies every file arrived.
# The expected list is parsed from sw.js PRECACHE, so the APK payload and the service worker
# cache can never drift apart. Fails hard (exit 1) if anything is missing.
#
# Note on the file count: sw.js PRECACHE lists both './' (the navigation fallback) and './index.html',
# which are the same file, and a service worker never precaches itself, so the payload holds one
# fewer file than PRECACHE plus sw.js. The count is derived from sw.js, never pinned to a literal:
# pinning it made every build fail as soon as the site legitimately gained a file (js/update.js).
$ErrorActionPreference = 'Stop'

$android = $PSScriptRoot
$repo = Split-Path -Parent $android
$dest = Join-Path $android 'app\src\main\assets\www'

$swPath = Join-Path $repo 'sw.js'
if (-not (Test-Path $swPath)) { throw "sw.js not found at $swPath" }
$sw = Get-Content -Raw -LiteralPath $swPath
$block = [regex]::Match($sw, '(?s)const\s+PRECACHE\s*=\s*\[(.*?)\];')
if (-not $block.Success) { throw 'PRECACHE array not found in sw.js' }

$entries = @([regex]::Matches($block.Groups[1].Value, "'([^']+)'") | ForEach-Object { $_.Groups[1].Value })
if ($entries.Count -lt 1) { throw 'sw.js PRECACHE is empty' }

$files = New-Object System.Collections.Generic.List[string]
foreach ($e in $entries) {
    $f = if ($e -eq './') { 'index.html' } else { $e.Substring(2) }
    if (-not $files.Contains($f)) { $files.Add($f) }
}
# A service worker cannot precache itself, but app.js registers './sw.js', so ship it too.
if (-not $files.Contains('sw.js')) { $files.Add('sw.js') }

if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
New-Item -ItemType Directory -Force -Path $dest | Out-Null

$missingSource = @()
foreach ($f in $files) {
    $src = Join-Path $repo ($f -replace '/', '\')
    $dst = Join-Path $dest ($f -replace '/', '\')
    if (-not (Test-Path -LiteralPath $src -PathType Leaf)) { $missingSource += $f; continue }
    $parent = Split-Path -Parent $dst
    if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    Copy-Item -LiteralPath $src -Destination $dst -Force
}
if ($missingSource.Count -gt 0) { throw "source files missing in repo: $($missingSource -join ', ')" }

Write-Host ("sw.js PRECACHE entries: {0} (entry 1 is './' -> index.html)" -f $entries.Count)
Write-Host ''
$total = 0
$i = 0
foreach ($f in $files) {
    $i++
    $dst = Join-Path $dest ($f -replace '/', '\')
    if (-not (Test-Path -LiteralPath $dst -PathType Leaf)) { throw "NOT COPIED: $f" }
    $len = (Get-Item -LiteralPath $dst).Length
    # Byte-for-byte length check: catches a truncated copy when the file list itself is unchanged.
    $srcLen = (Get-Item -LiteralPath (Join-Path $repo ($f -replace '/', '\'))).Length
    if ($len -ne $srcLen) { throw "SIZE MISMATCH: $f (copied $len, source $srcLen)" }
    $total += $len
    Write-Host ("[{0,2}] {1,-30} {2,8} bytes" -f $i, $f, $len)
}

$disk = @(Get-ChildItem -LiteralPath $dest -Recurse -File)
# The payload must be exactly the derived list: nothing missing, nothing extra on disk.
if ($disk.Count -ne $files.Count) { throw "expected $($files.Count) files in assets/www, found $($disk.Count)" }

foreach ($m in @('index.html', 'sw.js', 'js/store.js', 'views/food.js', 'icons/icon-512.png')) {
    if ($files -notcontains $m) { throw "required file not in payload: $m" }
}

Write-Host ''
Write-Host ("assets/www: {0} files, {1} bytes total" -f $disk.Count, $total)
Write-Host "OK -> $dest"
