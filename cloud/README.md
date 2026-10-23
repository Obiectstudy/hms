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
- `push` 的 `payload` 既可以是普通 JSON 对象，也可以是**压缩包装体** `{ "__gz": "<base64(gzip(utf8(JSON)))>" }`
  （客户端为绕开网关约 100KB 的请求体上限而做的**上传通道编码**，见第 16 节）。服务端在写库前把它解成
  明文，**库里与 `pull` 的响应里永远只有明文 JSON**：压缩不是存储格式，旧客户端不受影响。
- 非 `POST` 方法一律 404 `not-found`；唯一例外是预检 `OPTIONS`（见第 14 节）。
- 所有响应（含 4xx / 5xx）都带 CORS 头：`access-control-allow-origin`（反射请求 `Origin`，没有该头时回落 `*`）、
  `access-control-allow-methods`、`access-control-allow-headers`、`access-control-max-age` 与 `vary: origin`。
  协议字段、状态码与错误体不受影响 —— CORS 只加头。

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
| APP 里点任何按钮都提示「网络不可用」，但浏览器同源页面正常 | 真机页面 origin 是 `https://appassets.androidplatform.net`（WebViewAssetLoader），与接口域名跨域，预检 `OPTIONS` 被挡 | 确认函数已带 CORS 头（第 14 节的两条 curl）；若 `access-control-*` 没出现在响应里，说明网关剥掉了上游自定义头，改走第 14 节的同源替代方案 |
| 同一个请求：浏览器/curl 里是 `413` 且**没有任何 `access-control-*` 头** | 网关自己拦下的超限请求（网关请求体上限实测 102400 字节，远小于函数里的 `MAX_PAYLOAD_BYTES`）；响应不经过函数，谁也补不上 CORS 头 | 把快照变小或分批，见第 15.2 节。这不是函数故障：服务端日志里**不会**留下任何记录 |
| 同一个请求：`400 bad-request`+「payload 过大」/「请求体过大」，带全套 CORS 头 | 函数自己判定的超限，日志里会有 `"tooLarge":true` 与 `"limit"` | 同样要缩小数据，见第 15.2 节 |

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

## 13. CORS（真机 WebView 跨域）

真机里页面由 `WebViewAssetLoader` 提供，origin 是 `https://appassets.androidplatform.net`，而接口在
`https://<环境ID>.service.tcloudbase.com/api` —— **跨域**。我们的请求带 `authorization` 头，浏览器/WebView
会先发**预检 OPTIONS**，预检不过就表现为「网络不可用」（前端拿到的是网络层错误，不是我们的 JSON 错误体）。

平台侧两条路都已封死：`tcb cors add` 在免费体验版报 `[CreateAuthDomain] 当前套餐无法执行此操作`，
控制台也没有别的 CORS 开关。**所以 CORS 由函数自己发头**（网关会原样透传上游的自定义响应头）：

- `OPTIONS` 任意路径：直接 204，带 `access-control-allow-methods: POST, OPTIONS`、
  `access-control-allow-headers: content-type, authorization`、`access-control-max-age: 86400`，
  **不进业务路由**（不会被当成「非 POST 一律 404」）。
- 其余所有响应（200 / 400 / 401 / 404 / 409 / 423 / 500）：带 `access-control-allow-origin`
  （反射请求的 `Origin`，头名大小写不敏感；请求没带该头时回落 `*`）与 `vary: origin`。
- 不用 cookie（鉴权走 `authorization: Bearer`），因此**不输出** `access-control-allow-credentials`。
- 以上说的是**函数产出**的响应。网关自己产出的错误（例如超限的 `413`）不经过函数，**没有**这些头：
  真机里读不到它，只会显示「网络不可用」。识别办法见第 15.2 节。

部署后逐条核对（Windows 用 `curl.exe`）：

    curl.exe -s -i -X OPTIONS "https://<环境ID>.service.tcloudbase.com/api/register" ^
      -H "Origin: https://appassets.androidplatform.net" ^
      -H "Access-Control-Request-Method: POST" ^
      -H "Access-Control-Request-Headers: content-type,authorization"

期望：`HTTP/1.1 204`，并且响应里有 `access-control-allow-origin: https://appassets.androidplatform.net`。
**如果这一行（连同下面的 POST 响应）都没有 `access-control-*`，说明网关把上游自定义头剥掉了** ——
那就别在前端绕，改走同源：把 API 放到页面自己的域名下（PWA 在 `hms-....tcloudbaseapp.com` 上时，
同一域名下加一条 `/api` 的 HTTP 访问服务路径），此时浏览器认为是同源请求，既不预检也不需要 CORS 头。

实际请求同样要带头：

    curl.exe -s -D - -o NUL -X POST "https://<环境ID>.service.tcloudbase.com/api/ping" ^
      -H "Origin: https://appassets.androidplatform.net" -H "content-type: application/json" -d "{}"

期望：状态行 + `access-control-allow-origin`（`/ping` 不是接口，404 也一样带头）。

## 14. 已知限制（部署后自行确认）

1. 本地测试用的是内存假数据库，**真实数据库上尚未执行过这些 SQL**（只有建表语句在控制台跑过）。
   第 1 步执行 `schema.sql` 后，按第 8 步 A→E 走一遍即可覆盖所有语句。
2. 错误码映射（网关的 `DATABASE_23505` → 业务层判定的 `23505`）、`parameters` 的绑定行为
   与网关的事件 / 集成响应格式，都按官方 OpenAPI 文档实现，**未在真环境验证**。
3. 恢复码不轮换：`/reset` 协议只允许返回 `{ ok: true }`，没有渠道下发新码，因此旧码重置后仍可用。
   要废除旧码，只能在数据库里手工改 `users.recovery_hash`。
4. 会话过期只在读取时判断，库里的过期行需要手工清理（`schema.sql` 末尾给了一条可选语句）。
5. 云端测试与真机联调仍需你在控制台完成；本地能保证的是协议形状、口令/令牌存储形态与六个决策分支的正确性。

## 15. 两类边界故障：payload 净化 与 超限识别

### 15.1 jsonb 不接受 NUL 与落单代理项（已修）

`\u0000`（NUL）与**落单代理项**（lone surrogate，如 `\ud800`）在 JSON 里都是**合法**转义序列，
而 PostgreSQL 的 `jsonb` 两者都不收：直接写库报 `22P05 unsupported Unicode escape sequence`。
修复前服务端只校验结构与长度，随后就 `$4::jsonb` 写进去 —— 已登录用户只要本机数据里混进一个这样的
字符，`push` 就永远 500、`rev` 永不推进、客户端无限重试、**快照永远传不上去**（旧快照不会被写坏）。

现在 `push` 在 `requirePayload` 之后、拼 SQL 之前净化 payload：

- 把这两类字符从字符串里**删掉**（删成空串），**不**替换成 `·` 之类可见字符 —— 避免污染用户数据；
- emoji（合法代理对）、中文、组合字符、换行 / 制表符等**全部原样保留**（合法字符一个字节都不动）；
- 对象 / 数组 / 字符串**递归**处理，**键名**也处理；键名被删成空串的整条丢弃（原本就是空键名 `""` 的保留）；
- 整份 payload 净化后变成空对象 `{}` **照常接受**：用户数据就是这样，不是错误；
- 日志只记「删了几处」（`{"route":"push","status":200,...,"sanitized":5}`），**绝不记内容**；
- 净化返回副本、不就地改写入参；循环引用与 2 万层嵌套都不抛异常（显式栈遍历，没有深度上限）。

### 15.2 超限：网关的 413 与函数的 400 怎么区分

真实链路上有两道不同的限制，客户端看到的东西完全不同：

| 谁拦的 | 响应 | 带 CORS 头？ | 服务端日志 |
| --- | --- | --- | --- |
| HTTP 网关（请求体超过网关上限，实测 102400 字节） | `413`，不是我们的 JSON | **不带**（网关改不了） | **没有**（请求根本没到函数） |
| 云函数（payload > `MAX_PAYLOAD_BYTES`，或请求体 > `MAX_BODY_BYTES`） | `400` + `bad-request` +「payload 过大」/「请求体过大」 | 带全套 | 有，且多两个字段：`"tooLarge":true`、`"limit":<上限>` |

所以「能不能被识别」落在两处：函数自己判定的超限一定带 CORS 头并留下 `tooLarge` 日志；反过来，
客户端拿到**不带任何 `access-control-*` 头**的 `413`、而服务端日志里找不到同一次请求的记录 ——
那就是网关提前拦的。响应体字段与两个上限常量都**没动**：函数自己的 400 分支在真实链路上不可达
（网关先拦），改它只会改协议，没有意义。相关断言见 `tests/cloud.test.mjs` 第 13 节。

## 16. 压缩上传（`{ __gz }`）：客户端压、服务端解，库里只存明文

### 16.1 上传为什么要压缩

网关对 `/push` 请求体的硬上限约 100KB（实测 102400 字节），而它自产的 413 **不带 CORS 头**：真机
WebView 读不到响应体，界面只会显示「网络不可用」，用户既看不懂也没法自救。客户端于是把大快照压成
`{ "__gz": "<base64(gzip(utf8(JSON)))>" }` 再上传（`js/sync.js` 的 `encodePayloadForUpload` /
`compressedPayloadOf`，标记键 `GZIP_MARKER_KEY = '__gz'`）。

### 16.2 为什么**服务端必须解压**（本节的要点）

如果服务端把 `{ __gz }` 原样写进库里，那就只有**新客户端**读得懂它。旧版 App（网页资源内嵌、
不会自动更新）读到 `{ __gz }` 时**不报错**：它把包装体当成数据 `loadAll(replace)` 写进本机业务表、
推进 rev，之后回推时再把这份垃圾当成云端快照传上来 —— **旧客户端没有任何自我保护**（实测，不是推测）。

所以 `push` 在 `requirePayload` 之后、`sanitizePayload` 之前多了一步解压，**库里永远只存明文 JSON**：

1. `payload` 是对象且 `payload.__gz` 是**非空字符串** → 严格 base64 解码 → `zlib.gunzipSync` → `JSON.parse`；
2. 解出来的必须是**对象**（非数组、非 `null`），再照旧过一遍 `requirePayload`（解压路径不比明文路径宽松）；
3. 用解压结果**替换** `payload`，后续 `sanitizePayload` → `JSON.stringify` → `$4::jsonb` 一行不改；
4. 于是一份压缩上传的快照 `pull` 回来就是普通 JSON：**旧客户端读到的与改动前完全一致**；
5. `__gz` 是空串 / 数字 / `null` / 对象时按**普通数据**处理（用户数据里恰好有这个名字的字段不会被误判），
   明文 `push`（没有 `__gz`）行为零回归。

### 16.3 gzip 炸弹：`maxOutputLength` 是唯一的内存防线

100KB 的请求体可以解出几十 GB —— 实测一份 **64MiB 全零**快照 gzip 后 base64 只有 87000 字节，
**在网关 102400 的上限之内**，也就是说这种请求真的能打进来。没有上限就是一次把函数内存打爆的 DoS。

因此 `gunzipSync` **必须**带 `maxOutputLength`，取值与服务端快照上限同值（`MAX_PAYLOAD_BYTES`，8MiB）：
超限时 Node 抛 `ERR_BUFFER_TOO_LARGE`，**不会先把几十 GB 解出来**。所有失败分支一律 400 `bad-request`
（500 会让客户端无限重试，绝不能用），文案都是可读中文：

| 情况 | 响应 |
| --- | --- |
| base64 非法（含非法字符、非规范尾比特如 `AB==`） | `400 bad-request`「payload.__gz 不是合法的 base64」 |
| base64 合法但不是 gzip（含被截断的 gzip） | `400 bad-request`「payload.__gz 不是合法的 gzip 数据」 |
| 解出来不是合法 JSON | `400 bad-request`「payload.__gz 解压后不是合法 JSON」 |
| 解出来不是对象（数组 / 数字 / `null` / 字符串） | `400 bad-request`「payload.__gz 解压后必须是 JSON 对象」 |
| 解压后超过 8MiB（gzip 炸弹） | `400 bad-request`「payload.__gz 解压后过大」+ 日志 `"tooLarge":true`、`"limit":8388608` |

日志只记**元信息**：`{"route":"push","status":200,...,"compressed":true,"decompressedBytes":<解压后字节数>}`；
base64 原文、解压结果、被净化的内容统统不进日志（payload 是用户数据）。相关断言见
`tests/cloud.test.mjs` 第 14 节（含真实炸弹、CORS 不掉头、与 `sanitizePayload` 的两步协同）。

