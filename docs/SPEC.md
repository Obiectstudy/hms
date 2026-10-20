# HMS（家庭健康管理）设计契约 v1

> 本文件是并行开发的**冻结契约**。任何实现都必须与本文档的签名、字段名、类名一致；
> 若发现契约本身不可实现，先报给调度者，不要私自改契约。

## 1. 目标与范围

单人（先只做自己）健康管理系统，安卓手机上以 PWA 形式安装使用，界面中文、公制单位。

v1 必须包含（已与用户确认）：

1. 体重记录 + 趋势图（含目标体重进度）
2. 饮食记录：拍照 → 视觉大模型识别 → 可编辑确认 → 存入餐次；也支持食物库手动添加
3. 卡路里与宏量营养素（碳水/蛋白质/脂肪）分析，按日汇总
4. 每日营养目标与进度（基础代谢/每日消耗估算，可手动覆盖）
5. 运动记录（消耗热量）
6. 饮水记录
7. 数据导入导出（JSON 全量 + CSV 明细）

v1 明确**不做**：账号登录、多成员档案、云同步、社交/分享、原生 APK 编译、步数传感器自动读取、图片云存储。

## 2. 技术底座与硬约束

- 纯静态：零构建、零 npm 依赖、原生 ES Module（`<script type="module">`）。
- 部署到 GitHub Pages（项目页，URL 形如 `https://<user>.github.io/<repo>/`）：
  **所有资源引用一律用相对路径**（`./js/db.js`、`./sw.js`），禁止以 `/` 开头的绝对路径。
- 数据全部落在浏览器 IndexedDB，不上传任何服务器（除用户主动调用的视觉识别 API）。
- 视觉识别：阿里百炼 DashScope OpenAI 兼容模式
  `https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions`，模型默认 `qwen3-vl-plus`（2026-10-20 依据真实账号可用模型清单修正，见 §13 变更记录）。
  实测该端点返回 `access-control-allow-origin: *`，浏览器可直连；Key 存 IndexedDB 元数据，仅本机。
- **开发环境限制**：本机 pwsh 与任何子进程均不可用（0xC0000142），无 JDK/Android SDK。
  因此：不能 `npm install`、不能起 dev server、不能跑浏览器自动化。
  可执行验证只有一种：在 `run_code` 里用 `await import('file:///...')` 加载纯逻辑模块跑断言。
  IndexedDB / DOM / Service Worker 相关代码无法自动验证，靠代码审查 + 应用内 `#/debug` 自检页人工确认。

## 3. 文件所有权（并行开发边界，禁止跨边界写文件）

| 归属 | 文件 |
| --- | --- |
| worker `logic-core` | `js/db.js`、`js/store.js`、`js/nutrition.js`、`tests/logic.test.mjs` |
| worker `vision-ai` | `js/vision.js`、`js/foods.js`、`tests/vision.test.mjs` |
| worker `ui-shell` | `index.html`、`styles.css`、`app.js`、`js/ui.js`、`views/*.js`、`manifest.webmanifest`、`sw.js` |
| 调度者 | `docs/*`、`icons/*`、`tests/all.mjs`、最终集成修修补补 |

跨边界只允许**按本契约导入**，不得修改对方文件。

## 4. 数据模型（IndexedDB）

数据库名 `hms`，版本 `1`。

| store | keyPath | 索引 | 记录形状 |
| --- | --- | --- | --- |
| `meta` | `key` | — | `{ key, value }`（`profile` / `goals` / `settings` / `schemaVersion`） |
| `weights` | `id`（autoIncrement） | `by_date`(unique) on `date` | `{ id, date, weightKg, bodyFatPct?, note?, createdAt }` |
| `meals` | `id`（autoIncrement） | `by_date` on `date` | `{ id, date, slot, items, photoId?, source, rawAiText?, createdAt }` |
| `exercises` | `id`（autoIncrement） | `by_date` on `date` | `{ id, date, type, minutes, kcalBurned, note?, createdAt }` |
| `waters` | `id`（autoIncrement） | `by_date`(unique) on `date` | `{ id, date, ml }` |
| `photos` | `id` | — | `{ id, blob, mime, createdAt }` |

- `date` 一律为本地日期字符串 `YYYY-MM-DD`（用 `localDateStr(d = new Date())` 生成，**不可用 toISOString**，会串时区）。
- `slot` ∈ `'breakfast' | 'lunch' | 'dinner' | 'snack'`。
- `source` ∈ `'manual' | 'ai'`。
- `items` 是 `MealItem[]`：
  ```js
  { name: string, grams: number, kcal: number, carb: number, protein: number, fat: number,
    fiber?: number, sodium?: number, confidence?: 'high'|'medium'|'low', foodId?: string }
  ```
  数值均为该条实际摄入量（不是每 100g），`kcal` 取整，其余保留 1 位小数。
- `createdAt` 为毫秒时间戳。
- `weights` 与 `waters` 按 `date` 唯一：同日写入即覆盖（upsert）。

## 5. 模块 API 契约

### 5.1 `js/nutrition.js` —— 纯函数，禁止 DOM / db / fetch

```js
export function localDateStr(d = new Date()): string           // 'YYYY-MM-DD' 本地时区
export function parseDateStr(s): Date                          // 'YYYY-MM-DD' -> 本地 00:00
export function daysAgo(n): string                             // 今天往前第 n 天的 date 字符串
export function bmrMifflinStJeor({ sex, weightKg, heightCm, age }): number  // 取整
export function tdee(bmr, activity): number                    // activity: 'sedentary'|'light'|'moderate'|'active'|'very_active'
export function ageFromBirthday(birthday): number              // 'YYYY-MM-DD' -> 周岁
export function targetMacros(calorieTarget, ratio): {carbProtein?:...}
//  ratio = { carb, protein, fat } 比例和≈1；返回克数 { carb, protein, fat }，各保留 1 位
export function kcalFromMacros({ carb, protein, fat }): number  // 4/4/9 取整
export function scaleFood(per100g, grams): { kcal, carb, protein, fat, fiber, sodium }
export function sumItems(items): { kcal, carb, protein, fat, fiber, sodium }   // 缺字段按 0
export function netKcal(intakeKcal, burnedKcal): number
export function bmi({ weightKg, heightCm }): number            // 1 位小数
export function bmiClass(bmiValue): { label: string, level: 'low'|'normal'|'over'|'obese' }
export function weightStats(weights): { latest, latestDate, delta7, delta30, series }
//   series: [{ date, weightKg }] 按日期升序；delta7/delta30 为与"该日期前 N 天最近一条"之差，无则 null
export function groupByDate(records): Map<string, records[]>
export function round1(n): number

// v1.3 起：体重单位换算（存储永远是 kg，只有显示与输入换算；'jin' = 斤 = 0.5kg）
export const WEIGHT_UNITS = ['kg', 'jin']
export function weightUnitLabel(unit): string        // 'kg' | '斤'，未知单位回退 'kg'
export function kgToUnit(kg, unit): number           // jin: kg*2，保留 1 位
export function unitToKg(value, unit): number        // jin: value/2，保留 2 位
export function weightStep(unit): number             // kg: 0.1 | jin: 0.2
export function weightRange(unit): { min, max }      // kg: 20–300 | jin: 40–600
```

### 5.2 `js/db.js` —— 只做存储，不含业务规则

```js
export async function openDb(): Promise<IDBDatabase>   // 幂等，单例
export async function getAll(store): Promise<any[]>
export async function get(store, key): Promise<any>
export async function put(store, obj): Promise<Key>
export async function del(store, key): Promise<void>
export async function getOneByIndex(store, index, value): Promise<any|null>
export async function getAllByIndex(store, index, value): Promise<any[]>
export async function deleteAll(store): Promise<void>
export async function getMeta(key, fallback = null): Promise<any>
export async function setMeta(key, value): Promise<void>
export async function dumpAll(): Promise<{ schemaVersion, exportedAt, meta, weights, meals, exercises, waters }>
//  dumpAll 不含 photos 的二进制，只给 photoCount 计数
export async function loadAll(payload, mode = 'merge'): Promise<{ weights, meals, exercises, waters }>
//  mode 'replace' 先清空各业务 store；'merge' 按 id/date 去重后写入；返回写入条数
export async function clearBusinessData(): Promise<void>   // 清空 5 个业务 store，保留 meta
```

### 5.3 `js/store.js` —— 业务编排，视图层唯一入口

```js
export async function getProfile(): Promise<Profile|null>
export async function saveProfile(p): Promise<void>
//  Profile = { nickname, sex:'male'|'female', birthday:'YYYY-MM-DD', heightCm, activity, weightTargetKg? }
export async function getGoals(): Promise<Goals>
export async function saveGoals(g): Promise<void>
//  Goals = { calorieTarget, carbPct, proteinPct, fatPct, waterMl, weightTargetKg }
//  未保存过时 getGoals 依据 profile 自动估算并返回（不落库）
export async function computeDefaultGoals(profile): Promise<Goals>
export async function getSettings(): Promise<{ apiKey, model, baseUrl }>
export async function saveSettings(s): Promise<void>
export async function logWeight({ date, weightKg, bodyFatPct, note }): Promise<void>   // 按 date upsert
export async function deleteWeight(date): Promise<void>
export async function logMeal({ date, slot, items, photoId, source, rawAiText }): Promise<number>
export async function updateMeal(id, patch): Promise<void>
export async function deleteMeal(id): Promise<void>
export async function logExercise({ date, type, minutes, kcalBurned, note }): Promise<number>
export async function deleteExercise(id): Promise<void>
export async function getWater(date): Promise<number>
export async function setWater(date, ml): Promise<void>       // 归零则删除该日记录
export async function addWater(date, deltaMl): Promise<number>
export async function savePhoto(blob, mime): Promise<string>
export async function getPhoto(id): Promise<Blob|null>
export async function daySummary(date): Promise<{
  date, intake:{kcal,carb,protein,fat,fiber,sodium}, burned, water, netKcal,
  meals: Meal[], exercises: Exercise[], weight: Weight|null
}>
export async function rangeSummary(fromDate, toDate): Promise<Array<{date, kcal, carb, protein, fat, burned, water, weightKg}>>
export async function recentWeights(days = 30): Promise<Weight[]>
export async function exportJSON(): Promise<object>
export async function importJSON(obj, mode): Promise<{weights,meals,exercises,waters}>
export async function exportCSV(): Promise<string>     // 体重+饮食+运动+饮水四段，带表头
export async function clearAllData(): Promise<void>    // 业务数据 + photos，保留 profile/goals/settings
```

### 5.4 `js/foods.js` —— 内置食物营养库 + 名称校准

```js
export const FOODS: Food[]
//  Food = { id, name, kind?: 'ingredient'|'dish', aliases?: string[], per100g: { kcal, carb, protein, fat, fiber?, sodium? },
//           unit?: { name: string, grams: number } }
export function searchFoods(query, limit = 20): Food[]   // 空 query 返回热门前 limit 条；菜品（kind==='dish'）排在原料之前
export function findFood(name): Food|null                // 精确 → 去修饰词 → 别名 → 包含匹配，取最相似
export function calibrateItems(items): MealItem[]         // 见 8.3
```

食物库要求：**总量 ≥ 450 条，其中 `kind: 'dish'` 的成品菜 ≥ 250 条**（v1.2 起，实际 513 / 351）。覆盖主食、肉禽、水产、蛋奶、豆制品、蔬菜、水果、坚果、油、饮料，以及家常炒菜、炖烧焖、汤羹、蛋类菜、豆制品菜、凉菜、硬菜、米面盖饭、早餐、外卖快餐、卤味烧烤。
成品菜的营养值口径为**含油烹饪后的成品**（家常炒菜每 100g 约含 5–10g 油），不是生料相加；必须带 `unit`（如 `1 盘 = 250g`）。数据取常见公开值，误差不追求实验室级。
自洽性由 `tests/foods.data.test.mjs` 强制：`kcal` 与 `4/4/9` 偏差 ≤ ±30%（或 ±30 kcal）、宏量合计 ≤ 100g/100g、份量克数 5–1000g、id/name 唯一。

### 5.5 `js/vision.js` —— 拍照识别

```js
export const DEFAULT_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1'
export const DEFAULT_MODEL = 'qwen3-vl-plus'
export const MODEL_CANDIDATES = ['qwen3-vl-plus', 'qwen-vl-max', 'qwen-vl-plus', 'qwen2.5-vl-72b-instruct']
export async function fileToDataUrl(file, { maxEdge = 1024, quality = 0.8 }): Promise<{ dataUrl, mime }>
//  用 canvas 缩放压缩，输出 JPEG dataURL；HEIC 等失败时抛出可读中文错误
export function buildPrompt(): string
export function buildRequestBody({ dataUrl, model, baseUrl }): object
//  OpenAI 兼容 messages：system + user[ image_url, text ]；image_url.url = dataURL；
//  response_format 若使用必须兼容性可降级，默认不传
export async function analyzeFoodPhoto(input, { apiKey, model, baseUrl, fetchImpl }):
  Promise<{ items: MealItem[], raw: string, model: string, usage?: any }>
//  input: File | Blob | { dataUrl, mime }
//  fetchImpl 默认 globalThis.fetch，测试注入用
//  非 2xx 时抛出 Error，message 含中文提示 + HTTP 状态 + 服务端返回的错误码/信息片段
export function parseModelJson(text): { items: MealItem[], note?: string }
//  容忍 ```json 围栏、前后废话、单对象、{items:[]}、数组；把 carb/protein/fat 缺失项用 4/4/9 从 kcal 反推
export async function testConnection({ apiKey, model, baseUrl, fetchImpl }): Promise<{ ok, message, model }>
//  用极小图片或纯文本请求验证 Key 与模型可用；401/403/404 分别给出可操作中文提示
```

### 5.6 `js/ui.js` —— 视图共用原语（ui-shell 自己拥有）

```js
export function el(tag, props, ...children): HTMLElement   // props: className/text/on* /dataset/attr
export function clear(node)
export function toast(msg, type = 'info')                  // 'info'|'ok'|'error'
export function confirmDialog({ title, message, okText, cancelText }): Promise<boolean>
export function openSheet({ title, content, actions }): Promise<any>  // 底部弹层，返回 Promise
export function fmtKcal(n), fmtKg(n), fmtDateCN(dateStr), fmtTime(ts), fmt1(n)
export function ring({ value, max, label, unit, color }): HTMLElement   // SVG 环形进度
export function bar({ value, max, color }): HTMLElement
export function lineChart({ points, height, yLabel }): HTMLElement      // SVG 折线，points: [{x:'YYYY-MM-DD', y:number}]
export function emptyState(text, actionText, onAction): HTMLElement
export function field({ label, type, value, placeholder, onInput }): HTMLElement
```

### 5.7 `views/*.js`

每个视图模块只导出一个渲染函数：

```js
export async function render(root /* HTMLElement */): Promise<void>
```

文件与路由：

| 文件 | 路由 | 内容 |
| --- | --- | --- |
| `views/dashboard.js` | `#/` | 今日总览 |
| `views/weight.js` | `#/weight` | 体重 |
| `views/food.js` | `#/food` | 饮食 + 拍照识别 |
| `views/exercise.js` | `#/exercise` | 运动 |
| `views/water.js` | `#/water` | 饮水 |
| `views/settings.js` | `#/settings` | 档案/目标/API/数据 |
| `views/debug.js` | `#/debug` | 自检页（见 10.2） |

`app.js` 契约：

```js
const ROUTES = { '': () => import('./views/dashboard.js'), 'weight': ..., ... }
export function navigate(hash)        // 改写 location.hash
export async function refresh()       // 重新渲染当前视图
window.HMS = { navigate, refresh }    // 视图之间跳转与刷新统一走它
```

## 6. 视觉规范（简洁健康风）

CSS 变量（`styles.css` 顶部定义，视图只用变量，禁止写死颜色）：

```css
--bg:#F6F8F7; --surface:#FFFFFF; --surface-2:#EEF3F1;
--text:#16211E; --text-2:#6B7A75; --line:#E3EAE7;
--brand:#0FA37F; --brand-2:#0B8A6B; --brand-soft:#E4F5EF;
--warn:#E0A106; --danger:#D9534F;
--carb:#F2A33C; --protein:#3C8DF2; --fat:#B07CF0; --water:#38B6E0;
--radius:18px; --radius-sm:12px; --shadow:0 2px 10px rgba(16,33,30,.06);
```

- 移动优先，最大内容宽度 `520px` 居中；安全区 `env(safe-area-inset-bottom)` 留给底部 tabbar。
- 数字是本产品的主角：关键数值 ≥ 28px，单位小字灰色紧跟其后。
- 类名白名单（视图只能用这些做布局，其余样式在 `styles.css` 里新增且必须用变量）：
  `.page` `.card` `.card__head` `.card__title` `.row` `.row--between` `.col` `.grid-2` `.grid-3`
  `.stat` `.stat__value` `.stat__unit` `.stat__label` `.pill` `.pill--ok` `.pill--warn`
  `.btn` `.btn--primary` `.btn--ghost` `.btn--danger` `.btn--block`
  `.input` `.select` `.field` `.field__label` `.label`
  `.tabbar` `.tab` `.tab--active` `.tabbar__inner`
  `.list` `.list__item` `.list__item--main` `.list__item--meta` `.divider` `.empty`
  `.muted` `.strong` `.center` `.h1` `.h2` `.h3` `.fade-in`
- 底部 tabbar 五项：今日 / 体重 / 饮食 / 运动 / 饮水；设置入口放今日页右上角齿轮。
- 交互三原则：任何写入即时反馈（toast）、删除需二次确认、空状态给出下一步按钮。

## 7. 界面与交互

**今日**：日期与星期；热量环（摄入 / 目标，中心显示净值 = 摄入 − 运动）；三条宏量进度（碳水/蛋白/脂肪，显示 g 与目标）；体重卡（最新值 + 较 7 天前）；饮水卡（进度 + `+250ml`）；运动卡（今日总消耗）；今日各餐列表（时间、餐次、条目摘要、kcal），空则引导去拍第一张。

**体重**：录入区（日期默认今天、体重必填、体脂可选、备注可选）→ 保存即 upsert；30 天折线图（无数据提示）；目标体重进度条与差值；历史列表（倒序，可删，二次确认）。

**饮食**：顶部日期切换（默认今天，可回看）；两个主按钮 `拍照识别` / `手动添加`；
拍照流程：选相机或相册 → 压缩 → loading（可取消）→ 识别结果以"可编辑清单"呈现（名称/克数可改、单项可删、整餐合计实时更新、显示识别来源 `AI` 与 `confidence`）→ 选餐次 → 保存；
手动流程：搜索食物（`searchFoods`）→ 选食物 → 输入克数或选 `unit` 快捷份量 → 加入清单 → 保存；
下方按餐次分组展示已记录条目，支持删除与修改份量；页尾显示当日四项合计。

**运动**：类型选择（走路/慢跑/骑行/游泳/力量训练/其他）+ 分钟 + 自动估算消耗（按类型 MET × 体重 × 时长，可手改）→ 保存；当日列表与合计。

**饮水**：大号进度（ml / 目标）；快捷 +200 / +250 / +500、自定义、撤销（减 250）；进度到 100% 时卡片态变化。

**设置**：个人档案；目标（默认按 BMR/TDEE 估算，可展开手动覆盖）；视觉识别（API Key 密码框、模型下拉、`测试连接` 按钮显示结果）；数据（导出 JSON、导出 CSV、导入 JSON（合并/覆盖二选一）、清空数据、查看自检页）；关于（版本、隐私说明：数据只在本机）。

## 8. AI 识别链路

### 8.1 请求

`POST {baseUrl}/chat/completions`，头 `Authorization: Bearer <apiKey>`、`Content-Type: application/json`。
body：

```json
{ "model": "qwen3-vl-plus", "messages": [
  { "role": "system", "content": "你是营养分析助手…只输出 JSON" },
  { "role": "user", "content": [
    { "type": "image_url", "image_url": { "url": "data:image/jpeg;base64,..." } },
    { "type": "text", "text": "<buildPrompt()>" } ] } ],
  "temperature": 0.1 }
```

### 8.2 提示词要求（`buildPrompt()`）

要求模型（v1.2 起）：
- **画面是一道做好的菜 → 返回这道菜的菜名，一项**；只有画面明显是分开的多种食物（如一碗饭 + 一盘菜 + 一碗汤）才拆成多项。明确禁止把一道炒菜拆成「鸡蛋」「菠菜」两个原料项。
- 每项输出 `{ name, grams, kcal, carb, protein, fat, fiber?, sodium?, confidence, kind, unit? }`，其中 `kind ∈ 'dish'|'ingredient'`、`unit` 为份量提示（如 `"1 盘"`）。
- 成品菜按整份估算克数；无法确定时给合理估计并把 `confidence` 设为 `low`。
- 提示词内置 **56 个高频标准菜名**（`STANDARD_DISHES`，全部取自库内），引导模型使用与本库一致的叫法，提高校准命中率。
- 只输出 `{"items":[…]}`，不要解释文字。

### 8.3 结果校准（`calibrateItems`）

1. 名称按 `findFood` 匹配；命中则用库值 × `grams/100` 覆盖四项数值，并记 `foodId`。
2. 未命中但有 `kcal` 而缺宏量 → 用 4/4/9 按 `carb:protein:fat = 0.5:0.2:0.3` 反推。
3. `grams <= 0` 或 `> 2000` 视为异常，夹到 `50`/`500` 并降 `confidence` 为 `low`。
4. 结果为空数组时抛错，提示"没识别出食物，换个角度重拍或手动添加"。
5. （v1.2）命中 `kind === 'dish'` 的成品菜**优先于**原料命中；模型给出的 `kind` 参与匹配期望（`findFood(name, { kind })`：精确名称/别名命中始终最高，相同时按 kind 加权，避免「土豆丝」被带偏到原料「土豆」）。
6. （v1.2）成品菜数值按**含油成品**口径（家常炒菜每 100g 约 5–10g 油），因此 `菠菜炒鸡蛋 300g ≈ 318 kcal`，而不是「鸡蛋 + 菠菜」生料相加的约 258 kcal。

## 9. 错误处理

- 无 API Key 时点拍照：不进入请求，直接提示去设置页填写，并提供跳转按钮。
- 网络失败 / 5xx / 超时（25s）：toast 中文原因 + 保留照片 + 提供"重试"。
- 401 / 403：提示 Key 无效或未开通模型权限，跳设置页。404 或模型不存在：提示切换模型并列出候选。
- JSON 解析失败：展示模型原文（可折叠）并允许手动录入该餐。
- IndexedDB 不可用（隐私模式）：首屏顶部常驻红条提示数据无法保存。
- 所有 `async` 视图入口包 `try/catch`，失败渲染错误卡片而不是白屏。

## 10. 验收标准

### 10.1 可在本机自动验证（Node + run_code）

- `tests/logic.test.mjs`：`nutrition.js` 全部函数（含边界：无体重数据、单日多条、跨月 delta、4/4/9 一致性）。
- `tests/vision.test.mjs`：`parseModelJson` 的 5 种输入（围栏/裸 JSON/数组/带废话/空）、`buildRequestBody` 结构、`calibrateItems` 三条规则，且全部用假 `fetchImpl` 覆盖 200/401/500/超时分支。
- `tests/all.mjs` 汇总，调度者执行并要求 **全部通过**。

### 10.2 只能在浏览器人工确认（`#/debug` 自检页）

自检页逐项执行并显示 PASS/FAIL 与耗时：IndexedDB 打开、五个 store 读写删、`daySummary` 聚合、导出→清空→导入往返一致、Service Worker 注册状态、`localDateStr` 与系统日期一致。

### 10.3 交付形态验收

- GitHub Pages 上可打开，手机 Chrome 出现"添加到主屏幕"，图标与名称正确，断网可打开（SW 生效）。
- 完成一次端到端：录入体重 → 拍一餐并保存 → 今日页数值随之变化 → 导出 JSON。

## 11. 部署（用户执行，调度者写步骤）

仓库根即站点根；`main` 分支 → Settings → Pages → Deploy from a branch → `main` / `(root)`。
`.nojekyll` 必须存在。首次部署后 URL 为 `https://<user>.github.io/<repo>/`。
详细逐字步骤见 `docs/DEPLOY.md`。

## 12. 版本

`docs/SPEC.md` v1.3（2026-10-20）。契约变更须记录在 §13。

## 13. 变更记录

### v1.1 · 2026-10-20 · 默认视觉模型修正
- **改动**：`DEFAULT_MODEL` 由 `qwen-vl-max` 改为 `qwen3-vl-plus`；`MODEL_CANDIDATES` 增补并重排为
  `['qwen3-vl-plus', 'qwen-vl-max', 'qwen-vl-plus', 'qwen2.5-vl-72b-instruct']`；`store.js` 的
  `DEFAULT_SETTINGS.model` 同步为 `qwen3-vl-plus`。
- **依据**：用真实账号 Key 实测——错误 Key 返回 `401 invalid_api_key`，本账号 Key 对 `qwen-vl-max`
  返回 `404 model_not_found`；`GET /compatible-mode/v1/models` 显示该账号可用的视觉模型为
  `qwen3-vl-plus`、`qwen-vl-ocr`、`qwen-vl-ocr-2025-11-20`、`qwen3.5-ocr` 等。
  OCR 类模型不适合食物识别，故不进候选。
- **影响**：识别链路已用 `qwen3-vl-plus` 实跑成功（2.2s，单张合成图返回可被食物库校准的条目）。
  契约中其余签名、字段、类名均未变动。
- **未改动**：§4 数据模型、§5 各模块契约、§6 视觉规范、§9 错误处理均保持原样。

### v1.2 · 2026-10-20 · 复合菜食物库 + 识别返回菜名
- **改动**：`Food` 新增 `kind: 'ingredient' | 'dish'`；食物库由 159 条扩到 **513 条**（`dish` 351 / `ingredient` 162）；
  `searchFoods` / `findFood` 支持菜品优先与别名（如「菠菜炒蛋」→ 菠菜炒鸡蛋）；`buildPrompt()` 要求
  **成品菜返回菜名一项、不拆成原料**，并内置 50–60 个高频标准菜名作引导。
- **依据**：用户实测反馈「菠菜炒鸡蛋识别成了鸡蛋+菠菜」，且旧库无复合菜；另按原料相加会漏掉烹饪用油，热量显著偏低。
- **新增闸门**：`tests/foods.data.test.mjs`（条数下限、字段自洽、别名指向、菜品优先排序、整份校准走库值）。

### v1.3 · 2026-10-20 · 体重单位与刻度尺
- **改动**：`nutrition.js` 新增`WEIGHT_UNITS`/`weightUnitLabel`/`kgToUnit`/`unitToKg`/`weightStep`/`weightRange`；
  `store` 的 `DEFAULT_SETTINGS` 增加 `weightUnit: 'kg'`；体重录入改为左右滑动刻度尺（`ui.rulerPicker`），
  支持 kg/斤 切换与切回键盘输入。
- **约束**：`weights.weightKg`、`daySummary().weight`、CSV/JSON 导出**一律仍为 kg**，单位只在显示与输入层换算。
