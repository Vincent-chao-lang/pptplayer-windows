// 外壳行为校验：右键菜单屏蔽、看源码快捷键、授权有效期的界面显示。
//
// 为什么要单独一个脚本：这几件事都在「桌面版才有的那条路径」上——
// 授权信息来自 Tauri IPC，本机（macOS）跑不了真的 Windows exe，
// 所以用 addInitScript 注入一个假 window.__TAURI__，把后端返回固定成三种形态，
// 只验前端拿到这些数据后怎么显示、怎么拦。
//
// 用法: node verify-shell.mjs

import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_URL = 'file://' + path.resolve(HERE, 'web', 'index.html');
const SINGLE_URL = 'file://' + path.resolve(HERE, '..', 'dist', 'PPTPlayer.html');

// 用「今天 + N 天」造到期日，避免写死日期后过一阵子测试自己失效
function inDays(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const EXPIRING = inDays(12);
const FAR = inDays(300);

const results = [];
const check = (name, ok, extra = '') => results.push([name, ok, extra]);

const browser = await chromium.launch({ executablePath: CHROME });

/** 打开主窗口，注入假的 Tauri 后端 */
async function openApp(status) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message.slice(0, 160)));
  await page.addInitScript((st) => {
    window.__TAURI__ = {
      core: {
        invoke: async (cmd) => {
          if (cmd === 'license_status' || cmd === 'license_activate') return st;
          throw new Error('unexpected command: ' + cmd);
        },
      },
    };
  }, status);
  await page.goto(APP_URL);
  await page.waitForFunction(() => typeof window.__pptState === 'function', null, { timeout: 15000 });
  await page.waitForTimeout(400);          // 等 license_status 的 promise 落地
  return { page, errs };
}

/** 关掉整页请求，免得 file:// 下的相对资源被当成外链 */
const base = { licensed: true, machine: 'BPQN-4BTV-GVRK-MXTC', source: 'smbios', error: null };

// ---------- 1. 有期限：关于面板要写明到期日与剩余天数 ----------
{
  const { page, errs } = await openApp({ ...base, permanent: false, expires: EXPIRING });
  await page.evaluate(() => window.__pptAbout(true));
  await page.waitForTimeout(200);
  const s = await page.evaluate(() => window.__pptState());
  check('有期限：关于面板出现「授权」行', /授权/.test(s.aboutText), s.aboutText.slice(0, 120));
  check('有期限：写明到期日与剩余天数',
    s.aboutText.includes(EXPIRING) && /剩\s*12\s*天/.test(s.aboutText),
    s.aboutText.match(/有效期至[^｜\n]{0,40}/)?.[0] || '');
  const warn = await page.evaluate(() =>
    !!document.querySelector('#aboutMeta .warn'));
  check('有期限：剩余 ≤30 天标黄', warn === true, String(warn));
  const tip = await page.evaluate(() => {
    const t = document.getElementById('licTip');
    return { show: t.classList.contains('show'), text: t.textContent };
  });
  check('有期限：启动时提示一次到期日',
    tip.show === true && tip.text.includes(EXPIRING), tip.text);
  check('有期限：无 JS 报错', errs.length === 0, errs.join(' | '));
  await page.close();
}

// ---------- 2. 永久授权：写「永久」，且不要弹出到期提示 ----------
{
  const { page } = await openApp({ ...base, permanent: true, expires: null });
  await page.evaluate(() => window.__pptAbout(true));
  await page.waitForTimeout(200);
  const s = await page.evaluate(() => window.__pptState());
  check('永久：关于面板写「永久」', /永久/.test(s.aboutText), '');
  check('永久：不出现"剩 N 天"', !/剩\s*\d+\s*天/.test(s.aboutText), '');
  const tip = await page.evaluate(() =>
    document.getElementById('licTip').classList.contains('show'));
  check('永久：不弹到期提示', tip === false, String(tip));
  const warn = await page.evaluate(() => !!document.querySelector('#aboutMeta .warn'));
  check('永久：授权行不标黄', warn === false, String(warn));
  await page.close();
}

// ---------- 3. 远期到期（300 天）：显示到期日但不标黄、不提示 ----------
{
  const { page } = await openApp({ ...base, permanent: false, expires: FAR });
  await page.evaluate(() => window.__pptAbout(true));
  await page.waitForTimeout(200);
  const s = await page.evaluate(() => window.__pptState());
  check('远期：显示到期日', s.aboutText.includes(FAR), '');
  const warn = await page.evaluate(() => !!document.querySelector('#aboutMeta .warn'));
  check('远期：不标黄（>30 天）', warn === false, String(warn));
  const tip = await page.evaluate(() =>
    document.getElementById('licTip').classList.contains('show'));
  check('远期：不弹到期提示', tip === false, String(tip));
  await page.close();
}

// ---------- 4. 右键与看源码快捷键要被吃掉 ----------
{
  const { page } = await openApp({ ...base, permanent: true, expires: null });
  const ctx = await page.evaluate(() => {
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    document.getElementById('stage').dispatchEvent(ev);
    return ev.defaultPrevented;
  });
  check('右键菜单被屏蔽（画面区域）', ctx === true, String(ctx));

  const ctx2 = await page.evaluate(() => {
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    document.getElementById('toolbar').dispatchEvent(ev);
    return ev.defaultPrevented;
  });
  check('右键菜单被屏蔽（工具栏）', ctx2 === true, String(ctx2));

  const keys = await page.evaluate(() => {
    const fire = (init) => {
      const ev = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
      window.dispatchEvent(ev);
      return ev.defaultPrevented;
    };
    return {
      f12: fire({ key: 'F12' }),
      devtools: fire({ key: 'I', ctrlKey: true, shiftKey: true }),
      console: fire({ key: 'J', ctrlKey: true, shiftKey: true }),
      viewSource: fire({ key: 'u', ctrlKey: true }),
      // 对照：正常翻页键不能被误伤
      next: fire({ key: 'ArrowRight' }),
    };
  });
  check('F12 被吃掉', keys.f12 === true, '');
  check('Ctrl+Shift+I 被吃掉', keys.devtools === true, '');
  check('Ctrl+Shift+J 被吃掉', keys.console === true, '');
  check('Ctrl+U 被吃掉', keys.viewSource === true, '');
  check('翻页键未被误伤（→ 不 preventDefault）', keys.next === false, String(keys.next));
  await page.close();
}

// ---------- 5. 单文件版：没有 __TAURI__ 就不该出现授权行 ----------
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message.slice(0, 160)));
  await page.goto(SINGLE_URL);
  await page.waitForFunction(() => typeof window.__pptState === 'function', null, { timeout: 15000 });
  await page.evaluate(() => window.__pptAbout(true));
  await page.waitForTimeout(200);
  const s = await page.evaluate(() => window.__pptState());
  check('单文件版：不显示授权行（无授权概念）', !/授权/.test(s.aboutText), s.aboutText.slice(0, 80));
  const ctx = await page.evaluate(() => {
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    document.getElementById('stage').dispatchEvent(ev);
    return ev.defaultPrevented;
  });
  check('单文件版：右键同样被屏蔽', ctx === true, String(ctx));
  check('单文件版：无 JS 报错', errs.length === 0, errs.join(' | '));
  await page.close();
}

let pass = 0;
for (const [name, ok, extra] of results) {
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? '  ' + extra : ''}`);
  if (ok) pass++;
}
console.log(`\nshell: ${pass}/${results.length} 通过`);
await browser.close();
process.exit(pass === results.length ? 0 : 1);
