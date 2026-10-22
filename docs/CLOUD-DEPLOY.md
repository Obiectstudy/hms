# CloudBase 后端接入实录与踩坑清单

> 2026-10-22 完成。环境 `hms-d4gnh63iw73f09792`（国内站 · 上海 · 免费体验版 · 2027-04-22 到期）。
> 这份文档记录**为什么这么做**和**踩过的坑**；一步步的部署操作在 `cloud/README.md`。

## 一、结论：最终采用的架构

```
浏览器/PWA ──HTTPS──> HTTP 访问服务（网关）
                      https://hms-d4gnh63iw73f09792.service.tcloudbase.com/api
                            ↓ 事件型云函数 hms-api（Nodejs18.15 / 256MB / 超时 10s）
                            ↓ POST https://{envId}.api.tcloudbasegateway.com/v1/rdb/exec-pgsql
                            ↓ Authorization: Bearer <CLOUDBASE_APIKEY>
                            ↓ { sql, parameters[], role: 'cloudbase_postgres' }
                      SQL 型数据库（PostgreSQL 17.11，共享集群）
```

**关键点**：函数与数据库之间**不是 TCP 直连**，而是走云开发的 HTTP API；`parameters` 原生支持 `$1/$2` 占位符，
所以 17 条 SQL 一行未改，**没有写任何字符串拼接或转义**。

## 二、为什么不用 `pg` 直连（这不是选择，是被逼的）

最初设计是 `pg` + `DATABASE_URL`（文档《连接数据库》的"服务端直连"示例也是 `process.env.PGHOST` 那套）。实际不可行：

- 控制台「SQL 型数据库 → 配置 → 网络配置」原文：**「当前共享集群暂不提供相关能力，可以升级至独享集群启用能力。」**
- 共享集群下**内网地址为 `-`、外网地址开不了、没有安全组**，因此**根本没有可连的地址**
- 文档里 `PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE` 那套变量**平台不会自动注入**（实测 `/ping` 仍在 `phase:"connect"` 失败）

**升级独享集群才能直连**——那是另一个数量级的费用，且对外暴露公网库也不适合放健康数据。所以改用 API 通道，
反而更安全：不需要数据库密码、不开公网端口、API Key 只存在于函数运行环境，从不下发到浏览器。

`cloud/functions/hms-api/index.js` 里旧的 `openDatabase()`（`require('pg')`）**原样保留**，将来若升级独享集群可以一行切回。

## 三、踩坑清单（按踩到的顺序）

### 1. `cloudbaserc.json` 里的 `envVariables` 会冲掉平台注入的变量 ⚠️ 最坑

我在 `cloudbaserc.json` 里写了 `"envVariables": { "CLOUDBASE_ENV_ID": "..." }`，一次部署之后，
`tcb fn detail` 里**原来有的 `CLOUDBASE_APIKEY` 和 `CLOUDBASE_APIKEY_ID` 全没了**，只剩我刚写的那一个。

- 配置文件的 `envVariables` 是**整体替换**函数的环境变量集合，不是合并
- **正确做法**：`cloudbaserc.json` 里**不要写 `envVariables`**，环境变量一律在控制台维护
- 识别症状：`tcb fn detail` 的 Environment variables 行里少了东西

### 2. `tcb fn detail` 是可信的，`None` 就是真的空

我一度以为"平台注入的变量不显示在这儿"，据此误判过一次。实测**它显示**（`CLOUDBASE_APIKEY=***`），
所以看到 `None` 就该去查环境变量，而不是猜。查看时务必**屏蔽值**：

```powershell
$raw = (tcb fn detail hms-api -e <envId> 2>&1 | Out-String)
[regex]::Replace($raw, '(CLOUDBASE_APIKEY|CLOUDBASE_ENV_ID)\s*=\s*\S+', '$1=***')
```

### 3. 光"新建 API Key"不生效，必须**选中并保存**

环境变量面板里的 `API Key 设置` 开关打开后，下拉框要**选中具体那个 Key**再保存，平台才会注入
`CLOUDBASE_APIKEY`。只创建 Key 不绑定 = 环境里什么都没有。

### 4. `--httpFn` 会创建错类型的函数

`tcb fn deploy --httpFn` 创建的是 **Web 函数**，它要求 `scf_bootstrap` 常驻 HTTP 服务，与我们的
**事件型函数 + 集成响应**模型不兼容（当时 CLI 还自作主张建了个 `http-nodejs-helloworld-*` 示例函数）。
**正确做法**：不加 `--httpFn`，用 `--path /api` 让部署顺手创建 HTTP 访问服务路径。

### 5. `tcb routes add` 管不了默认域名

对 `{envId}.service.tcloudbase.com` 调 `routes add` 会报
`is a system internal domain, manual creation or modification is not supported`。
——`routes` 是给**自定义域名（需备案）**用的。默认域名下的路径只能靠 `fn deploy --path` 或控制台创建。

### 6. `tcb db execute` 对多语句和注释不友好

整份 `schema.sql`（含中文注释、多条语句）一次喂进去会报
`syntax error at or near "id"`——**第一条 `CREATE TABLE` 的开头被吞掉了**。
可靠做法：**剥掉注释、拆成单条、压成单行**再逐条执行（`cloud/schema.sql` 本身没问题，是喂法的问题）。

```js
// Node 里做规范化最稳（PowerShell 侧 `Get-Content` 在这个环境里报的行数与文件实际不符，原因未查明）
const stmts = text.replace(/\r\n?/g, '\n')
  .split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n')
  .split(';').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
```

### 7. PowerShell 传 JSON 给原生命令会丢引号

`tcb routes add --data '{"a":"b"}'` 里的双引号会被 PowerShell 吃掉 → `Invalid JSON format`。

- 用 `-d @文件`（`fn invoke` 支持 `@filename`）
- 写文件时**不要用 `Set-Content -Encoding UTF8`**（会带 BOM，CLI 解析失败）——用 Node 写
- `--%`（停止解析）在这个 shell 里会被当成普通参数传下去，也不行

### 8. 写操作必须显式带角色，否则静默只读

`exec-pgsql` 不传 `role` 会落到 `cloudbase_read_only_user`，我们的 INSERT/UPDATE 会被 `42501` 全拒。
必须 `role: 'cloudbase_postgres'`。这条不在直觉里，容易只在"写失败读成功"时才暴露。

### 9. 错误码要翻译回 SQLSTATE

网关的错误码是 `DATABASE_23505` 这种形状，而业务层按 pg 的 `err.code === '23505'` 判唯一冲突。
适配层做了一次 `DATABASE_<SQLSTATE> → <SQLSTATE>` 的翻译，于是**业务逻辑零改动**。

### 10. 函数日志里没有失败原因（防泄露的代价）

`main()` 捕获异常后只记 `{phase:'connect', name:'Error'}`，不记 message（防止密钥/连接串进日志）。
这在定位"环境变量缺失"这类**配置问题**时会瞎猜。折中：配置类错误的 message 只包含**变量名**，可以安全输出。

### 11. 网关给非 2xx 加了 `content-disposition: attachment`

状态码与 body 都正常透传（`x-cloudbase-upstream-type: Tencent-SCF` 表明来自函数），只是多了这个头。
用 PowerShell 的 `Invoke-WebRequest` 读错误响应体容易拿到空字符串，**用 `curl.exe -i` 才能看全**。

## 四、验收（部署完照着跑）

`cloud/README.md` §8 有完整命令。实测通过的六项：

| # | 请求 | 期望 | 实测 |
| --- | --- | --- | --- |
| 1 | `POST /api/ping` | `404 {"error":"not-found"}` | ✅ |
| 2 | `POST /api/register` | `200` + userId + 恢复码 | ✅ `{"userId":1,"recoveryCode":"…"}` 743ms |
| 3 | `POST /api/login` | `200` + token + expiresAt | ✅ |
| 4 | `POST /api/pull`（无快照） | `{rev:0, savedAt:null, payload:null}` | ✅ |
| 5 | `POST /api/push`（baseRev=0） | `200 {rev:1}` | ✅ |
| 6 | 同一 baseRev 再 push | `409` | ✅ 原子性生效 |

前两项用 `tcb fn invoke -d @payload.json`（绕过网关直调函数）排错更清晰；后四项建议走公网网关，顺便验网关行为。

## 五、成本与续期

- **免费体验版**：3000 资源点/月，**不支持加购资源包与按量付费**；用完只能等次月或升级
- **单次续期 6 个月，不支持自动续费** —— 本环境到期日 **2027-04-22**，到期前手动续
- 最小升级档：个人版 ¥19.90/月；数据库直连能力要独享集群，档次更高

## 六、将来若升级到独享集群，怎么切回直连

1. 控制台开启外网/内网地址与安全组
2. 云函数环境变量加 `DATABASE_URL=postgresql://用户:密码@地址:端口/库名`
3. `index.js` 的 `main()` 把 `openDatabaseViaApi()` 换回 `openDatabase()`
4. 删除 `CLOUDBASE_APIKEY`（可选）

代码里两条通道并存，切换只改一行。
## 七、静态网站托管：两个"下载慢"问题的解法（2026-10-22）

### 问题
客户端内点「立即更新」下载极慢。实测本机从 **GitHub Pages 只有 5.5 KB/s**（1.79MB 的 APK 需 **317 秒**），
而同一文件走 **CloudBase 静态托管是 1400 KB/s（1.2 秒）—— 快 254 倍**。
原因不是用户带宽，是 GitHub Pages 走国际线路（Fastly）；家人没装梯子时将无法忍受。

### 做法
1. **更新包**：`tools/release.ps1` 每次发版自动 `tcb hosting deploy` 到静态托管，并把 `version.json` 的
   `apkUrl` 指向该地址；上传失败则自动回退到 GitHub 地址（不因一次失败发不出版）。
2. **整个前端**也搬到静态托管，得到国内直连的网址：

   | | 地址 | 说明 |
   | --- | --- | --- |
   | 主站（国内直连） | https://hms-d4gnh63iw73f09792-1513758162.tcloudbaseapp.com/ | 家人用这个 |
   | 备用（国际线路） | https://obiectstudy.github.io/hms/ | 保留，国外访问更快 |

### 搬迁时要小心的两件事
- **绝不能上传整个仓库根目录**——`.git`（仓库历史）与 `android/`（构建产物）会一并暴露在公网。
  正确做法是先做**只含前端文件的干净暂存目录**（index.html / app.js / styles.css / sw.js / manifest / version.json / js / views / icons / dist），
  上传前清点文件数并断言没有危险路径。
- **换域名 = 换 origin**，而 IndexedDB 按 origin 隔离：**老用户在原地址的数据不会自动跟过去**。
  好在安卓 APK 的内置页面用的是 `appassets.androidplatform.net`，与这两个网址都无关，**手机上的数据不受影响**；
  只有曾在手机浏览器里直接用过网页版的人需要导出/导入一次。

### 命令备忘
```bash
tcb hosting detail -e <envId>                    # 查看托管状态与默认域名
tcb hosting deploy <本地目录> <云端路径> -e <envId>  # 上传
tcb hosting list / -e <envId>                    # 列出云端文件
```
