// 截图：带有效期的关于面板 + 到期提示条。
// 用桌面版页面（web/index.html）并注入假 __TAURI__，把授权固定成「12 天后到期」。
// 用法: node shot-license.mjs
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const url = 'file://' + path.resolve(HERE, 'web', 'index.html');

const d = new Date();
d.setDate(d.getDate() + 12);
const p2 = (x) => String(x).padStart(2, '0');
const expires = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;

const b = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
});
const page = await b.newPage({ viewport: { width: 1280, height: 800 } });

await page.addInitScript((exp) => {
  window.__TAURI__ = {
    core: {
      invoke: async (cmd) => {
        if (cmd === 'license_status' || cmd === 'license_activate') {
          return {
            licensed: true,
            machine: 'BPQN-4BTV-GVRK-MXTC',
            source: 'smbios',
            permanent: false,
            expires: exp,
            error: null,
          };
        }
        throw new Error('unexpected: ' + cmd);
      },
    },
  };
}, expires);

await page.goto(url);
await page.waitForFunction(() => typeof window.__pptState === 'function', null, { timeout: 15000 });
await page.waitForTimeout(700);
await page.screenshot({ path: 'shot-lictip.png' });

await page.evaluate(() => window.__pptAbout(true));
await page.waitForTimeout(400);
await page.screenshot({ path: 'shot-about-license.png' });

await b.close();
console.log('shot-lictip.png / shot-about-license.png  expires=' + expires);
