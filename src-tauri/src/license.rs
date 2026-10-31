// 离线注册码：机器指纹 + Ed25519 验签 + 本地授权文件
//
// 设计约束（为什么是这几条）：
// 1. **必须能离网**。商品卖点第一句就是"运行期零网络请求"，加任何在线校验都会自相矛盾。
//    代价：离线校验一定可以被 patch。本模块的目标不是"不可破解"，而是让"
//    转发给同事就能用"这件事不成立——把破解成本抬到明显高于一份 ¥19.9 的售价。
// 2. **签名在 Rust 侧，不在 JS 侧**。前端是一份静态 HTML，公钥和判断逻辑写进 JS 等于
//    公开源码；放在这里，改判定需要重新编译整个 exe。
// 3. **私钥不在包里**。这里只有公钥（pubkey.rs），所以别人即使拿到 exe 也无法伪造注册码，
//    最多只能逆向改判定——这比"能批量造码"安全一个量级。
//
// 注册码结构（73 字节 → Crockford Base32 117 字符）：
//   [0]      版本号（当前 2；v2 起指纹算法换成 SMBIOS 分级取源）
//   [1..3]   到期日：相对 2026-01-01 的天数，0 表示永久
//   [3..9]   机器指纹前 6 字节（绑定这台机器）
//   [9..73]  Ed25519 签名（对前 9 字节）
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use sha2::{Digest, Sha256};

use crate::pubkey::LICENSE_PUBKEY;

const VER: u8 = 2;
const CODE_LEN: usize = 73;
/// 1970-01-01 → 2026-01-01 的天数，用作到期日的相对原点
const DAYS_TO_2026: i64 = 20454;
const ABC: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

#[derive(Debug, serde::Serialize)]
pub struct Status {
    pub licensed: bool,
    pub machine: String,
    /// 指纹来源：smbios / disk / platform / weak / none。
    /// 前端只用它决定要不要提示"本机读不到硬件标识"，不参与任何判定。
    pub source: String,
    pub permanent: bool,
    pub expires: Option<String>,
    pub error: Option<String>,
}

// ---------------- Base32 (Crockford) ----------------

fn b32_encode(bytes: &[u8]) -> String {
    let mut out = String::new();
    let mut bits = 0u32;
    let mut val: u32 = 0;
    for &b in bytes {
        val = (val << 8) | b as u32;
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(ABC[((val >> bits) & 31) as usize] as char);
        }
    }
    if bits > 0 {
        out.push(ABC[((val << (5 - bits)) & 31) as usize] as char);
    }
    out
}

fn b32_decode(s: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(s.len() * 5 / 8);
    let mut bits = 0u32;
    let mut val: u32 = 0;
    for c in s.chars() {
        // 容错第一层：连字符、空格、换行、制表符一律当分隔符跳过。
        // （发码工具输出的就是带连字符的分组格式，这里不跳过等于所有码都非法。）
        let up = c.to_ascii_uppercase();
        if !up.is_ascii_alphanumeric() {
            continue;
        }
        // 容错第二层：I/L→1、O→0、U→V，是 Crockford 的等价字符，抄错也救得回来。
        let c = match up {
            'I' | 'L' => '1',
            'O' => '0',
            'U' => 'V',
            c => c,
        };
        let v = ABC.iter().position(|&a| a as char == c)? as u32;
        val = ((val << 5) | v) & 0xffff;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            out.push(((val >> bits) & 0xff) as u8);
        }
    }
    Some(out)
}

/// 把 117 位注册码按 5 位一组分开，人眼能核对；粘回去时连字符会被自动吃掉。
fn group(s: &str, n: usize) -> String {
    let chars: Vec<char> = s.chars().collect();
    chars
        .chunks(n)
        .map(|c| c.iter().collect::<String>())
        .collect::<Vec<_>>()
        .join("-")
}

// ---------------- 机器指纹 ----------------
//
// 只用来"区分是不是同一台物理机"，不采集姓名、IP、硬盘内容。
//
// 取源按可信度分级，**每一级用不同的盐前缀**。这点很关键：如果不同来源共用同一套拼接
// 格式，降级模式算出来的机器码会和正常模式撞码，等于没降级。
//
//   smbios   主板 UUID —— 首选。重装系统不变，克隆到不同主板会变
//   disk     物理盘序列号 —— SMBIOS 是占位值时的兜底
//   platform macOS 的 IOPlatformUUID（硬件级）
//   weak     只剩 MachineGuid / 主机名：整批克隆出来的机器会同码，必须让客服看得出
//   none     什么都读不到：不给机器码，直接拒绝激活
//
// 旧版这里是 `unwrap_or("no-guid")` 静默退化，导致所有读注册表失败的机器共享同一个码，
// 是这套设计里最脏的一条，已改掉。

/// 指纹算法版本。改算法必须同时改 tools/license-keygen.mjs 的 VER——
/// 否则旧码会一路走到签名比对，报出"这是发给另一台电脑的"这种误导性提示。
const SALT: &str = "pptplayer/v2";

#[cfg_attr(not(windows), allow(dead_code))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    Smbios,
    Disk,
    Platform,
    Weak,
}

impl Source {
    pub fn as_str(self) -> &'static str {
        match self {
            Source::Smbios => "smbios",
            Source::Disk => "disk",
            Source::Platform => "platform",
            Source::Weak => "weak",
        }
    }
}

pub struct Fingerprint {
    pub source: Source,
    hash: [u8; 32],
}

impl Fingerprint {
    fn make(source: Source, material: String) -> Self {
        // 来源也进哈希，不只靠调用方传的前缀——少写一个前缀就会让"降级模式"和
        // "正常模式"算出同一个码，这种错误静默且致命，不该只靠注释约束。
        let d = Sha256::digest(format!("{}|{}", source.as_str(), material).as_bytes());
        let mut hash = [0u8; 32];
        hash.copy_from_slice(&d);
        Self { source, hash }
    }

    /// 买家看到的机器码：16 位，4 组便于口头核对
    pub fn code(&self) -> String {
        group(&b32_encode(&self.hash[..10]), 4)
    }
}

// ---- 坏值判定 ----
//
// 真实的 SMBIOS UUID 大量存在占位值。规范说全 0 / 全 FF 表示"未提供"，
// 但参考 BIOS 的默认值 03000200-… 有数千块主板在报（AAEON 工控板官方回复：
// 做不到每块板唯一，不打算实现）。所以"看起来像 UUID"不等于"唯一"。

#[cfg_attr(not(windows), allow(dead_code))]
const UUID_PLACEHOLDERS: &[&str] = &["03000200-0400-0500-0006-000700080009"];

#[cfg_attr(not(windows), allow(dead_code))]
fn uuid_trustworthy(raw: &[u8; 16]) -> bool {
    // 不同字节种类太少：全 0、全 FF、585858…（ASCII 'X'）这类重复模式
    let mut seen = [false; 256];
    let mut kinds = 0;
    for &b in raw {
        if !seen[b as usize] {
            seen[b as usize] = true;
            kinds += 1;
        }
    }
    if kinds < 4 {
        return false;
    }
    !UUID_PLACEHOLDERS.contains(&uuid_string(raw).as_str())
}

/// SMBIOS 2.6+ 规定 Data1/Data2/Data3 是小端。不转回来，哈希依然稳定，
/// 但打印出来和 `wmic csproduct get uuid` 对不上，客服核对时会白查一轮。
#[cfg_attr(not(windows), allow(dead_code))]
fn uuid_string(raw: &[u8; 16]) -> String {
    let mut u = *raw;
    u[0..4].reverse();
    u[4..6].reverse();
    u[6..8].reverse();
    let hex: String = u.iter().map(|b| format!("{b:02X}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

#[cfg_attr(not(windows), allow(dead_code))]
fn disk_serial_trustworthy(s: &str) -> bool {
    let t = s.trim();
    if t.len() < 6 {
        return false;
    }
    let low = t.to_ascii_lowercase();
    const JUNK: &[&str] = &[
        "to be filled by o.e.m.",
        "to be filled",
        "default string",
        "none",
        "unknown",
        "not specified",
        "123456789",
        "0000000000",
    ];
    if JUNK.iter().any(|j| low == *j) {
        return false;
    }
    // 全是同一个字符（000000000000 / AAAAAAAA）
    let mut it = t.chars();
    if let Some(first) = it.next() {
        if it.all(|c| c == first) {
            return false;
        }
    }
    true
}

// ---------------- Windows ----------------

#[cfg(windows)]
fn fingerprint() -> Option<Fingerprint> {
    if let Some(raw) = smbios_type1_uuid() {
        if uuid_trustworthy(&raw) {
            return Some(Fingerprint::make(
                Source::Smbios,
                format!("smbios:{}|{SALT}", uuid_string(&raw)),
            ));
        }
    }
    if let Some(sn) = physical_disk_serial() {
        if disk_serial_trustworthy(&sn) {
            let guid = reg_machine_guid().unwrap_or_default();
            return Some(Fingerprint::make(
                Source::Disk,
                format!("disk:{sn}|guid:{guid}|{SALT}"),
            ));
        }
    }
    // 兜底：让程序还能用，但标记 weak —— 激活页会提示，客服据此判断是否企业批量部署
    reg_machine_guid().filter(|g| !g.is_empty()).map(|g| {
        let cpu = std::env::var("PROCESSOR_IDENTIFIER").unwrap_or_default();
        Fingerprint::make(Source::Weak, format!("weak:{g}|{cpu}|{SALT}"))
    })
}

/// 读 SMBIOS 原始表，取 Type 1（System Information）里的 UUID。
/// 用 GetSystemFirmwareTable 而不是 WMI：无 COM、无服务依赖、毫秒级、不会弹窗。
#[cfg(windows)]
fn smbios_type1_uuid() -> Option<[u8; 16]> {
    use windows_sys::Win32::System::SystemInformation::GetSystemFirmwareTable;

    const RSMB: u32 = 0x5253_4D42; // "RSMB"

    // 第一次调用只问大小：缓冲区传 null 是官方支持的两段式用法
    let size = unsafe { GetSystemFirmwareTable(RSMB, 0, std::ptr::null_mut(), 0) };
    if size == 0 || size > 4 * 1024 * 1024 {
        return None;
    }
    let mut buf = vec![0u8; size as usize];
    let got = unsafe { GetSystemFirmwareTable(RSMB, 0, buf.as_mut_ptr(), size) };
    if got == 0 {
        return None;
    }
    buf.truncate((got as usize).min(buf.len()));
    if buf.len() < 9 {
        return None;
    }
    // RawSMBIOSData 头 8 字节：[0]Used20CallingMethod [1]major [2]minor [3]dmi
    // [4..8]=Length(LE)，表体从偏移 8 开始
    parse_type1_uuid(&buf[8..])
}

#[cfg(windows)]
fn parse_type1_uuid(table: &[u8]) -> Option<[u8; 16]> {
    let mut i = 0usize;
    while i + 4 <= table.len() {
        let ty = table[i];
        let len = table[i + 1] as usize;
        if ty == 127 || len < 4 {
            break; // End-of-Table，或结构体损坏
        }
        if ty == 1 && len >= 24 && i + 24 <= table.len() {
            // [0]type [1]len [2..4]handle [4..8]四个字符串索引 [8..24]UUID
            let mut u = [0u8; 16];
            u.copy_from_slice(&table[i + 8..i + 24]);
            return Some(u);
        }
        // 跳下一个结构：先跨格式区（len 字节），再跨以 \0\0 结尾的字符串区
        let mut j = i + len;
        while j + 1 < table.len() && !(table[j] == 0 && table[j + 1] == 0) {
            j += 1;
        }
        if j + 1 >= table.len() {
            break;
        }
        i = j + 2;
    }
    None
}

/// 物理盘 0 的序列号。desiredAccess=0 只查询属性，不需要管理员权限，也不读盘上任何内容。
#[cfg(windows)]
fn physical_disk_serial() -> Option<String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::CreateFileW;
    use windows_sys::Win32::System::IO::DeviceIoControl;

    const IOCTL_STORAGE_QUERY_PROPERTY: u32 = 0x002D_1400;
    const OPEN_EXISTING: u32 = 3;
    const SHARE_READ_WRITE: u32 = 3;

    let path: Vec<u16> = std::ffi::OsStr::new("\\\\.\\PhysicalDrive0")
        .encode_wide()
        .chain(Some(0))
        .collect();

    let h = unsafe {
        CreateFileW(
            path.as_ptr(),
            0,
            SHARE_READ_WRITE,
            std::ptr::null(),
            OPEN_EXISTING,
            0,
            std::ptr::null_mut(),
        )
    };
    if h == INVALID_HANDLE_VALUE || h.is_null() {
        return None;
    }

    // STORAGE_PROPERTY_QUERY：PropertyId=StorageDeviceProperty(0)、QueryType=PropertyStandardQuery(0)。
    // 结构体是 4+4+1，按 8 字节对齐后为 12 字节，传 12 最安全。
    let query = [0u8; 12];
    let mut out = [0u8; 1024];
    let mut ret: u32 = 0;
    let ok = unsafe {
        DeviceIoControl(
            h,
            IOCTL_STORAGE_QUERY_PROPERTY,
            query.as_ptr().cast(),
            query.len() as u32,
            out.as_mut_ptr().cast(),
            out.len() as u32,
            &mut ret,
            std::ptr::null_mut(),
        )
    };
    unsafe { CloseHandle(h) };
    if ok == 0 || ret < 40 {
        return None;
    }

    // STORAGE_DEVICE_DESCRIPTOR.SerialNumberOffset 在偏移 24，相对结构体起点
    let off = u32::from_le_bytes([out[24], out[25], out[26], out[27]]) as usize;
    if off == 0 || off >= out.len() {
        return None;
    }
    let end = out[off..]
        .iter()
        .position(|&b| b == 0)
        .map(|p| off + p)
        .unwrap_or(out.len());
    let s = String::from_utf8_lossy(&out[off..end]).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

#[cfg(windows)]
fn reg_machine_guid() -> Option<String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY_LOCAL_MACHINE};

    // 常量直接写死，不依赖 windows-sys 的导出名，避免版本间改名导致编译不过
    const RRF_RT_REG_SZ: u32 = 0x0000_0002;
    const RRF_SUBKEY_WOW64_64KEY: u32 = 0x0001_0000;

    let subkey: Vec<u16> = std::ffi::OsStr::new("SOFTWARE\\Microsoft\\Cryptography")
        .encode_wide()
        .chain(Some(0))
        .collect();
    let value: Vec<u16> = std::ffi::OsStr::new("MachineGuid")
        .encode_wide()
        .chain(Some(0))
        .collect();

    let mut buf = [0u16; 128];
    let mut cb: u32 = (buf.len() * 2) as u32;
    let rc = unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            subkey.as_ptr(),
            value.as_ptr(),
            RRF_RT_REG_SZ | RRF_SUBKEY_WOW64_64KEY,
            std::ptr::null_mut(),
            buf.as_mut_ptr() as *mut core::ffi::c_void,
            &mut cb,
        )
    };
    if rc != 0 || cb < 4 {
        return None;
    }
    let len = (cb as usize / 2).saturating_sub(1);
    let s = String::from_utf16_lossy(&buf[..len.min(buf.len())]);
    let s = s.trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

// ---------------- macOS ----------------

#[cfg(target_os = "macos")]
fn fingerprint() -> Option<Fingerprint> {
    let uuid = platform_uuid()?;
    Some(Fingerprint::make(
        Source::Platform,
        format!("platform:{uuid}|{SALT}"),
    ))
}

/// IOPlatformUUID 是硬件级的值：重装系统不变，换主板才变。
#[cfg(target_os = "macos")]
fn platform_uuid() -> Option<String> {
    let out = std::process::Command::new("ioreg")
        .args(["-rd1", "-c", "IOPlatformExpertDevice"])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    text.lines()
        .find(|l| l.contains("IOPlatformUUID"))
        .and_then(|l| l.split('"').nth(3))
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

// ---------------- 其它平台（仅开发期） ----------------

#[cfg(not(any(windows, target_os = "macos")))]
fn fingerprint() -> Option<Fingerprint> {
    let host = std::env::var("HOSTNAME").ok().filter(|h| !h.is_empty())?;
    Some(Fingerprint::make(Source::Weak, format!("weak:{host}|{SALT}")))
}

// ---------------- 对外 ----------------

/// 取不到指纹时返回空串——宁可让激活页显示"不可用"，也不要退化成一个人人相同的假码。
pub fn machine_code() -> String {
    fingerprint().map(|f| f.code()).unwrap_or_default()
}

/// 当前指纹来源，只给日志和自检用。取不到时返回 "none"。
pub fn source_name() -> &'static str {
    fingerprint().map(|f| f.source.as_str()).unwrap_or("none")
}

fn binding_of(machine: &str) -> Option<[u8; 6]> {
    let raw = b32_decode(&machine.replace(['-', ' '], ""))?;
    if raw.len() < 6 {
        return None;
    }
    let mut out = [0u8; 6];
    out.copy_from_slice(&raw[..6]);
    Some(out)
}

// ---------------- 日期 ----------------

fn today_offset() -> i64 {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    secs / 86400 - DAYS_TO_2026
}

fn ymd(days_from_1970: i64) -> String {
    let z = days_from_1970 + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as i64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}")
}

// ---------------- 验签 ----------------

pub fn verify_code(code: &str, machine: &str) -> Result<Status, String> {
    let raw = b32_decode(code)
        .ok_or_else(|| "注册码里有无法识别的字符，请整串复制，不要手打".to_string())?;
    if raw.len() != CODE_LEN {
        return Err(format!(
            "注册码长度不对（{} 位有效字符，应为 {}），可能复制时被截断了",
            raw.len(),
            CODE_LEN
        ));
    }
    if raw[0] != VER {
        // 不要报"发给另一台电脑"：v1 → v2 换了指纹算法，旧码在这台机器上也必然失败，
        // 误导性的错误文案会让买家以为是自己搞错了。
        return Err("这串注册码是旧版本格式（v0.5.0 及以前），请向客服索取新版注册码".into());
    }

    let exp_day = u16::from_be_bytes([raw[1], raw[2]]) as i64;
    let bound = &raw[3..9];
    let our = binding_of(machine).ok_or_else(|| "本机机器码异常，请重启程序".to_string())?;
    if bound != our {
        return Err("这串注册码是发给另一台电脑的，请用本机机器码重新申请".into());
    }

    let payload = &raw[..9];
    let sig_bytes = &raw[9..CODE_LEN];
    let key = VerifyingKey::from_bytes(&LICENSE_PUBKEY)
        .map_err(|_| "内置公钥损坏，请重新安装".to_string())?;
    let sig = Signature::from_slice(sig_bytes).map_err(|_| "注册码签名段损坏".to_string())?;
    key.verify(payload, &sig)
        .map_err(|_| "注册码校验失败，可能被改动过".to_string())?;

    let permanent = exp_day == 0;
    if !permanent && exp_day < today_offset() {
        return Err(format!(
            "这串注册码已于 {} 到期",
            ymd(DAYS_TO_2026 + exp_day)
        ));
    }

    Ok(Status {
        licensed: true,
        machine: machine.to_string(),
        source: fingerprint()
            .map(|f| f.source.as_str().to_string())
            .unwrap_or_else(|| "none".into()),
        permanent,
        expires: if permanent {
            None
        } else {
            Some(ymd(DAYS_TO_2026 + exp_day))
        },
        error: None,
    })
}

// ---------------- 授权文件 ----------------

fn license_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    use tauri::Manager;
    app.path().app_config_dir().ok().map(|d| d.join("license.lic"))
}

pub fn load(app: &tauri::AppHandle) -> Option<String> {
    let p = license_path(app)?;
    let text = std::fs::read_to_string(p).ok()?;
    let code = text.trim();
    if code.is_empty() {
        None
    } else {
        Some(code.to_string())
    }
}

pub fn store(app: &tauri::AppHandle, code: &str) -> Result<(), String> {
    let p = license_path(app).ok_or_else(|| "无法定位配置目录".to_string())?;
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("创建目录失败：{e}"))?;
    }
    std::fs::write(&p, code).map_err(|e| format!("写入授权文件失败：{e}"))
}

pub fn status(app: &tauri::AppHandle) -> Status {
    // 指纹只算一次：Windows 上它要读 SMBIOS 表和磁盘属性，没必要重复三次
    let fp = fingerprint();
    let machine = fp.as_ref().map(|f| f.code()).unwrap_or_default();
    let source = fp.as_ref().map(|f| f.source.as_str()).unwrap_or("none");

    if fp.is_none() {
        // 读不到任何硬件标识：不给假码，明确告知，让人来找客服而不是自己瞎试
        return Status {
            licensed: false,
            machine,
            source: source.to_string(),
            permanent: false,
            expires: None,
            error: Some(
                "本机无法读取硬件标识（虚拟机或极精简系统常见），请联系客服说明情况".into(),
            ),
        };
    }

    match load(app) {
        None => Status {
            licensed: false,
            machine,
            source: source.to_string(),
            permanent: false,
            expires: None,
            error: None,
        },
        Some(code) => match verify_code(&code, &machine) {
            Ok(s) => s,
            Err(e) => Status {
                licensed: false,
                machine,
                source: source.to_string(),
                permanent: false,
                expires: None,
                error: Some(e),
            },
        },
    }
}

// ---------------- 自检 ----------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base32_roundtrip() {
        for n in [1usize, 6, 9, 10, 73] {
            let data: Vec<u8> = (0..n).map(|i| (i as u8).wrapping_mul(37).wrapping_add(11)).collect();
            let enc = b32_encode(&data);
            assert_eq!(b32_decode(&enc).unwrap(), data, "roundtrip len={n}");
        }
    }

    #[test]
    fn machine_code_shape() {
        let mc = machine_code();
        assert_eq!(mc.len(), 19, "4+1+4+1+4+1+4 = 19");
        assert_eq!(mc.matches('-').count(), 3);
        let mut stripped = mc.clone();
        stripped.retain(|c| c != '-');
        assert_eq!(b32_decode(&stripped).unwrap().len(), 10);
    }

    #[test]
    fn rejects_garbage() {
        assert!(verify_code("hello", &machine_code()).is_err());
        assert!(verify_code("", &machine_code()).is_err());
        // 117 位但内容随机：长度对、签名错
        let junk = b32_encode(&[7u8; CODE_LEN]);
        assert!(verify_code(&junk, &machine_code()).is_err());
    }

    #[test]
    fn date_math() {
        assert_eq!(ymd(DAYS_TO_2026), "2026-01-01");
        assert_eq!(ymd(DAYS_TO_2026 + 365), "2027-01-01");
        assert_eq!(ymd(DAYS_TO_2026 + 304), "2026-11-01");
    }

    #[test]
    fn rejects_placeholder_uuids() {
        // 全 0 / 全 FF：规范说的"未提供"
        assert!(!uuid_trustworthy(&[0u8; 16]));
        assert!(!uuid_trustworthy(&[0xFFu8; 16]));
        // 585858…：ASCII 'X' 的重复填充，真实机器上出现过
        assert!(!uuid_trustworthy(&[0x58u8; 16]));
        // 参考 BIOS 默认值，数千块主板在报同一个值
        let ami = [
            0x00, 0x02, 0x00, 0x03, 0x00, 0x04, 0x00, 0x05, 0x00, 0x06, 0x00, 0x07, 0x00, 0x08,
            0x00, 0x09,
        ];
        assert_eq!(uuid_string(&ami), "03000200-0400-0500-0006-000700080009");
        assert!(!uuid_trustworthy(&ami));
        // 正常值要放行
        let ok = [
            0x4C, 0x4C, 0x45, 0x44, 0x00, 0x34, 0x5A, 0x10, 0x80, 0x47, 0xB8, 0xC0, 0x4F, 0x4E,
            0x32, 0x32,
        ];
        assert!(uuid_trustworthy(&ok), "{}", uuid_string(&ok));
    }

    #[test]
    fn uuid_byte_order_matches_wmic() {
        // 戴尔机器上 `wmic csproduct get uuid` 常见输出 4C4C4544-0034-5A10-8047-B8C04F4E3232。
        // SMBIOS 的前三个字段是小端，这里必须先翻回来才对得上——否则客服拿着两边
        // 不同的字符串互相怀疑，白查一轮。
        let raw = [
            0x44, 0x45, 0x4C, 0x4C, 0x34, 0x00, 0x10, 0x5A, 0x80, 0x47, 0xB8, 0xC0, 0x4F, 0x4E,
            0x32, 0x32,
        ];
        assert_eq!(uuid_string(&raw), "4C4C4544-0034-5A10-8047-B8C04F4E3232");
    }

    #[test]
    fn rejects_junk_disk_serials() {
        for junk in ["", "0", "N/A", "To Be Filled By O.E.M.", "000000000000", "default string"] {
            assert!(!disk_serial_trustworthy(junk), "不该采信：{junk:?}");
        }
        for ok in ["S3Z8NX0M123456", "WD-WCC4N1234567", " 5VM7ABCD  "] {
            assert!(disk_serial_trustworthy(ok), "被误拒：{ok:?}");
        }
    }

    #[test]
    fn sources_never_collide() {
        // 同一个 material、不同来源，必须算出不同的码。
        // 这条守住的是"降级模式不能复用正常模式的码"。
        let a = Fingerprint::make(Source::Smbios, "same".into()).code();
        let b = Fingerprint::make(Source::Weak, "same".into()).code();
        let c = Fingerprint::make(Source::Disk, "same".into()).code();
        assert_ne!(a, b);
        assert_ne!(b, c);
        assert_ne!(a, c);
    }

    #[test]
    fn tolerates_sloppy_paste() {
        // 买家从聊天窗复制常带着空格、换行、小写、连字符。
        // 这些都不该导致"格式不对"，而应该一路走到签名校验那步才失败。
        let junk = b32_encode(&[7u8; CODE_LEN]);
        let messy = format!("  {}\n", junk.to_lowercase());
        let err = verify_code(&messy, &machine_code()).unwrap_err();
        // 断言的是「没被格式检查挡下」，而不是某个具体错误——内容随实现演进，
        // 这里要守的不变量只有一条：格式层不能把合法格式的粘贴拒掉。
        assert!(
            !err.contains("无法识别") && !err.contains("长度不对"),
            "格式层误拒了：{err}"
        );
    }
}
