# 安卓 APK 版

同一套网页代码的两种打包方式，数据互不相通：

| | PWA（GitHub Pages） | APK（本项目） |
| --- | --- | --- |
| 打开方式 | 桌面图标（Chrome 承载） | 桌面图标（应用自己承载） |
| 依赖 | 需要手机上有 Chrome | 不依赖浏览器 |
| 离线 | 靠 Service Worker 缓存 | 网页文件本来就在安装包里 |
| 更新 | 打开即用新版 | 要重新装一次 APK |
| 数据位置 | Chrome 的站点存储 | APK 自己的 WebView 存储 |
| 更新方式 | 打开即最新 | 重装新 APK（versionCode 必须递增，可覆盖安装不丢数据） |

## 1. 产物

- 当前安装包：`C:\Users\Administrator\Desktop\hms-release\HMS-健康-1.2.0.apk`
- 大小：1,709,645 字节 · SHA-256：`cf0e72c0a5a42714ff7bda4119c25b7b3a2b53dbd3f5e64aa57e0cfd5abf8311`
- 包名 `com.obiectstudy.hms`，应用名 `HMS 健康`，版本 `1.2.0`（versionCode 3）

| 版本 | versionCode | 字节数 | 内容 |
| --- | --- | --- | --- |
| 1.0.0 | 1 | 1,677,701 | 首版（食物库 159 条） |
| 1.1.0 | 2 | 1,700,824 | 复合菜 526 条 + 整份合并 + 滑动刻度尺 + kg/斤 |
| 1.2.0 | 3 | 1,709,645 | 常吃套餐 + 最近吃过 + 7 日均线 + 备份提醒 |
| 1.3.0 | 4 | 1,710,227 | 视觉刷新：品牌绿渐变、卡片化、图标与控件统一 |
| 1.4.0 | 5 | 1,710,227 | **App 内更新**：今日页自动检查 version.json，点「立即更新」下载 + sha256/签名双校验 + 拉起系统安装器 |
| 1.5.0 | 6 | 1,731,713 | 食物库 651 条：部位/去皮/生熟（鸡腿去皮 120 vs 带皮 181）+ 578 条真实份量单位 |
| 1.5.1 | 7 | 1,732,602 | 修：APK 内不再注册 Service Worker（升级后首启不再加载旧缓存）；设置页加「检查更新」与真实版本号 |
| 1.7.0 | 9 | 1,786,238 | **多账号与云同步**：每用户独立 IndexedDB、注册/登录/恢复码、整库快照同步（API Key 不上传）、iOS PWA 适配 |
| 1.6.0 | 8 | 1,742,505 | 运动净消耗口径 + 24 种运动（骑行五档，档位记忆）；BMI 区间条+指针+四档体态小人+距边界差值；饮食页折叠与整日套餐一键记多餐 |

三个包都是同一套签名证书，**可以逐版覆盖安装，不丢数据**。1.1.0 曾因构建流程失误被覆盖，已从提交 `9b2fef3` 重建（包大小与站点资源总量和原件一致，sha 因签名时间戳不同而不同）。
- minSdk 24（Android 7.0+），targetSdk 34
- 权限只有 `INTERNET`（调视觉识别 API 用），**没有** CAMERA 权限——拍照走系统相机 intent 委托

## 2. 装到手机

1. 把 APK 传到手机（USB 数据线 / 微信文件传输助手 / 网盘都行）
2. 手机上点开这个文件，系统会提示「未知来源应用」→ 允许本次安装
3. 装完桌面出现 `HMS 健康` 图标

## 3. 从 PWA 迁移已有数据

1. **先在 PWA 里**：设置 → 数据 → 导出 JSON（存到手机文件里）
2. 装好 APK 后：设置 → 数据 → 导入 JSON → 选「合并」或「覆盖」
3. 之后以 APK 为准；PWA 可以留着当第二个备份入口

照片二进制不进 JSON（只有计数），迁移后旧照片不会跟过来，这是设计如此。

## 4. 首次安装必测（按顺序，2 分钟）

1. 点图标能启动，不白屏，首页出现「今日」
1b. 首页顶部若出现黄色备份提醒条，说明 ≥7 天没备份或从未备份——点「导出」应真的下载 JSON，条随即消失
2. 设置 → 个人档案 → 保存 → 回今日页，热量环与目标出现
3. 记一条体重 → 折线出现（验证 IndexedDB 可持久化）
4. 杀掉进程重开 → 数据还在
5. 设置 → 视觉识别 → 填 Key → 测试连接 → 应显示连接成功
6. 饮食 → 拍照识别 → 应弹出「相机 / 文件」选择 → 拍一张 → 出识别结果
7. 返回键：视图内返回上一页，首页再按则退出

任何一步不对，把现象告诉调度 Agent；WebView 的调试可以用 `chrome://inspect`（需要用 USB 连接并在手机上开 USB 调试）。

## 5. 重新构建

工具链已装好在 `android/.tools/`（JDK 17 / Android SDK 34 / Gradle 8.7），不需要重装：

```powershell
# 完整构建：同步网页资源 → gradlew assembleRelease → 复制到 Desktop\hms-release
powershell -ExecutionPolicy Bypass -File C:\Users\Administrator\Desktop\hms\android\build.ps1

# 单独验收
powershell -ExecutionPolicy Bypass -File C:\Users\Administrator\Desktop\hms\android\verify-apk.ps1 `
  -Apk "C:\Users\Administrator\Desktop\hms-release\HMS-健康-1.0.0.apk"
```

改了网页之后务必重跑 `build.ps1`——它内部的 `sync-assets.ps1` 会把 `index.html / app.js / js/ / views/ / icons/` 等 23 个文件重新拷进 `assets/www/` 并逐项校验。**APK 里的网页是打包时的那一份，不会自动跟随 GitHub Pages 更新。**

## 6. 签名与密钥（重要）

- keystore：`C:\Users\Administrator\.hms-keystore\hms.keystore`（alias `hms`，RSA 2048，有效期 10000 天）
- 口令：见 `android\keystore.properties`（已被 `.gitignore` 排除，**不在仓库里**）
- **这个 keystore 一旦丢失，就无法再发布可覆盖安装的新版本**——只能卸载重装，而卸载会清掉本机数据。请把它和口令备份到你能找回来的地方。
- 升级发版时**必须把 `android/app/build.gradle` 里的 `versionCode` 加一**，否则 Android 拒绝覆盖安装同版本。

## 7. 已知未验证项

构建方能验证的只有：签名有效、包名/版本/应用名正确、APK 内 23 个站点文件与磁盘逐字节一致、`classes.dex` 存在、权限清单正确、构建可复跑。

**没有真机也没有模拟器**，因此「能否启动、相机能否唤起、IndexedDB 是否持久、返回键行为、状态栏配色、软键盘遮挡」全部只能由第 4 节的人工清单确认。
