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

// v1.4 起：体重趋势均线
export function movingAverage(series, size = 7): Array<{ date, value, avg }>
//  入参 series: [{ date, value }]（按 date 升序）；输出同长度同顺序、不修改入参
//  avg = 最近 size 个点（含当前点）中**有效值**的算术平均，保留 1 位
//  有效点 < 2 时 avg = null；size = 1 因此恒为 null（避免单点画出假趋势）
//  value 非有限数的点 avg = null 且不进入任何窗口统计；size 非有限数回退 7，size ≤ 0 按 1 处理

// v1.8 起：运动种类表与净消耗估算、BMI 边界反算
export const EXERCISE_TYPES = [{ value, label, group, met, intensities?: [{ value, label, met }] }, ...]
//  24 种 / 5 组；legacy 值 walk·jog·bike·swim·strength·other 必须继续有效（历史记录里存的就是这些）
export function exerciseMet(type, intensity): number     // 未知 type → 'other' 的 met；未知 intensity → 该类型默认 met
export function estimateBurn({ type, minutes, weightKg, intensity }): number
//  净消耗：max(0, round((MET − 1) × weightKg × minutes/60))；minutes/weightKg 非正或非有限数 → 0
export function weightForBmi(bmiValue, heightCm): number|null   // 保留 1 位；非法输入 → null
export function bmiGaps(bmiValue, heightCm): { lower: { label, kg } | null, upper: { label, kg } | null }
//  lower = 距离更低一档边界还差多少 kg，upper = 距离更高一档边界还差多少 kg；label 是**跨过边界会进入的那一档**
//  例：bmiGaps(23.3, 175) → { lower: { label:'偏瘦', kg:14.7 }, upper: { label:'超重', kg:2.1 } }
//  非法输入 → { lower: null, upper: null }
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

// v1.4 起：常吃套餐 / 最近吃过 / 备份时间戳
//  套餐与备份时间戳均存 meta（键 mealTemplates / lastExportedAt），不新增 object store、不做 IDB 版本迁移
//  Template 归一化形状（v1.7）：
//    { id, name, kind: 'meal'|'day', slot?, items?, meals?: [{ slot, items }] }
//    kind='meal' 走 slot+items；kind='day' 走 meals（≥2 餐，用于「整日一键」）
export async function getMealTemplates(): Promise<Template[]>       // 脏数据过滤，绝不抛；老数据（无 kind）归一为 kind='meal'
export async function saveMealTemplate({ name, slot, items }): Promise<Template>  // 同名覆盖并保留 id；空名抛「套餐名称不能为空」
export async function saveDayTemplate({ name, meals }): Promise<Template>         // 整日套餐：meals 归一化后少于 2 餐抛「整日套餐至少要两餐」
export async function deleteMealTemplate(id): Promise<void>                       // 通吃两种
export async function recentFoodItems(limit = 12): Promise<Array<{ name, lastDate, slot, item }>>
//  只取最近 200 条 meals；按 item.name（trim 后）去重，保留最后一次出现的信息；limit 在去重后生效
export async function markExported(): Promise<void>
export async function exportStatus(): Promise<{ lastExportedAt: number|null, days: number|null, hasData: boolean }>
//  days 用 localDateStr 算整天差（未来时间夹到 0）；hasData = weights 或 meals 至少一条
//  exportJSON() 成功返回前会自动 markExported()
```

### 5.4 `js/foods.js` —— 内置食物营养库 + 名称校准

```js
export const FOODS: Food[]
//  Food = { id, name, kind?: 'ingredient'|'dish', aliases?: string[],
//           part?: '胸'|'腿'|'翅'|'里脊'|'腩'|'五花'…,   // 部位
//           skin?: 'on'|'off',                          // 带皮 / 去皮
//           state?: 'raw'|'cooked',                     // 生 / 熟
//           per100g: { kcal, carb, protein, fat, fiber?, sodium? },
//           units?: Array<{ name: string, grams: number, note?: string }>,  // 常用份量，第一条为主单位
//           unit?: { name: string, grams: number } }    // 兼容旧结构，必须等于 units[0]
export function foodUnits(food): Array<{ name, grams }>
//  units 优先 → 只有 unit 返回 [unit] → 都没有返回 []；过滤空名/非有限/≤0 的项；返回副本
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
/* v1.5 视觉层（2026-10-21）：更"健康"但不花哨——薄荷底 + 单一品牌绿 + 三色宏量 */
--bg:#F2F7F4; --bg-top:#E4F4EC; --surface:#FFFFFF; --surface-2:#EAF2EE;
--text:#14201C; --text-2:#6A7A74; --line:#DFE9E4;
--brand:#10A37F; --brand-2:#0A8065; --brand-3:#2FC08E; --brand-soft:#E4F5EF; --leaf:#5FBF7E;
--card-line:rgba(16,163,127,.10); --ring-track:#E8F1ED;
--warn:#E0A106; --warn-soft:rgba(224,161,6,.14); --warn-line:rgba(224,161,6,.38); --warn-ink:#8A6A12;
--danger:#D9534F; --danger-line:rgba(217,83,79,.26);
--carb:#F2A33C; --protein:#3C8DF2; --fat:#B07CF0; --water:#38B6E0;
--radius:20px; --radius-sm:14px; --shadow:0 6px 20px rgba(13,52,42,.07);
```

- 页面底色 = 顶部一层极淡薄荷径向渐变 + `--bg`；卡片为白底 + `--card-line` 细描边 + 柔阴影。
- `.card__title` 用 `::before` 画一条品牌色竖条（3×13px 渐变），这是"健康色"的主要来源，不新增 DOM。
- 主按钮为 `linear-gradient(135deg, --brand-3, --brand-2)`；底部导航活动项为 `--brand-soft` 圆角药丸。
- 色值只允许出现在 `:root`，组件与视图一律引用变量（`tests/...` 与 grep 均可核对）。

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

**运动**：类型选择（**24 种、按「有氧 / 户外 / 力量 / 球类 / 其他」分组**，其中 12 种带强度档：骑行五档、
跑步三档、徒步三档、力量三档、跳绳/游泳/划船机/HIIT/舞蹈/羽毛球/爬楼梯各三档）+ 分钟 + 自动估算消耗 → 保存；当日列表与合计。

估算口径为**净消耗**（v1.8 起）：
```
kcal = max(0, round((MET − 1) × 体重kg × 分钟/60))
```
减掉 1 MET 是因为旧口径的 `MET × 体重 × 时长` 是**总消耗**，含躺着也会烧的基础代谢；减脂记账要的是"因为运动
额外多烧的"。整表因此平均下调约 19%，低 MET 动作下调更多（休闲骑行 −56%，力量训练 −20%）。
提示文案要写清口径与档位，例如：`估算 186 kcal（骑行 · 公路车 20-25km/h · 30 分钟 · 净消耗）`。**手动改消耗的入口保留。**

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
- **名称要写到能区分的颗粒度**：能判断「部位」（胸/腿/翅/里脊/腩/五花）、「是否去皮」、「生熟」时，必须写进食物名，
  例如「鸡腿（去皮，熟）」「鸡胸肉（生）」「三文鱼（熟）」，不要只写笼统的「鸡腿」「鸡肉」「鱼」。判断不出就不要编。
- **健身人群最在意三组差异**，优先判断并写进名字：瘦/肥（里脊 vs 五花）、去皮/带皮（鸡腿带皮约 181 kcal/100g，去皮约 120）、
  水煮清蒸 vs 油炸红烧（同一种食材热量可差一倍）。
- 每项都要给份量单位 `unit`（如 "1 只（去皮，去骨）"、"1 碗"、"1 片"、"1 个"）与该单位对应的 `grams`，而不是只给总克数。
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

### v1.4 · 2026-10-21 · 四项高频功能的数据契约
- **新增**：`nutrition.movingAverage`；`store` 的 `getMealTemplates`/`saveMealTemplate`/`deleteMealTemplate`/
  `recentFoodItems`/`markExported`/`exportStatus`。
- **存储策略**：套餐与备份时间戳都写在 `meta` 表（`mealTemplates` / `lastExportedAt`），
  **不新增 object store、不做 IndexedDB 版本迁移**——升级失败的风险大于这点设计洁癖。
- **注意**：`movingAverage` 的第二形参命名为 `size` 而非 `window`（旧测试里有「纯模块源码不得出现 window」
  的守卫，参数名会被误判）；**位置参数语义不变**。

### v1.5 · 2026-10-21 · 视觉刷新（不改结构，只改令牌与组件样式）
- **范围**：`styles.css` 设计令牌与组件样式；`js/ui.js` 的 `ring()` 在 0 值时不画圆头（原本会留下一个孤立圆点）；
  `views/weight.js` 的「变化」文案按真实数据呈现（不再出现「—」占位）、刻度标签密度改为每 1kg/2斤；
  `views/food.js` 修一处 `kcal·` 空格。
- **未改动**：任何 DOM 结构、类名、交互逻辑；所有既有测试断言原样通过。
- **配色原则**：单一品牌绿 + 薄荷底，宏量三色（碳水橙/蛋白蓝/脂肪紫）作为唯一的多彩色块，其余保持中性。

### v1.6 · 2026-10-21 · 食物粒度与份量单位
- **背景**：用户（健身减脂）反馈「需要知道**去皮鸡腿**的营养，而不只是鸡腿」「份量只有碗和克，不够明确」。
- **数据**：`Food` 新增 `part / skin / state / units` 四个字段，`unit` 归一为 `units[0]`；库容量 526 → **651**
  （dish 416 / ingredient 235），**578 条**带常用份量；新增 125 条高粒度条目（鸡胸/鸡腿/鸡翅的生熟与去皮、五花、牛腱、
  三文鱼、虾仁、蛋白蛋黄、希腊酸奶、燕麦干熟、意面干熟、蛋白粉、减脂餐…）。
- **关键差值**（必须成立，闸门会校验）：鸡腿带皮 181 / 去皮 120 kcal·100g⁻¹；鸡胸生 118 / 熟 165；
  三文鱼生 139 / 熟 206；虾仁生 48 / 熟 99。熟高于生是水分流失的必然结果。
- **别名**：`findFood('去皮鸡腿'|'鸡腿去皮'|'无皮鸡腿'|'鸡腿肉去皮')` 全部命中 `chicken-leg-skin-off-raw`。
- **提示词**：见 §8.2 新增的四条（颗粒度、健身三组差异、unit+grams）。
- **界面**：详情层给单位 chip（名称 + 克数，点击即填克数），搜索行显示主单位，已保存条目在 ±15% 内显示「≈1 碗」参照。
- **未验证**：本轮不发布 APK，手机端仍是旧库；详情层 chip 的像素观感需真机确认（自动化为 DOM 断言）。

### v1.7 · 2026-10-21 · 整日套餐与三处交互收敛
- **数据**：`Template` 增加 `kind: 'meal' | 'day'`；`kind='day'` 用 `meals: [{ slot, items }]`（≥2 餐）。
  新增 `saveDayTemplate({ name, meals })`；`getMealTemplates()` 把老数据（只有 slot/items）归一为 `kind='meal'`，
  用户不需要重存。`deleteMealTemplate` 通吃两种。
- **交互**（用户反馈）：
  1. 手动添加弹层：**搜索框移到最上**，「最近吃过」默认折叠成一行 `最近吃过 (8)`，点开才展开；
  2. 今日页「今日餐次」默认**折叠成一行**（`今日餐次 · N 餐 X kcal`），点开才展开逐餐；
  3. 饮食页「常吃套餐」同时展示单餐与整日两类：整日 chip 点一下把每一餐都记入当天；
     新增「把今天存为整日套餐」（按当天已有餐次分组保存，不足 2 餐时给提示）。
- **未改动**：单餐套餐的既有行为、`recentFoodItems` 语义、食物库结构。

### v1.8 · 2026-10-21 · 运动净消耗口径 + BMI 可视化 + 整日套餐入口可达性
- **口径变更（破坏性，仅影响新记录）**：运动消耗由 `MET × 体重 × 时长`（总消耗）改为
  `(MET − 1) × 体重 × 时长`（**净消耗**）。历史记录里已存的 `kcalBurned` 不变。
- **运动种类**：6 → 24 种，分 5 组；骑行五档（休闲 4.0 / 通勤 6.0 / 公路车 8.0 / 动感单车 8.5 / 爬坡或高强度 10.0），
  跑步三档（6.0 / 9.0 / 11.0），徒步三档（5.0 / 6.3 / 8.0）。`exercises` 记录新增可选字段 `intensity`
  （trim 后 ≤16 字符，超长或非字符串丢弃）；**CSV 导出列保持不变**。
- **BMI**：新增 `weightForBmi` 与 `bmiGaps`；体重页把原来的药丸标签换成
  分段区间条（14–34，四档按中国标准 18.5/24/28）+ 当前位置指针 + 四档体态小人（当前档高亮 + 描线动画，
  遵守 `prefers-reduced-motion`）+ 距上下边界还差多少 kg。
- **饮食**：修掉「整日套餐入口对全新用户不可达」——当天已有 ≥2 餐但零套餐时，卡片仍渲染（标题「整日套餐」），
  只显示「把今天存为整日套餐」；零套餐且当天 <2 餐时整块不渲染（维持原行为）。
- **文案修正**：整日套餐的错误串由「至少要有一餐」改为「**至少要两餐**」（规则本就是归一化后 ≥2 餐）。
