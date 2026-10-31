// 本地 PPT 播放器 · Windows 宿主（Tauri 2 / WebView2）
//
// 设计取舍：
// - 前端只有一份自包含 HTML（内嵌解析与渲染引擎），由 tauri-build 在编译期
//   以 brotli 压缩嵌入 exe，运行时不再读磁盘上的任何资源文件。
// - IPC 面尽量小：只暴露三个与授权有关的命令，播放本身完全不经过 Rust。
// - WebView2 运行时不打包（要 200MB+），改用系统常青版：Win11 由 OS 预装，
//   Win10 绝大多数已被 Windows Update 铺过。缺失时必须给出可读提示，
//   不能像纯前端方案那样"双击没反应"。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod license;
mod pubkey;

/// 授权状态查询：前端启动时先问一次，未授权就跳转到授权页。
#[tauri::command]
fn license_status(app: tauri::AppHandle) -> license::Status {
    let st = license::status(&app);
    // 仅 debug 构建打印：Windows 上装完打不开时，让用户能截这行日志给客服
    #[cfg(debug_assertions)]
    eprintln!(
            "[license_status] licensed={} source={} machine={}",
            st.licensed, st.source, st.machine
        );
    st
}

/// 激活：验签通过才落盘。失败时把原因返回给前端——别只说"激活失败"，
/// 买家分不清"码抄错了"和"码不是这台的"，客服成本会翻倍。
#[tauri::command]
fn license_activate(app: tauri::AppHandle, code: String) -> Result<license::Status, String> {
    let machine = license::machine_code();
    let st = license::verify_code(&code, &machine)?;
    license::store(&app, code.trim())?;
    Ok(st)
}

/// 供客服排查：当前机器码 + 已存授权文件的状态。
#[tauri::command]
fn license_info(app: tauri::AppHandle) -> license::Status {
    license::status(&app)
}

fn main() {
    // 开发期自检：不启动窗口，打印机器码并按需校验一枚注册码。
    // 用法：PPT_LICENSE="..." cargo run -- --selftest
    if std::env::args().any(|a| a == "--selftest") {
        let machine = license::machine_code();
        println!("machine={machine}");
        println!("source={}", license::source_name());
        match std::env::var("PPT_LICENSE") {
            Ok(code) => match license::verify_code(&code, &machine) {
                Ok(s) => println!("verify=OK permanent={} expires={:?}", s.permanent, s.expires),
                Err(e) => println!("verify=ERR {e}"),
            },
            Err(_) => println!("verify=SKIP (未设置 PPT_LICENSE)"),
        }
        return;
    }

    #[cfg(windows)]
    if !webview2_installed() {
        fatal(
            "本机缺少 Microsoft Edge WebView2 运行时，播放器无法启动。\n\n\
             请安装后重试（约 2 MB，装完只需一次）：\n\
             https://go.microsoft.com/fwlink/p/?LinkId=2124703",
        );
        std::process::exit(1);
    }

    if let Err(e) = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            license_status,
            license_activate,
            license_info
        ])
        .run(tauri::generate_context!())
    {
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
/// 可见出口，否则用户只会看到"双击没反应"。
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
