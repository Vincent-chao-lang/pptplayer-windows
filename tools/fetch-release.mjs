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

// 2) 和本地现状比一眼
const stale = [];
for (const a of assets) {
  const p = join(out, a.name);
  if (!existsSync(p)) stale.push(`${a.name}（本地没有）`);
  else {
    const local = readFileSync(p).length;
    if (local !== a.size) stale.push(`${a.name}（本地 ${local} B，Release ${a.size} B）`);
  }
}

console.log(`Release ${tagName}${info.isPrerelease ? '（预发布）' : ''}，${assets.length} 个产物 → ${out}`);
for (const a of assets) console.log(`  ${a.name}  ${a.size} B`);
if (stale.length) {
  console.log('\n本地与 Release 不一致：');
  for (const s of stale) console.log(`  - ${s}`);
} else {
  console.log('\n本地已是最新，无需下载。');
}

if (dryRun || stale.length === 0) process.exit(0);

// 3) 下载（--clobber 覆盖同名旧文件）
mkdirSync(out, { recursive: true });
for (const a of assets) {
  gh(['release', 'download', tagName, '-p', a.name, '-D', out, '--clobber']);
  console.log(`downloaded ${a.name}`);
}

// 4) 按 SHA256SUMS.txt 校验，不通过就非零退出（别把坏包发出去）
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
