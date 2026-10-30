# PPTPlayer for Windows（Tauri 2）

本地 PPT 播放器的 Windows 桌面外壳。渲染逻辑全部在前端，宿主只做三件事：开窗口、装资源、兜错误。

## 体积账（这是选 Tauri 的唯一理由）

**实测产物：3.09 MB（3,240,960 字节），单文件，无附带 DLL。**

| 组成 | 量级 | 说明 |
|---|---|---|
| 前端（HTML + 解析/渲染引擎） | 417 KB → 约 100 KB | 编译期 brotli 压缩嵌入 exe，运行时不再读磁盘 |
| `.text`（Rust 宿主 + Tauri + WebView2 绑定） | 2.4 MB | `opt-level="s"` + LTO + strip 之后 |
| `.rdata` + `.pdata` + `.data` | 约 0.6 MB | 资源表、内嵌资源、异常表 |
| `.rsrc`（图标/版本信息） | 19 KB | 多尺寸 ico 已嵌入 |
| **exe 合计** | **3.09 MB** | x64，GUI 子系统 |
| WebView2 运行时 | **0（不计入）** | 复用系统的：Win11 预装，Win10 绝大多数已有 |

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
| SHA256 | `2693929A…C0D1` | 与 CI 报告一致，下载无损 |


## 构建

产物由 GitHub Actions 在 `windows-latest` 上原生编译（macOS 交叉编译 Tauri 官方不支持）。

1. 推到 GitHub，Actions 里的 `build-windows` 会自动跑（或手动 `workflow_dispatch`），约 6 分钟。
2. **取件口是 Release**：`https://github.com/Vincent-chao-lang/pptplayer-windows/releases/tag/v0.1.0`，
   附件就是 `PPTPlayer.exe`（私有仓库需登录）。
3. artifact（`PPTPlayer-windows-x64`）只作备份。私有仓库 artifact 配额仅 500 MB，
   满了会让上传失败，所以那一步设了 `continue-on-error`，不阻断交付。

本地只做静态校验（不产出 exe）：

```bash
cd src-tauri && cargo check     # 校验 tauri.conf.json / capabilities / Rust 代码
```

产物静态核验（Mac 上即可跑，不需要 Windows）：

```bash
python3 ../inspect-exe.py ../dist/windows/PPTPlayer.exe
```

## 改了前端之后

前端唯一事实来源在上一级 `PPTPlayer/`：

```bash
cd ..                        # 回到 PPTPlayer/
node build-web.mjs && node build-single.mjs
node desktop/tools/sync-web.mjs     # dist/PPTPlayer.html -> desktop/web/index.html
```

`web/index.html` 已入库，所以 CI 侧不需要 Node。

## 使用

双击 `PPTPlayer.exe` → 把 `.pptx` 拖进窗口（或点“选择文件”）。`←/→` 翻页、`F` 全屏、`T` 开关缩略图。

## 尚未验证的部分（重要）

构建在 macOS 上完成、编译在 Windows runner 上完成，**但没有任何 Windows 机器真正运行过它**。
以下是首次运行时需要逐项确认的，按风险从高到低：

| # | 待确认 | 判断标准 |
|---|---|---|
| 1 | 窗口能否正常显示幻灯片 | 出现拖放区 → 拖入 pptx → 渲染出页面而不是空白 |
| 2 | 拖放是否生效 | 拖入文件若毫无反应，说明 `dragDropEnabled: false` 未生效，需改用 Tauri 的 drag-drop 事件转发 |
| 3 | `F` 全屏行为 | 若能铺满且无标题栏 = 正常；若只铺满窗口区域 = 需补 `setFullscreen` IPC |
| 4 | 中文字体断行 | 与本机单文件版对比同一页，字宽/换行应一致 |

## 已知限制（桌面版特有）

| 项 | 现象 | 说明 |
|---|---|---|
| 文件关联 | 不能双击 pptx 直接打开 | 需要注册表 + 命令行参数，本版未做 |
| `F` 全屏 | 可能只铺满窗口、保留标题栏 | WebView2 的 Fullscreen API 默认作用于 webview 区域；要真全屏需加一条 `setFullscreen` IPC（约 15 行），待 Windows 实测确认后再定 |
| 缓存落盘 | `%LOCALAPPDATA%\cn.pptplayer.desktop` 会有几十 MB | WebView2 的 User Data Folder，属正常缓存；需要可加限制或重定向 |
| 未签名 | 首次运行弹 SmartScreen「Windows 已保护你的电脑」 | 点「更多信息 → 仍要运行」；消除需代码签名证书 |
| 缺 WebView2 | 弹原生提示框并给出下载地址 | 已处理，不会静默失败 |
| 格式/引擎限制 | 同单文件版 | 见 `../LIMITATIONS.md` |
