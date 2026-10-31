// 授权闸门的前端连通性测试。
//
// 只测「前端有没有正确接线」：跳转、机器码展示、复制、成功/失败提示。
// 真正的签名校验在 Rust 侧，由 cargo test + --selftest 覆盖。
// 这里用 mock 的 window.__TAURI__ 模拟 IPC，所以在无头浏览器里就能跑。
//
// 用法：先起服务 `python3 -m http.server 8877`（在 desktop/web 下），再 node verify-gate.mjs
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://127.0.0.1:8877';
const MC = 'TEST-MC01-2345-6789';
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ok   ${name}${detail ? '  ← ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL ${name}  ← ${detail}`); }
};

const mock = () => {
  // Tauri 的 invoke 失败时 reject 的是字符串，这里照抄那个形状
  window.__TAURI__ = {
    core: {
      invoke: async (cmd, args) => {
        const licensed = localStorage.getItem('ok') === '1';
        // 可控的指纹状态：src=weak 模拟"只拿得到系统级标识"，nofp=1 模拟"什么都读不到"
        const source = localStorage.getItem('src') || 'smbios';
        const nofp = localStorage.getItem('nofp') === '1';
        const fp = {
          machine: nofp ? '' : 'TEST-MC01-2345-6789',
          source: nofp ? 'none' : source,
          error: nofp ? '本机无法读取硬件标识（虚拟机或极精简系统常见），请联系客服说明情况' : null,
        };
        if (cmd === 'license_status' || cmd === 'license_info') {
          return { licensed, machine: fp.machine, source: fp.source, permanent: true, expires: null, error: fp.error };
        }
        if (cmd === 'license_activate') {
          if (!args || !args.code) throw '注册码为空';
          if (args.code.includes('BAD')) throw '注册码校验失败，可能被改动过';
          localStorage.setItem('ok', '1');
          return { licensed: true, machine: 'TEST-MC01-2345-6789', permanent: true, expires: null, error: null };
        }
        throw 'unknown command: ' + cmd;
      },
    },
  };
};

const b = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
});

// ---- 用例 1：未授权 → 从播放器跳授权页 ----
{
  console.log('\n【未授权】');
  const ctx = await b.newContext({ viewport: { width: 1280, height: 860 } });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log('  PAGEERR', e.message.slice(0, 160)));
  await p.addInitScript(mock);
  await p.goto(BASE + '/index.html');
  await p.waitForTimeout(900);
  const url = p.url();
  check('未授权时离开播放器', url.endsWith('gate.html'), url.split('/').pop());
  const mc = (await p.textContent('#machine')) || '';
  check('授权页显示机器码', mc.includes(MC.slice(0, 4)), mc);
  check('输入框可见', await p.isVisible('#code'), '');
  check('激活按钮可用', !(await p.getAttribute('#go', 'disabled')), '');

  // 复制
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
  await p.click('#copy');
  await p.waitForTimeout(250);
  check('复制给出反馈', /已复制/.test(await p.textContent('#copy')), '');

  // 错误码
  await p.fill('#code', 'BADCODE');
  await p.click('#go');
  await p.waitForTimeout(350);
  const bad = (await p.textContent('#msg')) || '';
  check('错误码显示具体原因', /校验失败/.test(bad), bad);

  // 正确的码
  await p.fill('#code', '04001-22K9X-8HDZJ-KFETG-F2TQE');
  await p.click('#go');
  await p.waitForTimeout(1200);
  check('激活成功跳回播放器', p.url().endsWith('index.html'), p.url().split('/').pop());
  // 空窗口时工具条是隐藏的（还没打开文件），首屏可见的是拖放区
  check('播放器界面已渲染', await p.isVisible('#drop'), '');
  await ctx.close();
}

// ---- 用例 2：已授权 → 直接进播放器，不闪授权页 ----
{
  console.log('\n【已授权】');
  const ctx = await b.newContext({ viewport: { width: 1280, height: 860 } });
  await ctx.addInitScript(() => localStorage.setItem('ok', '1'));
  await ctx.addInitScript(mock);
  const p = await ctx.newPage();
  await p.goto(BASE + '/index.html');
  await p.waitForTimeout(900);
  check('不再跳转', p.url().endsWith('index.html'), p.url().split('/').pop());
  check('界面可见（闸门没有把它藏住）',
    await p.evaluate(() => getComputedStyle(document.documentElement).visibility === 'visible'), '');
  check('播放器拖放区可见', await p.isVisible('#drop'), '');
  await ctx.close();
}

// ---- 用例 3：没有 Tauri（单文件 HTML 场景）→ 不拦截 ----
{
  console.log('\n【单文件版 / 浏览器】');
  const ctx = await b.newContext({ viewport: { width: 1280, height: 860 } });
  const p = await ctx.newPage();
  await p.goto(BASE + '/index.html');
  await p.waitForTimeout(900);
  check('无 IPC 时不拦截', p.url().endsWith('index.html'), p.url().split('/').pop());
  check('界面正常（拖放区可见）', await p.isVisible('#drop'), '');
  await ctx.close();
}

// ---- 用例 4：指纹来源的界面反馈 ----
{
  console.log('\n【指纹来源】');
  const make = async (init) => {
    const ctx = await b.newContext({ viewport: { width: 1280, height: 860 } });
    if (init) await ctx.addInitScript(init);
    await ctx.addInitScript(mock);
    const p = await ctx.newPage();
    await p.goto(BASE + '/gate.html');
    await p.waitForTimeout(600);
    return { ctx, p };
  };

  // 正常来源：不该出现任何提示，别把普通用户吓一跳
  const a = await make(null);
  check('SMBIOS 来源不显示提示', !(await a.p.isVisible('#sourceHint')), '');
  check('SMBIOS 来源机器码正常', (await a.p.textContent('#machine')).includes('TEST'), '');
  await a.ctx.close();

  // 弱指纹：提示要出现，且文案要指向企业授权而不是"你机器有问题"
  const w = await make(() => localStorage.setItem('src', 'weak'));
  check('弱指纹显示提示', await w.p.isVisible('#sourceHint'), '');
  const hint = (await w.p.textContent('#sourceHint')) || '';
  check('弱指纹提示指向企业授权', /企业授权/.test(hint), hint.slice(0, 24) + '…');
  check('弱指纹仍可激活', !(await w.p.getAttribute('#go', 'disabled')), '');
  await w.ctx.close();

  // 读不到任何标识：不给假码、禁用激活
  const n = await make(() => localStorage.setItem('nofp', '1'));
  check('无指纹时机器码显示不可用', (await n.p.textContent('#machine')) === '不可用', '');
  check('无指纹时激活按钮禁用', (await n.p.getAttribute('#go', 'disabled')) !== null, '');
  check('无指纹时给出原因', /硬件标识/.test((await n.p.textContent('#msg')) || ''), '');
  await n.ctx.close();
}

await b.close();
console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
