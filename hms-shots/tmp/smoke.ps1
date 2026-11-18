$base = 'https://hms-d4gnh63iw73f09792.service.tcloudbase.com/api'
function Call($path, $obj) {
  try {
    $r = Invoke-WebRequest -Method Post -Uri "$base$path" -ContentType 'application/json' -Body ($obj | ConvertTo-Json -Compress) -UseBasicParsing -TimeoutSec 30
    return "HTTP $($r.StatusCode) $($r.Content)"
  } catch {
    $resp = $_.Exception.Response
    if ($resp) { $sr = New-Object IO.StreamReader($resp.GetResponseStream()); return "HTTP $([int]$resp.StatusCode) $($sr.ReadToEnd())" }
    return "ERR $($_.Exception.Message)"
  }
}
Write-Output ("1 ping   : " + (Call '/ping' @{}))
$login = Call '/login' @{ username='probe_user_1'; password='probe-pass-1234' }
Write-Output ("2 login  : " + $login)
$token = ([regex]::Match($login, '"token":"([^"]+)"')).Groups[1].Value
Write-Output ("3 pull   : " + (Call '/pull' @{ token=$token }))
Write-Output ("4 push#1 : " + (Call '/push' @{ token=$token; baseRev=0; payload=@{app='hms';schemaVersion=1;weights=@(@{date='2026-10-22';weightKg=70.5});meals=@();exercises=@();waters=@()} }))
Write-Output ("5 push#2 : " + (Call '/push' @{ token=$token; baseRev=0; payload=@{app='hms';hijack=$true} }))
Write-Output ("6 pull   : " + (Call '/pull' @{ token=$token }))
