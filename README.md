# PPTPlayer for Windows（Tauri 2）

本地 PPT 播放器的 Windows 桌面外壳。渲染逻辑全部在前端，宿主只做三件事：开窗口、装资源、兜错误。

## 交付形态（Release 里两个附件）

| 文件 | 体积（v0.5.1 实测） | 形态 | 适用 |
|---|---|---|---|
| `PPTPlayer_<ver>_x64-setup.exe` | **1.25 MB** | NSIS 安装包 | 常规安装：开始菜单 + 卸载项，当前用户装，不弹 UAC |
| `PPTPlayer.exe` | **3.21 MB**（3,367,424 B，构建间稳定） | 绿色便携版 | 免安装、放 U 盘、临时给别人演示 |
| `SHA256SUMS.txt` | 176 B | 校验值 | `shasum -c` / `certutil -hashfile` |

安装包比免安装版还小，是因为 NSIS 用 LZMA 又压了一遍（3.21 MB → 1.25 MB，约 39%）。
体积下限由「是否自带浏览器引擎」决定，两者都不带 —— 都用系统 WebView2。

## 体积账（这是选 Tauri 的唯一理由）

**实测产物：3.21 MB（3,367,424 字节，多次构建一致），单文件，无附带 DLL。**

| 组成 | 量级 | 说明 |
|---|---|---|
| 前端（HTML + 解析/渲染引擎） | 417 KB → 约 100 KB | 编译期 brotli 压缩嵌入 exe，运行时不再读磁盘 |
| `.text`（Rust 宿主 + Tauri + WebView2 绑定） | 2.4 MB | `opt-level="s"` + LTO + strip 之后 |
| `.rdata` + `.pdata` + `.data` | 约 0.6 MB | 资源表、内嵌资源、异常表 |
| `.rsrc`（图标/版本信息） | 19 KB | 多尺寸 ico 已嵌入 |
| **exe 合计** | **3.09 MB** | x64，GUI 子系统 |
| NSIS 安装包 | **1.19 MB** | 上面的 exe 再经 LZMA + 安装脚本；**不含** WebView2 引导器 |
| WebView2 运行时 | **0（不计入）** | 复用系统的：Win11 预装，Win10 绝大多数已有 |

安装包为什么能比 exe 还小：NSIS 默认 `lzma` 整包压缩，而这 1.19 MB 里没有浏览器内核、
没有运行库、也没有 1.8 MB 的 WebView2 引导器（选了 `downloadBootstrapper`：缺失时才在安装期联网下载）。
代价是**离线装机会卡在 WebView2 这一步**——要离线装，得把 `webviewInstallMode` 改成 `embedBootstrapper`（+1.8 MB）
或 `offlineInstaller`（+127 MB）。

对照：Electron 同类 80–150 MB；.NET 自包含 30–60 MB。差别不在优化，而在**是否自带浏览器引擎**。

### 已核验的静态事实（inspect-exe.py）

| 检查项 | 结果 | 意义 |
|---|---|---|
| PE 子系统 | `2 = GUI` | 双击不会弹黑框 |
| 导入 DLL | 24 个，全部为系统库 | 含 `kernel32/user32/ole32/comctl32/dwmapi` 与 UCRT |
| `WebView2Loader.dll` | **未出现在导入表** | 静态链接，单文件成立 |
| `vcruntime140.dll` / `msvcp140.dll` | 未出现 | 不依赖 VC++ 运行库，Win10+ 可直接跑 |
| `index.html` 资源键 | 命中 6 次 | 前端已注册为内嵌资源 |
| 前端原文 | 命中 0 次 | 已 brotli 压缩（所以搜不到明文） |
| SHA256 | 每轮构建变化 | 以 Release 里的 `SHA256SUMS.txt` 为准，与 CI 报告一致即下载无损 |

安装包（NSIS）同样可静态核验，`inspect-exe.py` 直接跑：

| 检查项 | 结果 | 意义 |
|---|---|---|
| PE 头 | PE32（32 位安装器外壳）| NSIS 桩历来是 x86，正常；装的仍是 x64 程序 |
| 子系统 | `2 = GUI` | 双击出向导，不弹黑框 |
| 节 | 5 个，含 `.ndata` | `.ndata` 是 NSIS 标志段 |
| 导入 DLL | 7 个，全系统库 | `kernel32/user32/shell32/ole32/advapi32/comctl32/gdi32` |
| `Nullsoft` 字符串 | 命中 3 次 | 确认是 NSIS 包 |
| 载荷熵 | 8.00 bits/byte | 全包 LZMA，所以里面搜不到 `PPTPlayer` 等明文（这是压缩生效，不是没打进去） |
| makensis 日志 | `produce …\bundle\nsis\PPTPlayer_0.2.0_x64-setup.exe` | CI 日志可回溯打包过程 |


## 构建

产物由 GitHub Actions 在 `windows-latest` 上原生编译并打包
（Tauri 官方**不支持**从 macOS 交叉产出 Windows 安装包，所以本机只能校验、不能出包）。

1. 推到 GitHub，Actions 里的 `build-windows` 会自动跑（或手动 `workflow_dispatch`），约 3–4 分钟。
2. CI 跑 `tauri build`，一次产出两样：`target/release/PPTPlayer.exe` 与
   `target/release/bundle/nsis/PPTPlayer_<ver>_x64-setup.exe`。
3. 同一次运行里自动建 Release（tag 取自 `tauri.conf.json` 的 `version`）并上传三个附件；
   已存在同名 tag 时只更新说明与附件（`--clobber`）。
4. artifact（`PPTPlayer-windows-x64`）只作备份。私有仓库 artifact 配额仅 500 MB，
   满了会让上传失败，所以那一步设了 `continue-on-error`，不阻断交付。

**产物不会自己回到本地。** 打包在 GitHub 的 Windows 机器上跑，本地 `dist/windows/`
是「上一次手动下载」的快照，不跟着 Release 走——这里曾放着 v0.4.1 的旧包，而 Release
已经是 v0.5.1。要么手动从 Release 页下载，要么跑：

```bash
node tools/fetch-release.mjs             # 最新 Release → ../dist/windows，并逐项校验 SHA256
node tools/fetch-release.mjs --dry-run   # 只比对本地与 Release 差多少，不下载
node tools/fetch-release.mjs --tag v0.4.1 --out /tmp/old
```

脚本先按体积比对本地文件与 Release，一致就跳过；下载完按 `SHA256SUMS.txt` 重算，
对不上非零退出——**别把校验失败的包发给买家**。

**升版本要改两处**：`src-tauri/tauri.conf.json` 的 `version`（决定安装包文件名与 Release tag）
和 `src-tauri/Cargo.toml` 的 `version`（决定 exe 内的版本资源）。

本地只能做这两件事（都不需要 Windows）：

```bash
cd src-tauri && cargo check     # 校验 tauri.conf.json（含 bundle 配置）/ capabilities / Rust 代码
cd .. && python3 ../inspect-exe.py ../dist/windows/PPTPlayer.exe   # PE 结构静态核验
```

想在本机看 Tauri 是否认得这份工程：`npx -y @tauri-apps/cli@^2 info`（会打印 `build-type: bundle` 与解析出的配置）。

## 改了前端之后

前端唯一事实来源在上一级 `PPTPlayer/`：

```bash
cd ..                        # 回到 PPTPlayer/
node build-web.mjs && node build-single.mjs
node desktop/tools/sync-web.mjs     # dist/PPTPlayer.html -> desktop/web/index.html
```

`web/index.html` 已入库，所以 CI 侧不需要 Node。

## 授权与激活（v0.5.1 起）

桌面版按**台**授权，未激活不能使用。整套是**离线**的：验签在 Rust 侧，运行期零网络请求。

```
启动 → index.html 的闸门问一次 license_status
        ├─ licensed=true  → 正常进播放器
        └─ 否则           → location.replace('gate.html') 显示机器码，等激活
```

| 文件 | 作用 |
|---|---|
| `src-tauri/src/license.rs` | 指纹、Base32、Ed25519 验签、授权文件读写、错误文案 |
| `src-tauri/src/pubkey.rs` | **公钥**（32 字节，可公开，随代码提交） |
| `src-tauri/src/main.rs` | 三个命令：`license_status` / `license_activate` / `license_info` |
| `web/gate.html` | 激活页（机器码 + 复制 + 注册码粘贴） |
| `tools/license-keygen.mjs` | 发码工具（**只有作者用**） |
| `tools/keys/license.key` | **私钥**，已被 .gitignore 排除，永不入库、永不进包 |

授权文件：`%APPDATA%\cn.pptplayer.desktop\license.lic`（macOS 为 `~/Library/Application Support/cn.pptplayer.desktop/`）。

### 注册码格式

73 字节 → Crockford Base32 **117 字符**（每 5 位一组便于核对）：

```
[0]      版本 2（v0.5.1 起；版本 1 的旧码会被明确拒绝，不会误报"另一台电脑"）
[1..3]   到期日（相对 2026-01-01 的天数，0 = 永久）
[3..9]   机器指纹前 6 字节
[9..73]  Ed25519 签名
```

指纹来源按可信度分级，**每级用不同盐前缀**，降级不会与正常模式撞码：

| 级别 | 取源 | 重装系统 | 换硬件 |
|---|---|---|---|
| `smbios` | 主板 SMBIOS Type 1 UUID（`GetSystemFirmwareTable`，不走 WMI/COM） | 不变 | 换主板才变 |
| `disk` | 物理盘 0 序列号 + `MachineGuid` | 会变 | 换盘会变 |
| `weak` | `MachineGuid` + `PROCESSOR_IDENTIFIER` | 会变 | 基本不变 |
| 无 | 读不到 → 机器码为空，激活页禁用（不再伪造 "no-guid" 共享码） | — | — |

占位值会被识别并跳过：全 0/全 FF/`03000200-0400-0500-0006-000700080009` 这类 UUID，
以及 `To Be Filled By O.E.M.` 这类磁盘序列号。
**不采集**用户名、IP、文件内容等隐私数据，且不上传任何东西。

**档位对买家不可见**：激活页只在 `weak` 时弹琥珀色提示（克隆机同码，建议走企业授权），
`smbios`/`disk` 两种情况界面完全一样。机器码是 `{source}|{material}` 的哈希前 10 字节，
**不能反推档位**——所以发码方无法从买家发来的码判断"这台的码重装后会不会变"。
售后按最保守口径答（重装可能要重发），别承诺"一定不用换"，除非当场用 `--selftest` 看过。

### 自检命令

```bash
cd src-tauri && cargo test                      # 单元测试：Base32、指纹形状、拒绝垃圾码、日期
cargo run -- --selftest                         # 打印本机机器码
PPT_LICENSE="<注册码>" cargo run -- --selftest   # 交叉验签（Node 签发 → Rust 验证）
cd .. && node verify-gate.mjs                   # 前端闸门（需要 8877 端口的静态服务）
```

### 为什么不联网激活

商品卖点第一句就是"运行期零网络请求"。加在线校验等于把这句话删掉，还会引入服务器成本和隐私问题。
代价是**每单必须人工发一次码**——这是明确接受的取舍，不是遗漏。

## 使用

**安装版**：双击 `PPTPlayer_<ver>_x64-setup.exe` → 中文向导 → 装完可从开始菜单/桌面快捷方式启动。
- 安装目录：`%LOCALAPPDATA%\PPTPlayer`（当前用户，不弹 UAC）
- 卸载：设置 → 应用 → PPTPlayer，或安装目录里的 `uninstall.exe`
- 完成页有「创建桌面快捷方式」（默认勾选）和「立即运行 PPTPlayer」两个勾选项

**便携版**：双击 `PPTPlayer.exe` 直接用。

两种形态操作一致：把 `.pptx` 拖进窗口。工具栏分两行——上行播放控制，下行视图与工具。

| 操作 | 快捷键 | 说明 |
|---|---|---|
| 翻页 | `←/→`/空格 | `Home`/`End` 首末页 |
| 换文件 | `Ctrl+O` | 或工具栏「打开文件」，或把新文件拖到画面任意处 |
| 缩略图 | `T` | 左侧栏，选择会记住 |
| **备注** | `N` | 底部面板显示当前页演讲者备注，翻页跟随 |
| **隐藏页** | `H` | 放映时跳过隐藏页；缩略图里隐藏页会调暗并打「隐藏」标 |
| **自动换片** | `A` | 按文件里的换片时间自动前进（文件没设 `advTm` 就不会动） |
| **搜索** | `Ctrl+F` | 命中页跳转 + 上下文片段高亮；备注文本也参与搜索 |
| **导出 PNG** | — | 当前页 2 倍分辨率，文件名 `<deck>-pN.png` |
| **打印** | `Ctrl+P` | 整份文稿按页矢量打印（接管了浏览器默认 Ctrl+P） |
| 全屏 / 缩放 | `F` / `+` `-` | |

## 验证边界

| 环节 | 状态 |
|---|---|
| 前端渲染/播放 | 双引擎回归（Chromium + WebKit），见上一级 `verify-*.mjs` |
| 便携版 exe 实际运行 | **已在 Windows 上验证通过**（v0.1.0 起，含拖放、动画、音频、换文件） |
| **按台授权（激活链路）** | **已在 Windows 真机验证通过（2026-10-31）**：未激活停在激活页，粘贴注册码后正常进入播放器 |
| CI 编译 + PE 静态结构 | 每轮自动核验（GUI 子系统、无 `WebView2Loader.dll`、`.rsrc` 图标已嵌入） |
| **NSIS 安装包的实际安装** | **未验证** —— 只有 Windows 才能装。本轮新增，请首次安装后按下面几项确认 |

安装包首次使用需确认（按风险排序）：

| # | 待确认 | 判断标准 |
|---|---|---|
| 1 | 向导是否中文、无乱码 | 语言配置为 SimpChinese 优先；乱码 = 语言文件或编码问题 |
| 2 | 装完能否从开始菜单启动 | 能启动 = 快捷方式指向与 `mainBinaryName` 一致 |
| 3 | 桌面快捷方式 | 完成页勾选后应出现 `PPTPlayer.lnk` |
| 4 | 卸载是否干净 | 设置 → 应用卸载后，`%LOCALAPPDATA%\PPTPlayer` 应被删除；WebView2 缓存目录留给系统 |
| 5 | 缺 WebView2 的机器 | 安装期应静默联网装它；无网络时会失败（已知代价，见「体积账」） |

## 已知限制（桌面版特有）

| 项 | 现象 | 说明 |
|---|---|---|
| 文件关联 | 不能双击 pptx 直接打开 | 安装包未注册文件关联；需要 `fileAssociations` 配置 + 命令行参数，本版未做 |
| `F` 全屏 | 可能只铺满窗口、保留标题栏 | WebView2 的 Fullscreen API 默认作用于 webview 区域；要真全屏需加一条 `setFullscreen` IPC（约 15 行），Windows 实测后确认 |
| 缓存落盘 | `%LOCALAPPDATA%\cn.pptplayer.desktop` 会有几十 MB | WebView2 的 User Data Folder，属正常缓存；需要可加限制或重定向。**卸载不会清它**（系统级组件，多程序共用） |
| 未签名 | 安装包与 exe 首次运行都可能弹 SmartScreen | 点「更多信息 → 仍要运行」；安装包还会显示「未知发布者」。消除需代码签名证书（年费） |
| 缺 WebView2 | 安装包会静默联网装；便携版弹原生提示框并给出下载地址 | 两条路径都处理了，不会静默失败；纯离线装机需改 `webviewInstallMode` |
| 自动更新 | 无 | 未接 updater。升级＝下载新安装包覆盖安装（NSIS 会走"已安装"维护流程） |
| 自动换片只认文件里的换片时间 | 文件没设 `advTm` 时，开关打开也不会动 | 这是 PowerPoint 语义。想"每页固定 5 秒"需自己做定时器，本版未做 |
| 搜索是页级命中 | 找不到页内第几处，也不做页内高亮 | 库的 `search()` 只返回命中页索引 |
| 打印不含备注 / 批注 | 只打页面本身 | `presentationToPrintableHtml({showComments:false})`，可改 |
| 导出 PNG 不含视频帧 | 视频位置画的是封面/占位 | 导出走库的 svg 重绘路径，媒体只画 badge |
| 格式/引擎限制 | 同单文件版 | 见 `../LIMITATIONS.md` |
