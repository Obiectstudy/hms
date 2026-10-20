# HMS 一键部署：建仓库 → 推送 → 开启 Pages → 验证站点
#
# 用法（Windows PowerShell 5.1）：
#   cd C:\Users\Administrator\Desktop\hms
#   powershell -ExecutionPolicy Bypass -File .\deploy.ps1
# 或：在这个文件上右键 →「使用 PowerShell 运行」
#
# Token 权限：public_repo（公开仓库）即可。生成地址：
#   https://github.com/settings/tokens/new?scopes=public_repo&description=hms-deploy
# Token 只存在于本次运行的进程内存里，不进对话、不落盘；推送完成后脚本会把 remote 换回干净地址。

param(
  [string]$RepoName = "hms",
  [string]$Token
)

$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $MyInvocation.MyCommand.Path)

function Fail($msg) { Write-Host "`n[X] $msg" -ForegroundColor Red; exit 1 }

if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Fail "找不到 git，请先安装 Git for Windows" }
if (-not (Test-Path ".git")) { Fail "当前目录不是 git 仓库，请在 hms 目录下运行" }

if (-not $Token) {
  Write-Host "需要一个 GitHub Personal Access Token（勾 public_repo 即可）。" -ForegroundColor Cyan
  Write-Host "生成地址: https://github.com/settings/tokens/new?scopes=public_repo&description=hms-deploy"
  Write-Host ""
  $secure = Read-Host "粘贴 Token（输入时不会显示）" -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { $Token = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}
if (-not $Token) { Fail "没有拿到 Token" }

$headers = @{
  Authorization = "Bearer $Token"
  "User-Agent"  = "hms-deploy"
  Accept        = "application/vnd.github+json"
}

Write-Host ""
Write-Host "[1/4] 校验 Token ..."
try {
  $me = Invoke-RestMethod -Uri "https://api.github.com/user" -Headers $headers -TimeoutSec 20
} catch {
  Fail "Token 无效或权限不足：$($_.Exception.Message)"
}
$owner = $me.login
Write-Host "      账号: $owner"

Write-Host ""
Write-Host "[2/4] 创建仓库 $owner/$RepoName ..."
$exists = $false
try {
  Invoke-RestMethod -Uri "https://api.github.com/repos/$owner/$RepoName" -Headers $headers -TimeoutSec 20 | Out-Null
  $exists = $true
  Write-Host "      仓库已存在，跳过创建"
} catch {
  Write-Host "      仓库尚不存在，准备创建"
}
if (-not $exists) {
  $body = @{ name = $RepoName; description = "HMS 家庭健康管理 PWA"; private = $false; has_issues = $false } | ConvertTo-Json
  try {
    Invoke-RestMethod -Method Post -Uri "https://api.github.com/user/repos" -Headers $headers -Body $body -ContentType "application/json" -TimeoutSec 25 | Out-Null
    Write-Host "      已创建"
  } catch {
    Fail "创建仓库失败：$($_.Exception.Message)"
  }
}

Write-Host ""
Write-Host "[3/4] 推送 main 分支 ..."
$cleanRemote = "https://github.com/$owner/$RepoName.git"
$authRemote = "https://${owner}:${Token}@github.com/$owner/$RepoName.git"
git remote remove origin 2>$null
git remote add origin $authRemote
$push = git push -u origin main 2>&1
$pushOk = ($LASTEXITCODE -eq 0)
git remote set-url origin $cleanRemote
if (-not $pushOk) {
  $push | ForEach-Object { Write-Host "      $_" }
  Fail "推送失败。常见原因：Token 缺 public_repo 权限；或本地代理 127.0.0.1:7897 未运行（git 全局配置里写死了这个代理）"
}
Write-Host "      推送成功，remote 已重置为 $cleanRemote"

Write-Host ""
Write-Host "[4/4] 开启 GitHub Pages ..."
$source = @{ source = @{ branch = "main"; path = "/" } } | ConvertTo-Json
try {
  Invoke-RestMethod -Method Post -Uri "https://api.github.com/repos/$owner/$RepoName/pages" -Headers $headers -Body $source -ContentType "application/json" -TimeoutSec 25 | Out-Null
  Write-Host "      已开启（首次构建约 1-2 分钟）"
} catch {
  $code = $null
  if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
  if ($code -eq 409) {
    Write-Host "      Pages 之前已开启，无需重复操作"
  } else {
    Write-Host "      自动开启失败（HTTP $code）：$($_.Exception.Message)" -ForegroundColor Yellow
    Write-Host "      请手动开启: https://github.com/$owner/$RepoName/settings/pages" -ForegroundColor Yellow
  }
}

$url = "https://$owner.github.io/$RepoName/"
Write-Host ""
Write-Host "等待构建 ..."
$live = $false
foreach ($i in 1..12) {
  Start-Sleep -Seconds 15
  try {
    $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 20
    if ($r.StatusCode -eq 200) { $live = $true; break }
  } catch {
    Write-Host "      第 $i 次探测：尚未就绪"
  }
}
Write-Host ""
if ($live) {
  Write-Host "[OK] 站点已上线：$url" -ForegroundColor Green
  Write-Host "     手机 Chrome 打开该地址 → 菜单 → 添加到主屏幕" -ForegroundColor Green
} else {
  Write-Host "[!] 站点地址：$url" -ForegroundColor Yellow
  Write-Host "    首次构建可能还要 1-2 分钟，稍后手动打开确认。" -ForegroundColor Yellow
}
Write-Host ""
Write-Host "安全提示：若这是临时 Token，现在可到 https://github.com/settings/tokens 撤销。"
