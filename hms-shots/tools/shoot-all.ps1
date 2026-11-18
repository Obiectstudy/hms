param(
  [string]$OutDir = "C:\Users\Administrator\Desktop\hms-shots",
  [string]$Prefix = "before"
)
$ErrorActionPreference = "Continue"
$shots = $OutDir
$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$profile = Join-Path $shots "profile-$Prefix"

$srv = Start-Job -ScriptBlock { Set-Location "C:\Users\Administrator\Desktop\hms"; python -m http.server 8099 --bind 127.0.0.1 }
Start-Sleep -Seconds 2

$proc = Start-Process -FilePath $chrome -ArgumentList @(
  "--headless=new","--disable-gpu","--no-first-run","--no-default-browser-check",
  "--remote-debugging-port=9333","--user-data-dir=$profile","about:blank"
) -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 4

node "$shots\tools\shoot.mjs" "http://127.0.0.1:8099/_dev/seed.html" "$shots\_seed.png" 390 844 8000 | Out-Null
Write-Output "seed done"

$pairs = @("dashboard|", "weight|weight", "food|food", "exercise|exercise", "water|water", "settings|settings")
foreach ($p in $pairs) {
  $parts = $p.Split("|")
  $name = $parts[0]
  $route = $parts[1]
  if ($route -eq "") {
    $url = "http://127.0.0.1:8099/"
  } else {
    $url = "http://127.0.0.1:8099/#/" + $route
  }
  $res = node "$shots\tools\shoot.mjs" $url "$shots\$Prefix-$name.png" 390 844 6000
  $json = ($res | Out-String)
  if ($json -match '"rendered": true') {
    Write-Output "OK   $name"
  } else {
    Write-Output "FAIL $name"
    Write-Output $json
  }
}

Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
Stop-Job $srv -ErrorAction SilentlyContinue
Remove-Job $srv -Force -ErrorAction SilentlyContinue
