#!/usr/bin/env node
// 把 GitHub Release 的 Windows 产物拉到本地目录，并按 SHA256SUMS.txt 逐个校验。
//
// 为什么需要它：安装包/便携版只在 CI 的 Windows 机器上产出（Tauri 不支持从 macOS
// 交叉打包 Windows NSIS），产物只落在 GitHub Release，不会自动回本地。本地那份
// dist/windows 什么时候下的就是什么时候的版本，很容易拿着旧包去发。
//
// 用法：
//   node tools/fetch-release.mjs                # 最新 Release → ../../dist/windows
//   node tools/fetch-release.mjs --tag v0.5.1   # 指定版本
//   node tools/fetch-release.mjs --out /tmp/x   # 指定输出目录
//   node tools/fetch-release.mjs --dry-run      # 只看有什么，不下载

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = resolve(HERE, '..', '..', 'dist', 'windows');

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const tag = arg('tag');
const out = arg('out') ? resolve(String(arg('out'))) : DEFAULT_OUT;
const dryRun = process.argv.includes('--dry-run');

function gh(args, opts = {}) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

// 1) 定位 Release
// gh release view 不带 tag 时才取「最新」，传字面量 latest 会被当成 tag 名
const viewArgs = ['release', 'view'];
if (tag) viewArgs.push(String(tag));
viewArgs.push('--json', 'tagName,assets,isDraft,isPrerelease');
let info;
try {
  info = JSON.parse(gh(viewArgs));
} catch (e) {
  console.error(`读不到 Release（${tag || '最新'}）：${(e.stderr || e.message || '').trim()}`);
  console.error('检查 gh 是否已登录：gh auth status');
  process.exit(1);
}

const assets = (info.assets || []).filter((a) => !/^source code/i.test(a.name));
const tagName = info.tagName;

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex').toUpperCase();
}

// 2) 拿 Release 侧的校验表（176 B，先拉它比拉 3 MB 的包便宜）
//    必须按哈希比，不能只看体积：改一句文案后 exe 体积可能一模一样
//    （3,367,424 B 两次构建完全相同，但内容不同），按体积判会漏掉更新。
mkdirSync(out, { recursive: true });
const sumsAsset = assets.find((a) => /^SHA256SUMS\.txt$/i.test(a.name));
const expect = new Map();
if (sumsAsset) {
  // 直接落到输出目录：它本来就是要交付的三个附件之一，不必另建临时文件
  gh(['release', 'download', tagName, '-p', sumsAsset.name, '-D', out, '--clobber']);
  for (const line of readFileSync(join(out, sumsAsset.name), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([0-9A-Fa-f]{64})\s+\*?(.+)$/);
    if (m) expect.set(m[2].trim(), m[1].toUpperCase());
  }
}

// 3) 逐个比哈希，定出要下载的
const stale = [];
for (const a of assets) {
  if (a === sumsAsset) continue;
  const p = join(out, a.name);
  const want = expect.get(a.name);
  if (!existsSync(p)) {
    stale.push({ a, why: '本地没有' });
  } else if (want && sha256(p) !== want) {
    const sizeNote = readFileSync(p).length === a.size ? '体积相同但内容不同' : '体积也不同';
    stale.push({ a, why: `哈希不符（${sizeNote}）` });
  } else if (!want && readFileSync(p).length !== a.size) {
    stale.push({ a, why: `体积不符（Release ${a.size} B）` });
  }
}

console.log(`Release ${tagName}${info.isPrerelease ? '（预发布）' : ''}，${assets.length} 个产物 → ${out}`);
for (const a of assets) console.log(`  ${a.name}  ${a.size} B`);
if (!expect.size) console.log('\n⚠ Release 里没有 SHA256SUMS.txt，只能按体积判断。');
if (stale.length) {
  console.log('\n本地与 Release 不一致：');
  for (const s of stale) console.log(`  - ${s.a.name}：${s.why}`);
} else {
  console.log('\n本地已是最新（逐个哈希比对一致），无需下载。');
}

if (dryRun || stale.length === 0) process.exit(0);

// 4) 只下载不一致的（--clobber 覆盖同名旧文件）
for (const { a } of stale) {
  gh(['release', 'download', tagName, '-p', a.name, '-D', out, '--clobber']);
  console.log(`downloaded ${a.name}`);
}

// 5) 收尾全量复算，不通过就非零退出（别把坏包发出去）
const sumsPath = join(out, 'SHA256SUMS.txt');
if (!existsSync(sumsPath)) {
  console.error('\n没有 SHA256SUMS.txt，跳过校验。');
  process.exit(0);
}

let bad = 0;
const lines = readFileSync(sumsPath, 'utf8').split(/\r?\n/).filter(Boolean);
for (const line of lines) {
  const m = line.match(/^([0-9A-Fa-f]{64})\s+\*?(.+)$/);
  if (!m) continue;
  const [, expect, name] = m;
  const p = join(out, name.trim());
  if (!existsSync(p)) {
    console.error(`MISSING ${name}`);
    bad++;
    continue;
  }
  const got = createHash('sha256').update(readFileSync(p)).digest('hex');
  if (got.toLowerCase() === expect.toLowerCase()) {
    console.log(`OK    ${name}  ${got.slice(0, 8)}…`);
  } else {
    console.error(`FAIL  ${name}\n  期望 ${expect}\n  实际 ${got}`);
    bad++;
  }
}

if (bad) {
  console.error(`\n${bad} 项校验失败，不要发布这个目录里的包。`);
  process.exit(1);
}
console.log(`\n完成：${out} 与 Release ${tagName} 一致。`);
