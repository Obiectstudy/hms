# HMS 健康 · Android 壳工程

把已上线的 HMS PWA 打包成自包含 APK：桌面图标点开即用、完全离线、不依赖 Chrome、无地址栏。
网页侧文件一个都没有改（`git status` 只有未跟踪的 `android/`），资源由 `sync-assets.ps1` 从仓库根目录复制。

## 产物

| 项 | 值 |
| --- | --- |
| APK（当前） | `C:\Users\Administrator\Desktop\hms-release\HMS-健康-1.3.0.apk` |
| 大小 | 1,710,227 字节（1.63 MB） |
| sha256 | `e66790748d08eee630806cf33692a08b24424e8910f5556f78228aa1ed6ffc45` |
| 包名 / 版本 | `com.obiectstudy.hms` / `1.3.0` (versionCode 4) |
| sdk | minSdk 24，targetSdk 34，compileSdk 34 |
| 签名 | v1 (JAR) + v2，RSA 2048，CN=HMS Health |
| 回退版本 | `1.2.0`（1,709,645 / code 3）、`1.1.0`（1,700,824 / code 2）、`1.0.0`（1,677,701 / code 1） |

注：内嵌站点资源在 APK 里走 deflate，所以 `js/foods.js` 原始 112,622 字节在包内只占 ~22KB —— APK 体积增长远小于源码增长。
1.1.0 那份是 2026-10-21 从提交 `9b2fef3` 重新构建的（原始文件被我误覆盖），站点资源逐文件哈希与该提交一致、包大小 1,700,824 完全相同，只有签名时间戳不同。

`build.ps1` 从 `app/build.gradle` 读 `versionName` 来命名产物，改版本只需改一处，APK 文件名不会和清单漂移。

## 结构

```
android/
  setup-tools.ps1    一次性下载 JDK17 / Android cmdline-tools / Gradle 8.7 到 .tools/（不写系统目录）
  env.ps1            设置 JAVA_HOME / ANDROID_HOME / GRADLE_HOME / GRADLE_USER_HOME / PATH
  sync-assets.ps1    从 sw.js 的 PRECACHE 解析清单 → 复制到 app/src/main/assets/www → 逐项校验
  build.ps1          同步资源 + gradlew assembleRelease + 复制到 Desktop\hms-release
  verify-apk.ps1     四条验收：apksigner / aapt2 badging / assets 清单 / dex 与体积
  app/               AGP 模块（Java、单 Activity、androidx.webkit WebViewAssetLoader）
```

## 复跑

```powershell
# 只需一次：工具链（约 1.2GB，JDK 17.0.2 + build-tools 34.0.0 + platform android-34 + gradle 8.7）
powershell -ExecutionPolicy Bypass -File C:\Users\Administrator\Desktop\hms\android\setup-tools.ps1

# 每次构建：同步资源 → 签名 release APK → 复制到 hms-release
powershell -ExecutionPolicy Bypass -File C:\Users\Administrator\Desktop\hms\android\build.ps1

# 验收
powershell -ExecutionPolicy Bypass -File C:\Users\Administrator\Desktop\hms\android\verify-apk.ps1 `
  -Apk "C:\Users\Administrator\Desktop\hms-release\HMS-健康-1.0.0.apk"
```

`build.ps1` 内部就是这三步，也可手工分开跑：

```powershell
cd C:\Users\Administrator\Desktop\hms\android
. .\env.ps1
& .\sync-assets.ps1
.\gradlew.bat assembleRelease
```

## 实现要点

- **不用 `file://`**：ES Module 在 `file://` 下被 CORS 规则拦死（整站白屏）。
  `WebViewAssetLoader` 把 `https://appassets.androidplatform.net/assets/www/...` 映射到 APK 内 `assets/www/...`，
  启动 URL 为 `https://appassets.androidplatform.net/assets/www/index.html`。
- `shouldInterceptRequest` 命中后按扩展名修正 MIME：平台 mime 表对 `js`/`webmanifest` 可能回落到 `text/plain`，
  而模块脚本的严格 MIME 校验会据此拒绝执行。
- **相机/相册**：`WebChromeClient.onShowFileChooser` → `createChooser(ACTION_GET_CONTENT, EXTRA_INITIAL_INTENTS=[ACTION_IMAGE_CAPTURE])`，
  拍照输出走 `FileProvider`（`cache/camera/`），避免 `FileUriExposedException`。
  Manifest 里**故意不声明** `CAMERA` 权限：拍照委托给系统相机应用，不需要运行时授权（声明了反而可能因未授权抛 `SecurityException`）。
- 返回键：`canGoBack()` 时后退，否则退出。主题 `Theme.Material.Light.NoActionBar`，状态栏 `#0FA37F`，窗口底色 `#F6F8F7`。
- 签名材料在仓库之外：`C:\Users\Administrator\.hms-keystore\hms.keystore`；`keystore.properties` 已被 `.gitignore` 排除（仓库是公开的）。

## 资源清单：23 个文件，不是 24

站点是 **23 个文件**（5 个根文件含 `sw.js` + `js/` 7 + `views/` 7 + `icons/` 4）。
`sw.js` 的 `PRECACHE` 也是 23 条，但两条清单差一个替换：`PRECACHE` 里首条 `'./'` 是站点根别名（等同 `./index.html`），
而 service worker 无法预缓存自己，所以 `sw.js` 不在 `PRECACHE` 里。
`sync-assets.ps1` 以 `PRECACHE` 为唯一事实来源，去重后补上 `sw.js`，最终写入 23 个文件并逐项打印 + 校验。

## 本机环境约束（重要，复跑前先看）

- 上游 `api.adoptium.net`（跳转 GitHub Release）、`services.gradle.org` 在本机只有 0–20 KB/s，
  所以脚本全部改用国内镜像：华为云 OpenJDK 17.0.2、腾讯云 AndroidSDK / Gradle 发行包、阿里云 Maven。
  `gradle/wrapper/gradle-wrapper.properties` 的 `distributionUrl` 也因此指向腾讯云镜像。
- **本机 JVM 只能写工作区内的路径**（对 `C:\Users\Administrator\*.txt`、`%TEMP%` 均 `Access denied`；
  但 cmd / node / PowerShell 不受限）。因此 `env.ps1` 把 `GRADLE_USER_HOME`、`ANDROID_USER_HOME`、`java.io.tmpdir`
  全部指向 `android/.tools/` 下。副作用：keytool 无法直接写到 `C:\Users\Administrator\.hms-keystore`，
  keystore 是先在 `android/` 下生成再移动过去的（Gradle 只读该文件，读不受限）。
- AGP 会打印 `Unable to initialize metrics ... :\Users\Administrator\.android is writable` 警告，
  这是同一条限制导致的统计上报失败，不影响构建。
- `.tools/`（JDK/SDK/Gradle/缓存，约 1.2GB）、`app/src/main/assets/www/`（同步产物）、`app/build/` 均被 git 忽略。
