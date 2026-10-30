// 把单文件交付物同步进前端目录：../dist/PPTPlayer.html -> web/index.html
//
// 单一事实来源仍是 PPTPlayer/wwwroot（源码）+ build-single.mjs（打包），
// 这里只做搬运，避免在仓库里另存一份手改过的 HTML。
import { copyFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = process.env.SRC || join(here, '..', '..', 'dist', 'PPTPlayer.html');
const dst = join(here, '..', 'web', 'index.html');

if (!existsSync(src)) {
  console.error(`找不到源文件：${src}\n先在 PPTPlayer/ 下跑 node build-web.mjs && node build-single.mjs`);
  process.exit(1);
}

copyFileSync(src, dst);
const kb = (statSync(dst).size / 1024).toFixed(0);
console.log(`✅ web/index.html  <-  ${src}  (${kb} KB)`);
