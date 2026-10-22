# 部署到 GitHub Pages（逐字步骤）
> 云同步的后端（CloudBase）接入实录与踩坑清单见 **[CLOUD-DEPLOY.md](./CLOUD-DEPLOY.md)**。

站点是纯静态文件，仓库根目录就是站点根目录。

> **当前状态：已部署上线**
> - 站点：https://obiectstudy.github.io/hms/
> - 仓库：https://github.com/Obiectstudy/hms （公开）
> - 首次部署：2026-10-20，完成后 24 个文件与本地逐字节一致
> - 发布方式：Settings → Pages → `Deploy from a branch` → `main` / `(root)`，每次 `git push` 自动重建
> - 本机 remote 已配成 SSH，并指向专用密钥 `~/.ssh/id_ed25519_hms`（见 `git config core.sshCommand`）
> - 曾经的 `Actions` 自动启用方案已移除：`configure-pages` 的 `enablement` 需要管理员级权限，`GITHUB_TOKEN` 拿不到，工作流必然红

## 0. 本次已完成的提交

```powershell
git -C C:\Users\Administrator\Desktop\hms log --oneline
# b62470a ci: 移除自动启用 Pages 的工作流
# b0d250a ci: 用 Actions 发布 Pages 并在首次运行时自动启用
# d74b8ad chore: 加一键部署脚本（PS 5.1 兼容，Token 不落盘）
# 920c074 feat: HMS 家庭健康管理 PWA
```

## 1. 重新部署（首次部署已做过，这里是通用流程）

在 PowerShell 里执行（把 `你的GitHub用户名` 换成真实用户名）：

```powershell
cd C:\Users\Administrator\Desktop\hms
git init
git add .
git commit -m "init: health management PWA"
git branch -M main
git remote add origin https://github.com/你的GitHub用户名/hms.git
git push -u origin main
```

仓库要**先在 GitHub 网页上创建好**（空仓库，不要勾 README / .gitignore），名字建议 `hms`。

> 如果 `git push` 要求登录，用 Personal Access Token 当密码（GitHub 已不支持账号密码）。
> 生成位置：GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic) → 勾 `repo`。

## 2. 打开 Pages

1. 仓库页 → **Settings** → 左侧 **Pages**
2. **Source** 选 `Deploy from a branch`
3. **Branch** 选 `main`，目录选 `/ (root)`
4. **Save**
5. 等 1–2 分钟，页面顶部出现 `Your site is live at https://<user>.github.io/hms/`

第一次构建有时要等到 5 分钟。刷新 Settings → Pages 看状态从 `queued` → `building` → `deployed`。

## 3. 在安卓手机上安装成 App

1. 手机 Chrome 打开 `https://<user>.github.io/hms/`
2. 右上角 ⋮ → **添加到主屏幕** / **安装应用**
3. 桌面出现心形图标，点开是全屏无地址栏的独立窗口
4. 断网后再点开，应仍能打开（Service Worker 缓存生效）

如果没出现"安装"入口，通常是：不是 HTTPS、或 `manifest` / 图标 404。用电脑浏览器打开 DevTools → Application → Manifest 看具体报错。

## 4. 更新版本

改完文件后：

```powershell
git add .
git commit -m "update"
git push
```

再等 1–2 分钟自动重新部署。

**重要**：改了前端文件后必须同时把 `sw.js` 里的 `CACHE_NAME` 版本号加一（例如 `hms-v1` → `hms-v2`），否则手机可能一直用旧缓存。刷新两次或重开 App 才会换新。

## 5. 常见故障

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 页面白屏，控制台 `Failed to load module script` | 用了 `/js/...` 这类绝对路径 | 全部改相对路径 `./js/...` |
| 404，仓库名出现在 URL 里但资源 404 | 同上，Pages 项目页挂在 `/repo/` 子路径 | 同上 |
| 点了"安装"没反应 | 不是 HTTPS 或 manifest 图标 404 | DevTools → Application → Manifest |
| 改了代码手机上没变 | Service Worker 缓存 | 加 `CACHE_NAME` 版本号；或手机 Chrome 里清除站点数据 |
| 数据不见了 | 清了浏览器数据 / 换了浏览器 / 换了域名 | 用 App 内「导出 JSON」备份，换设备后「导入」 |
| 拍照识别报 401/403 | Key 错、或该模型未开通 | 设置页「测试连接」看具体状态码 |

## 6. 换到自己的域名（可选，跳过不影响使用）

仓库 Settings → Pages → Custom domain 填域名 → 在域名商处加 CNAME 记录指向 `<user>.github.io` → 勾 Enforce HTTPS。

## 7. 安全与隐私

- 视觉识别的 API Key 保存在**手机浏览器本地**（IndexedDB），不进代码、不进仓库；但它就在这个设备上，手机借人时注意。
- 体重、饮食等记录只在本机，不上传。**换手机/清缓存前先导出 JSON**。
- 每次调用识别会把照片发给阿里百炼；照片同时留一份在本地 IndexedDB（用于记录详情展示）。

## 8. 推送通道（本机特有，坏的时候看这里）

本机 Clash 只提供 HTTP 代理（`127.0.0.1:7897`），**不接管系统 TCP**，所以 GitHub 的 22 端口直连会超时。
解决办法是给 SSH 挂一个 HTTP CONNECT 隧道，不依赖 Clash 的 TUN 模式：

- `C:\Users\Administrator\.ssh\proxy-connect.py` —— 把 stdio 桥接到 `CONNECT host:port` 的隧道脚本
- `C:\Users\Administrator\.ssh\config` —— `Host github.com` 下配置 `ProxyCommand python ...proxy-connect.py %h %p`

排查顺序：
1. `ssh -T git@github.com` 应回 `Hi Obiectstudy!`；
2. 若回 `Permission denied` → 密钥没加到 GitHub 或 `~/.ssh/config` 被改；
3. 若超时 → 代理没开（`Test-NetConnection 127.0.0.1 -Port 7897`）；
4. 若命令卡住不返回 → 隧道脚本缺 `os._exit(0)`（服务端关闭时必须强退，否则 ssh 与子进程互相等待）。

注意：不要在 `core.sshCommand` 里再写一遍 `-i` 与 `ProxyCommand`（引号会被 git 吞掉导致配置不生效），统一放在 `~/.ssh/config`。
