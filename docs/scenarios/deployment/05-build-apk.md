# 场景 05:构建安卓包(tools/build-apk.ps1)

## 目标

在 Windows 上从源码构建 `VoxelCraft.apk`,可选地把一个默认服务器地址"烤入"包内,
然后把 APK 放到服务器上供手机直接下载安装(配合场景 03)。

## 前提

- **Windows + PowerShell**(脚本是 `.ps1`,且 JDK 自动探测路径写死在
  `C:\Program Files\Eclipse Adoptium` 下;其他系统见文末"非 Windows 怎么办")。
- **Node 依赖已安装**:仓库根目录执行过 `npm install`
  (Capacitor CLI/内核与安卓平台是 `package.json` 里的依赖,脚本通过 `npx cap` 调用)。
- **JDK 21**(Temurin/Eclipse Adoptium 发行版)。脚本定位顺序:
  1. 环境变量 `JAVA_HOME` 已设置 → 直接用;
  2. 否则取 `C:\Program Files\Eclipse Adoptium` 下第一个子目录;
  3. 都没有 → 报错 `JDK not found; install Temurin 21 first.`
- **Android SDK**。Gradle 按安卓工具链的标准方式定位 SDK:
  环境变量 `ANDROID_HOME`,或在 `android/local.properties` 写一行
  `sdk.dir=<SDK 路径>`(该文件不入库,克隆后需自建)。
  所需的具体 SDK 组件版本以首次构建时 Gradle 的提示为准(待定,未在仓库中固定声明)。
- 安卓工程 `android/` 与 Gradle Wrapper(`android/gradlew.bat`)已随仓库提供,
  无需安装全局 Gradle;首次构建会联网下载 Gradle 发行版与依赖。

## 操作步骤

1. 在仓库根目录执行(`-DefaultServer` 可省略):

   ```powershell
   powershell -File tools\build-apk.ps1 -DefaultServer "play.example.com"
   ```

   `-DefaultServer` 的值就是要预填进 App"服务器地址"输入框的字符串,
   填法规则与输入框一致(裸 `host:port` 走 `ws`、裸域名走 `wss`,见场景 03 的表)。
   省略则 App 首次打开时地址栏为空,玩家需手填。
2. 脚本依次做这几件事(出错即停):
   1. `npx cap sync android` —— 把 `public/` 整体拷入安卓工程资源;
   2. 删除资源里上一次构建混进去的旧 `VoxelCraft.apk`(避免"APK 里套 APK");
   3. 若给了 `-DefaultServer`:用一行
      `window.VC_DEFAULT_SERVER = '<地址>';`
      覆写安卓资源内的 `app-config.js` 副本(**仓库里的
      `public/app-config.js` 原文件保持为空,不会被改动**);
   4. `android\gradlew.bat assembleDebug` 构建 debug 包;
   5. 把产物拷贝为 **`public/VoxelCraft.apk`** 并打印大小。
3. 构建完成后,开着的游戏服务器即自动提供下载:
   手机浏览器访问 `服务器地址/VoxelCraft.apk` 即可(参考体积约 4.5 MB)。

## 预期结果

- 控制台末行输出 `APK ready: public\VoxelCraft.apk (x.x MB)`。
- 原始产物在 `android/app/build/outputs/apk/debug/app-debug.apk`,
  发布副本在 `public/VoxelCraft.apk`(此路径已被 `.gitignore` 排除,不会误提交)。
- 安装后 App 的"服务器地址"输入框预填烤入值;玩家改过之后以玩家改的为准
  (保存值优先于烤入值),所以**换服务器不需要重新打包**,
  重新打包只为换"出厂默认值"或更新游戏代码本体。

## 常见故障与排查

| 现象 | 原因与处理 |
|---|---|
| `JDK not found; install Temurin 21 first.` | 安装 Temurin 21(Eclipse Adoptium 发行版),或把已有 JDK 21 的路径设为 `JAVA_HOME` 后重跑。 |
| `cap sync failed` | 通常是 `npm install` 没跑或 `node_modules` 损坏;重装依赖后再试。 |
| `gradle build failed`,提示 SDK location not found | 设置 `ANDROID_HOME`,或创建 `android/local.properties` 写入 `sdk.dir=...`。 |
| Gradle 首次构建卡在下载 | Wrapper 需要联网拉 Gradle 与依赖,网络不畅时配置代理或换网络重试。 |
| 构建成功但手机访问 `/VoxelCraft.apk` 是 404 | 确认服务器跑的是构建后的这份仓库目录;`public/VoxelCraft.apk` 是否存在。 |
| 安装时报"应用未安装"或签名冲突 | debug 包之间签名一致可覆盖安装;若此前装过其他来源/签名的同 ID 包(`com.voxelcraft.app`),先卸载旧的。 |
| 想打正式签名的 release 包 | 当前脚本只做 `assembleDebug`,release 签名流程仓库未提供(待定),需自行配置 Gradle signingConfig。 |

## 非 Windows 怎么办

脚本本身是 Windows PowerShell 流程,但每一步都是标准 Capacitor/Gradle 操作,
macOS/Linux 可手工等价执行:`npx cap sync android` → 按需覆写
`android/app/src/main/assets/public/app-config.js` → `cd android && ./gradlew assembleDebug`
→ 从 `android/app/build/outputs/apk/debug/app-debug.apk` 取产物。
(仓库未提供对应 shell 脚本。)
