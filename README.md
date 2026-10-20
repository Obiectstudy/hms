# HMS · 家庭健康管理

自己用的健康管理 PWA：记录体重、拍照记饮食、看卡路里与碳水/蛋白质/脂肪，管运动与饮水。
纯静态、零依赖、零构建，安卓手机上"添加到主屏幕"即为 App，数据只存在本机浏览器里。

## 功能

- **体重**：每日录入（体脂可选）、30 天折线、目标进度与差值、历史可删
- **饮食**：拍照 → 视觉大模型识别菜品与份量 → 逐项改克数/删除 → 存进早/午/晚/加餐；也可从内置食物库手动添加
- **营养分析**：每餐与每日的卡路里、碳水、蛋白质、脂肪（含纤维、钠）；命中内置食物库时用库值折算，比模型估算更稳
- **目标**：按 Mifflin-St Jeor 估基础代谢 → 按活动量给每日热量 → 按比例拆三大宏量；可手动覆盖
- **运动**：类型 + 分钟 → 估算消耗（可改），计入当日净值
- **饮水**：快捷加量、进度、撤销
- **数据**：导出 JSON（全量备份）/ CSV（明细），导入支持合并或覆盖

## 目录

```
index.html              入口（ES Module，必须经 HTTP 打开，file:// 会被 CORS 拦）
app.js                  哈希路由 + 底部导航
styles.css              设计令牌与组件样式
js/nutrition.js         纯计算：BMR/TDEE/BMI/聚合/趋势（无 DOM，可在 Node 里跑）
js/db.js                IndexedDB 薄封装（六个 store）
js/store.js             业务编排，视图层唯一入口
js/foods.js             内置食物营养库（≥100 条）+ 检索 + 结果校准
js/vision.js            阿里百炼 Qwen-VL 适配器（压缩、请求、容错解析、连接测试）
js/ui.js                共用 UI 原语（toast/弹层/环形/折线/表单）
views/                  今日·体重·饮食·运动·饮水·设置·自检 七个视图
sw.js                   离线缓存（改前端文件后记得加版本号）
manifest.webmanifest    PWA 清单
icons/                  真实 PNG 图标（192/512/maskable）
tests/                  Node 可跑的断言（nutrition/vision/合并逻辑）
docs/SPEC.md            冻结的设计契约（字段、签名、类名）
docs/DEPLOY.md          部署到 GitHub Pages 的逐字步骤
```

## 本地预览

不能双击 `index.html`（ES Module 在 `file://` 下会被 CORS 拦）。用任意静态服务器：

```powershell
cd C:\Users\Administrator\Desktop\hms
npx --yes serve -l 8080 .
# 或（有 Python 时）
python -m http.server 8080
```

然后浏览器打开 `http://localhost:8080`。手机同一 Wi-Fi 下访问 `http://<电脑IP>:8080` 也能用，但 `localhost` 之外的非 HTTPS 站点无法安装成 PWA 且相机可能受限——正式使用请走 GitHub Pages。

## 跑测试

```powershell
cd C:\Users\Administrator\Desktop\hms
node tests/all.mjs
```

覆盖四类：纯逻辑（营养计算/聚合/合并/CSV）、识别链路（请求体/容错解析/校准/全错误分支）、七个视图的真实渲染（假 DOM + 假 IndexedDB）、以及集成契约（文件齐备、导出符号、SW 预缓存清单、manifest）。

IndexedDB 真实行为与相机、安装、离线这些只能真机确认，清单见 `docs/VERIFY.md`；应用内 **设置 → 数据 → 运行自检**（`#/debug`）也能就地跑一遍存储链路。

## 配置视觉识别

1. 去阿里云百炼控制台创建 API Key（OpenAI 兼容模式）
2. App 里 设置 → 视觉识别 → 填 Key → 点「测试连接」
3. 模型默认 `qwen-vl-max`，不可用时在设置里换 `qwen-vl-plus` 等候选

Key 只存在你这台设备的 IndexedDB 里，不写进仓库。换设备/清缓存前先导出 JSON。

## 设计文档

字段名、模块签名、CSS 类名白名单都在 `docs/SPEC.md`，实现与它一致；改契约要先改那份文档。

## 已知限制

- 单人单设备，没有账号与云同步；跨设备靠导出/导入
- 识别精度取决于模型与照片角度，所以结果永远先进"可编辑清单"再入库
- 运动消耗是 MET 系数粗估，不是实测
- 营养值取自常见公开数据，非实验室级
