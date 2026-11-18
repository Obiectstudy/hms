$latest = "C:\Users\Administrator\Desktop\hms\dist\HMS-latest.apk"
$cdnUrl = "https://hms-d4gnh63iw73f09792-1513758162.tcloudbaseapp.com/HMS-latest.apk"
Write-Output ("A èrM cdnUrl=[" + $cdnUrl + "] {‹=" + $cdnUrl.GetType().Name)
& tcb hosting deploy $latest /HMS-latest.apk -e hms-d4gnh63iw73f09792 2>&1 | Out-Null
Write-Output ("B LASTEXITCODE=" + $LASTEXITCODE)
Write-Output ("C èr cdnUrl=[" + $cdnUrl + "]")
if ($LASTEXITCODE -eq 0) { Write-Output "D pŸ/" } else { Write-Output "D p1%/" }
$payload = [ordered]@{ versionCode = 10; apkUrl = $cdnUrl }
Write-Output ("E JSON=" + ($payload | ConvertTo-Json -Compress))
