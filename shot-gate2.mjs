import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const mk = async (src, out) => {
  const ctx = await b.newContext({ viewport: { width: 1180, height: 800 }, deviceScaleFactor: 2 });
  await ctx.addInitScript((s) => {
    window.__TAURI__ = { core: { invoke: async (cmd) => ({
      licensed: false, machine: 'BPQN-4BTV-GVRK-MXTC', source: s,
      permanent: false, expires: null, error: null }) } };
  }, src);
  const p = await ctx.newPage();
  await p.goto('http://127.0.0.1:8877/gate.html');
  await p.waitForTimeout(500);
  await p.screenshot({ path: out });
  await ctx.close();
};
await mk('weak', 'gate-weak.png');
await mk('smbios', 'gate-normal.png');
await b.close();
