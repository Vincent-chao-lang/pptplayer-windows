// 本地 PPT 播放器 · Windows 宿主（Tauri 2 / WebView2）
//
// 设计取舍：
// - 前端只有一份自包含 HTML（内嵌解析与渲染引擎），由 tauri-build 在编译期
//   以 brotli 压缩嵌入 exe，运行时不再读磁盘上的任何资源文件。
// - 不注册任何 Tauri IPC 命令、不引用 Tauri JS 运行时，界面与宿主零耦合。
// - WebView2 运行时不打包（要 200MB+），改用系统常青版：Win11 由 OS 预装，
//   Win10 绝大多数已被 Windows Update 铺过。缺失时必须给出可读提示，
//   不能像纯前端方案那样“双击没反应”。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(windows)]
    if !webview2_installed() {
        fatal(
            "本机缺少 Microsoft Edge WebView2 运行时，播放器无法启动。\n\n\
             请安装后重试（约 2 MB，装完只需一次）：\n\
             https://go.microsoft.com/fwlink/p/?LinkId=2124703",
        );
        std::process::exit(1);
    }

    if let Err(e) = tauri::Builder::default().run(tauri::generate_context!()) {
        fatal(&format!("播放器启动失败：{e}"));
        std::process::exit(1);
    }
}

/// 常青版 WebView2 运行时的固定落盘位置。
/// 除该目录外，运行时不会再装到别处，故只需检查这里。
#[cfg(windows)]
fn webview2_installed() -> bool {
    const CANDIDATES: [&str; 2] = [
        r"C:\Program Files (x86)\Microsoft\EdgeWebView\Application",
        r"C:\Program Files\Microsoft\EdgeWebView\Application",
    ];
    CANDIDATES.iter().any(|base| {
        std::fs::read_dir(base)
            .map(|rd| rd.flatten().any(|e| e.path().is_dir()))
            .unwrap_or(false)
    })
}

/// 无控制台窗口（windows_subsystem = "windows"）时，任何错误都必须自带
/// 可见出口，否则用户只会看到“双击没反应”。
fn fatal(msg: &str) {
    #[cfg(windows)]
    {
        use std::mem::zeroed;
        use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};

        let wide = |s: &str| -> Vec<u16> { s.encode_utf16().chain(Some(0)).collect() };
        let text = wide(msg);
        let caption = wide("PPT 播放器");
        // HWND 在不同 windows-sys 版本里是 isize 或指针，用 zeroed() 规避版本差异
        let hwnd = unsafe { zeroed() };
        unsafe {
            MessageBoxW(hwnd, text.as_ptr(), caption.as_ptr(), MB_OK | MB_ICONERROR);
        }
    }
    #[cfg(not(windows))]
    eprintln!("{msg}");
}
