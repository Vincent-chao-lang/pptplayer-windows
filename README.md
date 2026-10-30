# PPTPlayer for Windows（Tauri 2）

本地 PPT 播放器的 Windows 桌面外壳。渲染逻辑全部在前端，宿主只做三件事：开窗口、装资源、兜错误。

## 体积账（这是选 Tauri 的唯一理由）

| 组成 | 量级 | 说明 |
|---|---|---|
| 前端（HTML + 解析/渲染引擎） | 417 KB | 编译期以 brotli 嵌入 exe，压缩后约 100 KB |
| Rust 宿主 + Tauri 运行时 | 2–3 MB | `opt-level="s"` + LTO + strip |
| WebView2 绑定 | 数百 KB | 静态链接 loader，不额外带 DLL |
| **exe 合计** | **约 2–4 MB** | 取决于 cargo 依赖版本 |
| WebView2 运行时 | **0（不计入）** | 复用系统的：Win11 预装，Win10 绝大多数已有 |

对照：Electron 同类 80–150 MB；.NET 自包含 30–60 MB。差别不在优化，而在**是否自带浏览器引擎**。

## 构建

产物由 GitHub Actions 在 `windows-latest` 上原生编译（macOS 交叉编译 Tauri 官方不支持）。

1. 推到 GitHub，Actions 里的 `build-windows` 会自动跑（或手动 `workflow_dispatch`）。
2. 打开那次 run，下载 artifact `PPTPlayer-windows-x64`，里面就是 `PPTPlayer.exe` 单文件。

本地只做静态校验（不产出 exe）：

```bash
cd src-tauri && cargo check
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

## 已知限制（桌面版特有）

| 项 | 现象 | 说明 |
|---|---|---|
| 文件关联 | 不能双击 pptx 直接打开 | 需要注册表 + 命令行参数，本版未做 |
| `F` 全屏 | 可能只铺满窗口、保留标题栏 | WebView2 的 Fullscreen API 默认作用于 webview 区域；要真全屏需加一条 `setFullscreen` IPC（约 15 行），待 Windows 实测确认后再定 |
| 缓存落盘 | `%LOCALAPPDATA%\cn.pptplayer.desktop` 会有几十 MB | WebView2 的 User Data Folder，属正常缓存；需要可加限制或重定向 |
| 未签名 | 首次运行弹 SmartScreen「Windows 已保护你的电脑」 | 点「更多信息 → 仍要运行」；消除需代码签名证书 |
| 缺 WebView2 | 弹原生提示框并给出下载地址 | 已处理，不会静默失败 |
| 格式/引擎限制 | 同单文件版 | 见 `../LIMITATIONS.md` |
