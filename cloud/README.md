# HMS 云同步后端（CloudBase 云函数 + PostgreSQL）

给纯静态 PWA 用的账号与快照服务：注册、登录、恢复码重置密码、整库快照推拉。
一个云函数 + 三张表 + 一条 HTTP 网关路径，没有别的依赖。

## 0. 目录里有什么

| 文件 | 作用 |
| --- | --- |
| `cloud/schema.sql` | 三张表的建表语句，在云开发控制台的 SQL 编辑器里整段执行 |
| `cloud/functions/hms-api/index.js` | 云函数代码：纯逻辑层 + 云函数入口 + 真实数据库连接（三层分开） |
| `cloud/functions/hms-api/package.json` | 云函数依赖声明（只有 `pg`），上传时勾选「云端安装依赖」 |
| `js/cloud-api.js` | 前端零依赖客户端封装（POST + JSON，五个函数） |
| `tests/cloud.test.mjs` | 用内存假数据库把五个接口端到端跑通的测试，不需要 PostgreSQL |

## 1. 冻结的 HTTP 协议（客户端并行实现，不可改字段）

所有接口都是 `POST`，请求与响应都是 JSON。统一错误体是
`{ "error": "<code>", "message": "<中文说明>" }`，错误 code 固定为
`bad-request`(400) / `unauthorized`(401) / `not-found`(404) / `conflict`(409) / `locked`(423) / `server-error`(500)。

| 接口 | 请求 | 成功 | 失败 |
| --- | --- | --- | --- |
| `POST /register` | `{ username, password }` | `200 { userId, recoveryCode }` | 400 / 409 |
| `POST /login` | `{ username, password }` | `200 { token, userId, expiresAt }` | 400 / 401 / 423 |
| `POST /reset` | `{ username, recoveryCode, newPassword }` | `200 { ok: true }` | 400 / 401 |
| `POST /pull` | `{ token }` | `200 { rev, savedAt, payload }` | 400 / 401 |
| `POST /push` | `{ token, baseRev, payload }` | `200 { rev }` | 400 / 401 / 409 |

约定：

- `username`：3–32 位，只允许 `A-Za-z0-9_`，唯一且大小写不敏感（入库统一小写）。
- `password`：至少 8 个字符。
- `recoveryCode`：注册时生成一次，**只在那一次响应里出现**，格式 `XXXX-XXXX-XXXX-XXXX`（Base32 去掉易混的 0 O 1 I 后剩 30 个字符）。输入时大小写、横线、空格都容忍。
- `savedAt` / `expiresAt` 都是**毫秒时间戳数字**。
- `pull` 在账号还没有快照时返回 `{ "rev": 0, "savedAt": null, "payload": null }`。
- `push` 是原子的：只有服务器当前 `rev` 仍等于 `baseRev` 时才写成 `rev + 1`，否则返回
  `409 { "error": "rev-conflict", "rev": <服务器当前 rev> }` —— 这是协议里唯一不走统一错误体的响应。
- 未注册用户名与密码错误返回**完全相同**的 401，避免用户名枚举。
- 非 `POST` 方法一律 404 `not-found`。

## 2. 部署前准备

1. 能登录腾讯云开发控制台：https://console.cloud.tencent.com/tcb
2. 目标环境 ID：`hms-d4gnh63iw73f09792`（上海，免费体验版 / 共享集群）。
3. 全程只需要填两个环境变量：`CLOUDBASE_APIKEY` 与 `CLOUDBASE_ENV_ID`（第 4 步）。
   数据库没有任何网络地址，**不要再去找连接串**，原因见第 12 节。

## 3. 第 1 步：建表

1. 打开 https://console.cloud.tencent.com/tcb ，右上角切到环境 `hms-d4gnh63iw73f09792`。
2. 左侧菜单点「数据库」。
3. 在上方标签里选「SQL 型数据库」（PostgreSQL；如果界面上叫「云数据库」也是同一处）。
4. 点「SQL 编辑器」或「执行 SQL」按钮。
5. 用记事本打开本目录的 `cloud/schema.sql`，**全选复制**，粘贴进编辑器输入框。
6. 点「执行 / 运行」。看到三行 `CREATE TABLE` / `CREATE INDEX` 的成功提示即完成。
7. 回到数据库的「表」列表，确认有 `users`、`sessions`、`snapshots` 三张表（没看到就点刷新）。
   这个脚本全部用 `IF NOT EXISTS`，重复执行不会报错、不会清数据。

## 4. 第 2 步：创建 API Key（服务端管理员凭证）

云函数访问 SQL 数据库走的是**云开发 HTTP API**（`POST /v1/rdb/exec-pgsql`），鉴权用 **API Key**。
官方原文：「API Key（推荐）：在函数环境变量中配置 `CLOUDBASE_APIKEY`，初始化时传入 accessKey」
（https://docs.cloudbase.net/cloud-function/resource-integration/cloudbase ）。

1. 打开 https://console.cloud.tencent.com/tcb ，切到环境 `hms-d4gnh63iw73f09792`。
2. 左侧菜单进入「云开发平台」→「ApiKey 管理」（有的版本叫「API Key」/「密钥管理」）。
3. 新建一个 **API Key**（服务端管理员类型；**不要**选 Publishable Key，那个是前端匿名用的）。
   名字随意，例如 `hms-api`，有效期选「永不过期」（云函数要长期可用）。
4. **明文只在创建成功那一次显示**，立刻复制走；列表页只会给出打码后的值。
5. **不要**把它写进任何文件、贴进聊天、截图或提交到仓库 —— 它只属于第 4 步的环境变量输入框。
6. 命令行等价操作（可选）：`tcb env apikey create hms-api -e hms-d4gnh63iw73f09792 --json`，
   同样只在创建时回显一次明文。

## 5. 第 3 步：新建云函数

1. 左侧菜单点「云函数」→「新建云函数」。
2. 函数名填 `hms-api`（要和 HTTP 网关里绑定的名字一致）。
3. 运行环境选 `Node.js 18`（16 / 20 也可以，代码只用到 Node 16+ 的内置能力）。
4. 创建方式选「上传代码包」或「上传文件夹」，选中本目录的 `cloud/functions/hms-api` 目录
   （里面必须有 `index.js` 和 `package.json` 两个文件在**同一层**）。
5. 「云端安装依赖」照勾无妨，但**已不再是必需**：新通道在运行期完全不 `require('pg')`，
   `package.json` 里保留 `pg` 只是让那份旧的直连实现还能用（第 12 节）。
6. 内存 256MB、超时 10 秒即可（scrypt 一次约几十毫秒，够用）。
7. **不要**配置「私有网络 / VPC」：本套餐下 SQL 数据库没有任何网络地址，配了也没有意义。
8. 点「确定 / 创建」，等状态变成「部署完成」。

## 6. 第 4 步：配置环境变量 `CLOUDBASE_APIKEY` 与 `CLOUDBASE_ENV_ID`

1. 云函数列表点进 `hms-api` →「函数配置」或「配置」页。
2. 找到「环境变量」区块 →「新增」，加两条：

   | 变量名 | 变量值 | 说明 |
   | --- | --- | --- |
   | `CLOUDBASE_APIKEY` | 第 2 步复制的 API Key 明文 | 官方文档写死的名字，一个字母都不能差 |
   | `CLOUDBASE_ENV_ID` | `hms-d4gnh63iw73f09792` | 环境 ID，用来拼请求域名 |

3. 点「保存」，控制台会重新发布一版，等它再次「部署完成」。
4. 代码只从这两个环境变量读凭证，**绝不**写文件；日志、响应、错误信息里都不会出现密钥本身。
5. 域名是拼出来的：`https://<CLOUDBASE_ENV_ID>.api.tcloudbasegateway.com/v1/rdb/exec-pgsql`，
   所以环境 ID 填错会直接 4xx / 连不上。
6. 兜底别名：代码还认 `CLOUDBASE_API_KEY` / `TCB_API_KEY` / `API_KEY` 与 `TCB_ENV` /
   `TENCENTCLOUD_TCB_ENVID` / `TCB_ENV_ID`，但**新部署请只用上表这两个名字**。
   `TCB_ENV` 由云函数运行时自动注入，通常不需要手工配。

## 7. 第 5 步：用 HTTP 访问服务把函数暴露到公网

1. 左侧菜单点「HTTP 访问服务」（有的控制台版本叫「云接入」）。
2. 点「新建 / 添加路径」。
3. 路径填 `/api`（也可以填 `/hms-api`，函数按路径最后一段路由，前缀随便起）。
4. 绑定类型选「云函数」，选择 `hms-api`。
5. 打开「集成响应」（否则拿到的是函数原始返回值，不是带状态码的 HTTP 响应）。
6. 保存。记下公网域名，形如 `https://<环境ID>.service.tcloudbase.com`，接口地址就是
   `https://<环境ID>.service.tcloudbase.com/api/register` 等。

## 8. 第 6 步：逐条验证部署成功

Windows 上请在 PowerShell 里用 `curl.exe`（直接写 `curl` 会被 PowerShell 当成 `Invoke-WebRequest` 别名）。
先把域名替换成第 5 步记下的域名，然后**从上往下**执行：

A. 网关到函数这条链路（不碰数据库）

    curl.exe -i -X POST https://<环境ID>.service.tcloudbase.com/api/ping -H "content-type: application/json" -d "{}"

期望：`HTTP/1.1 404` 与 `{"error":"not-found","message":"接口不存在"}`。
拿到 404 就说明「公网 → 网关 → 云函数」通了；如果拿到 502，是函数启动失败（多半是依赖没装）。

B. 注册

    curl.exe -s -X POST https://<环境ID>.service.tcloudbase.com/api/register -H "content-type: application/json" -d "{\"username\":\"alice_2024\",\"password\":\"demoPass1234\"}"

期望：`{"userId":1,"recoveryCode":"XXXX-XXXX-XXXX-XXXX"}`。
**把 recoveryCode 抄到安全的地方** —— 它只会出现这一次，忘记密码时全靠它。

C. 登录

    curl.exe -s -X POST https://<环境ID>.service.tcloudbase.com/api/login -H "content-type: application/json" -d "{\"username\":\"alice_2024\",\"password\":\"demoPass1234\"}"

期望：`{"token":"<64 位十六进制>","userId":1,"expiresAt":1730000000000}`。
把 token 抄下来填进 D 和 E。

D. 拉取（还没有快照）

    curl.exe -s -X POST https://<环境ID>.service.tcloudbase.com/api/pull -H "content-type: application/json" -d "{\"token\":\"<粘贴 C 的 token>\"}"

期望：`{"rev":0,"savedAt":null,"payload":null}`。

E. 推送，再故意冲突一次

    curl.exe -s -X POST https://<环境ID>.service.tcloudbase.com/api/push -H "content-type: application/json" -d "{\"token\":\"<粘贴 C 的 token>\",\"baseRev\":0,\"payload\":{\"weights\":[{\"kg\":68.5}]}}"

期望：`{"rev":1}`。把同一条命令再执行一次（`baseRev` 还是 0），期望 `{"error":"rev-conflict","rev":1}`。

同样的四步在 PowerShell 原生写法（省去反斜杠转义）：

    $base = "https://<环境ID>.service.tcloudbase.com/api"
    Invoke-RestMethod -Method Post -ContentType 'application/json' -Uri "$base/register" -Body '{"username":"alice_2024","password":"demoPass1234"}'
    Invoke-RestMethod -Method Post -ContentType 'application/json' -Uri "$base/login" -Body '{"username":"alice_2024","password":"demoPass1234"}'

## 9. 第 7 步：前端怎么接

`js/cloud-api.js` 已经把协议封好了，零依赖：

    import { createCloudApi } from './js/cloud-api.js';

    const api = createCloudApi({ baseUrl: 'https://<环境ID>.service.tcloudbase.com/api' });

    await api.register('alice_2024', 'demoPass1234');          // { userId, recoveryCode }
    const { token, expiresAt } = await api.login('alice_2024', 'demoPass1234');
    await api.pull(token);                                      // { rev, savedAt, payload }
    await api.push(token, rev, payload);                        // { rev }，冲突抛 rev-conflict
    await api.reset('alice_2024', recoveryCode, 'newPass1234'); // { ok: true }

失败一律抛 `CloudApiError`，带 `code` / `status` / `rev` 与便捷判断 `isAuthError`、`isLocked`、`isConflict`、`isNetworkError`。
推拉决策仍归 `js/sync.js` 的 `planSync`：这里只负责把请求发出去并把 409 的 `rev` 原样带回来。

## 10. 排错对照表

| 现象 | 多半原因 | 处理 |
| --- | --- | --- |
| A 步骤拿到 502 | 云函数没起来：依赖没装 / 代码目录层级不对 | 重新上传并勾选「云端安装依赖」，确认 `index.js` 与 `package.json` 同级 |
| `500 server-error`，日志里有 `"phase":"connect"` | 没配 `CLOUDBASE_APIKEY` / `CLOUDBASE_ENV_ID` | 回第 4 步 |
| `500 server-error`，日志里有 `"sqlstate":"42P01"` | 表没建 | 回第 1 步执行 `schema.sql` |
| `500 server-error`，日志里有 `"sqlstate":"42501"` | 角色不对，或 API Key 不是管理员类型 | 确认用的是 API Key（不是 Publishable Key）；代码固定用 `cloudbase_postgres` |
| `500 server-error`，日志里有 `"sqlstate":"UNAUTHORIZED"` / `"ACTION_FORBIDDEN"` | API Key 抄错 / 已删除 / 非管理员 | 回第 4 步重建并重贴 |
| `500 server-error`，日志里有 `"sqlstate":"TIMEOUT"` / `"NETWORK"` | 云函数出不了网，或网关抖动 | 确认函数公网出口正常；重试 |
| 所有接口 `401` | token 过期（30 天）或重置后旧 token 被清 | 重新登录 |
| `423 locked` | 连续输错 10 次，锁 15 分钟 | 等 15 分钟，或用恢复码 `/reset` 重置（重置会顺带解锁） |
| 网关返回 404 但不是我们的 JSON | 路径没绑定 / 函数名不符 | 回第 5 步检查绑定与「集成响应」开关 |

云函数日志在「云函数 → hms-api → 日志」里看。日志只记路由、状态码、耗时与错误类别 / SQLSTATE，
**不会**记录密码、token、连接串或参数值。

## 11. 安全设计

- 密码与恢复码都用 `crypto.scryptSync(url, salt, 32, { N: 16384, r: 8, p: 1 })`，每个用户独立 16 字节随机盐，比较用 `timingSafeEqual`。
- 会话 token 是 32 字节随机数的十六进制，库里只存它的 sha256；有效期 30 天，重置密码会清空该账号全部会话。
- 同一用户名连续失败 10 次锁定 15 分钟（第 10 次仍回 401，第 11 次起 423）；登录成功清零。
- 未注册用户名与密码错误返回逐字节相同的 401；用户不存在时也照样跑一次 scrypt，拉平响应时间。
- 数据库凭证（API Key）只从环境变量读，不写文件、不进日志、不回显；
  错误信息里只带状态码、SQLSTATE 与 `requestId`，绝不带上游 `message`/`details`（可能夹带用户输入）。
- 所有入参校验类型与长度；任何未预期异常都被兜成 `500 server-error`，不泄露底层信息。

## 12. 为什么不再用 pg 直连（`DATABASE_URL`）

本环境是**免费体验版 / 共享集群**。控制台「SQL 型数据库 → 配置 → 网络配置」的原文是：

> 当前共享集群暂不提供相关能力，可以升级至独享集群启用能力。

也就是说共享集群**没有任何网络地址**：内网地址是 `-`，外网不可开启，也没有安全组。
`pg` 直连（无论是 `DATABASE_URL` 连接串，还是 `PGHOST`/`PGPORT`/`PGUSER`/`PGPASSWORD`/`PGDATABASE`
那一套）在这套套餐下**根本无法建立连接**，跟代码写得好不好无关。

实际可用的只剩云开发自己的 HTTP API 这一条通道：控制台建表用的 `tcb db execute` 走的就是同一类接口
（报错前缀 `[ExecutePGSql]`），云函数里换成用注入的 API Key 调 `POST /v1/rdb/exec-pgsql`，等价可用，
且**支持参数化查询**（`$1`/`$2` 占位符 + `parameters` 数组），所以 SQL 一行都不用改写。

代码里旧的 `openDatabase()`（`require('pg')` + `DATABASE_URL` / `PGHOST` 那套）**原样保留**，
方便将来升级到独享集群后一行切回去；但 `main()` 已经不再调用它。

## 13. 已知限制（部署后自行确认）

1. 本地测试用的是内存假数据库，**真实数据库上尚未执行过这些 SQL**（只有建表语句在控制台跑过）。
   第 1 步执行 `schema.sql` 后，按第 8 步 A→E 走一遍即可覆盖所有语句。
2. 错误码映射（网关的 `DATABASE_23505` → 业务层判定的 `23505`）、`parameters` 的绑定行为
   与网关的事件 / 集成响应格式，都按官方 OpenAPI 文档实现，**未在真环境验证**。
3. 恢复码不轮换：`/reset` 协议只允许返回 `{ ok: true }`，没有渠道下发新码，因此旧码重置后仍可用。
   要废除旧码，只能在数据库里手工改 `users.recovery_hash`。
4. 会话过期只在读取时判断，库里的过期行需要手工清理（`schema.sql` 末尾给了一条可选语句）。
5. 云端测试与真机联调仍需你在控制台完成；本地能保证的是协议形状、口令/令牌存储形态与六个决策分支的正确性。
