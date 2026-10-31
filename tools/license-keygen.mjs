#!/usr/bin/env node
// 离线注册码 · 生成与签发工具（作者侧，永不随包分发）
//
// 用法：
//   node tools/license-keygen.mjs init                    生成密钥对，写出 src-tauri/src/pubkey.rs
//   node tools/license-keygen.mjs sign <机器码> [--days N] 给某台机器出注册码
//   node tools/license-keygen.mjs verify <注册码> <机器码>  自检：这串码能不能在那台机器上激活
//   node tools/license-keygen.mjs show                    打印公钥指纹，核对线上包是不是这把钥匙
//
// 安全边界：
//   - 私钥在 tools/keys/license.key，**必须自己备份好**，丢了等于所有已售机器都不能换机。
//   - 私钥进不了仓库（.gitignore 已排除 tools/keys/），也绝不进安装包。
//   - 公钥是公开的，写在 src-tauri/src/pubkey.rs，随代码一起提交、一起编译。
import { generateKeyPairSync, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const KEYS = join(here, 'keys');
const PRIV = join(KEYS, 'license.key');
const PUB_RS = join(here, '..', 'src-tauri', 'src', 'pubkey.rs');
const PUB_DER = join(KEYS, 'license.pub.der');

// Crockford Base32：去掉 I L O U，避免手抄时 1/I、0/O 混淆
const ABC = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const VER = 2;   // v2 起指纹算法换成 SMBIOS 分级取源，与 license.rs 的 VER 必须一致

function encode(bytes) {
  let bits = 0, val = 0, out = '';
  for (const b of bytes) {
    val = (val << 8) | b; bits += 8;
    while (bits >= 5) out += ABC[(val >>> (bits -= 5)) & 31];
  }
  if (bits > 0) out += ABC[(val << (5 - bits)) & 31];
  return out;
}

function decode(str) {
  const clean = String(str).toUpperCase().replace(/[^0-9A-Z]/g, '')
    .replace(/I/g, '1').replace(/L/g, '1').replace(/O/g, '0').replace(/U/g, 'V');
  const out = [];
  let bits = 0, val = 0;
  for (const ch of clean) {
    const v = ABC.indexOf(ch);
    if (v < 0) throw new Error(`非法字符 ${ch}`);
    val = ((val << 5) | v) & 0xffff; bits += 5;
    if (bits >= 8) out.push((val >>> (bits -= 8)) & 0xff);
  }
  return Buffer.from(out);
}

function machineCodeToBytes(mc) {
  // 机器码是 16 字符 → 10 字节，取前 6 字节做绑定
  const raw = decode(mc);
  if (raw.length < 6) throw new Error(`机器码太短：${mc}`);
  return raw.subarray(0, 6);
}

function group(s, n = 5) {
  return s.replace(new RegExp(`(.{${n}})`, 'g'), '$1-').replace(/-$/, '');
}

// ---------------- init ----------------
function init() {
  if (existsSync(PRIV)) {
    console.log('私钥已存在，未覆盖（避免让已售注册码全部作废）');
    console.log('位置：' + PRIV);
    return show();
  }
  mkdirSync(KEYS, { recursive: true });
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privPem = privateKey.export({ format: 'pem', type: 'pkcs8' });
  const pubDer = publicKey.export({ format: 'der', type: 'spki' });
  writeFileSync(PRIV, privPem, { mode: 0o600 });
  writeFileSync(PUB_DER, pubDer);

  const raw = pubDer.subarray(pubDer.length - 32); // SPKI 末尾 32 字节就是原始公钥
  const arr = Array.from(raw).map((b) => '0x' + b.toString(16).padStart(2, '0')).join(', ');
  writeFileSync(PUB_RS, `// 由 tools/license-keygen.mjs 生成，请勿手改。
// 这是 Ed25519 **公钥**，可以公开；私钥在 tools/keys/license.key，永不入库。
pub const LICENSE_PUBKEY: [u8; 32] = [${arr}];
`);
  console.log('密钥对已生成');
  console.log('  私钥  ' + PRIV + '   ← 立刻备份，丢了所有已售机器都无法换机');
  console.log('  公钥  ' + PUB_RS);
  show();
}

function show() {
  const der = readFileSync(PUB_DER);
  const raw = der.subarray(der.length - 32);
  console.log('公钥指纹 ' + encode(raw).slice(0, 16).match(/.{4}/g).join('-'));
}

// ---------------- sign ----------------
function signCode(mc, opts) {
  if (!existsSync(PRIV)) throw new Error('找不到私钥，先跑 init');
  const key = createPrivateKey(readFileSync(PRIV));
  const days = Number(opts.days ?? 0);
  const fp = machineCodeToBytes(mc);

  const payload = Buffer.alloc(9);
  payload[0] = VER;
  // exp 字段是「相对 2026-01-01 的第几天」，0 表示永久
  const expDay = days > 0
    ? Math.floor((Date.now() - Date.UTC(2026, 0, 1)) / 86400000) + days
    : 0;
  payload.writeUInt16BE(Math.max(0, expDay), 1);
  fp.copy(payload, 3);

  const sig = sign(null, payload, key); // Ed25519 自带哈希，传入 null
  const code = encode(Buffer.concat([payload, sig]));
  return { code: group(code), payload };
}

// ---------------- verify（自检用，和 Rust 侧同一套规则） ----------------
function verifyCode(code, mc) {
  const der = readFileSync(PUB_DER);
  const pub = createPublicKey({ key: der, format: 'der', type: 'spki' });
  const raw = decode(code.replace(/-/g, ''));
  if (raw.length !== 73) throw new Error(`长度不对：${raw.length} 字节（应为 73）`);
  const payload = raw.subarray(0, 9);
  const sig = raw.subarray(9);
  if (payload[0] !== VER) throw new Error(`版本不支持：${payload[0]}`);
  const expDay = payload.readUInt16BE(1);
  const bound = payload.subarray(3, 9);
  const expect = machineCodeToBytes(mc);
  if (!bound.equals(expect)) throw new Error('注册码不是发给这台机器的');

  if (!verify(null, payload, pub, sig)) throw new Error('签名无效');

  if (expDay > 0) {
    const today = Math.floor((Date.now() - Date.UTC(2026, 0, 1)) / 86400000);
    if (today > expDay) throw new Error('注册码已过期');
  }
  return { 永久: expDay === 0, 到期日: expDay === 0 ? '—' : new Date(Date.UTC(2026, 0, 1) + expDay * 86400000).toISOString().slice(0, 10) };
}

// ---------------- CLI ----------------
const [, , cmd, ...rest] = process.argv;
const flag = (name) => {
  const i = rest.indexOf('--' + name);
  return i >= 0 ? rest[i + 1] : undefined;
};
const positional = rest.filter((a) => !a.startsWith('--'));

try {
  if (cmd === 'init') init();
  else if (cmd === 'show') show();
  else if (cmd === 'sign') {
    const mc = positional[0];
    if (!mc) throw new Error('用法：sign <机器码> [--days N]');
    const { code } = signCode(mc, { days: flag('days') });
    console.log('机器码  ' + mc.toUpperCase());
    console.log('注册码  ' + code);
    console.log('长度    ' + code.replace(/-/g, '').length + ' 字符');
    console.log(verifyCode(code, mc) ? '自检    通过' : '');
  } else if (cmd === 'verify') {
    const [code, mc] = positional;
    console.log(verifyCode(code, mc));
  } else {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 12).join('\n'));
  }
} catch (e) {
  console.error('失败：' + e.message);
  process.exit(1);
}
