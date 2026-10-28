import { build } from 'esbuild';
import { mkdir, copyFile, writeFile, rm } from 'node:fs/promises';
const outdir = new URL('./unpacked/', import.meta.url).pathname;
await rm(outdir, { recursive: true, force: true }); await mkdir(outdir, { recursive: true });
await build({ entryPoints: { background: 'src/background.mjs', dashboard: 'src/dashboard.mjs' }, outdir, bundle: true,
  format: 'esm', platform: 'browser', target: 'chrome120', minify: false, sourcemap: false, legalComments: 'eof', define: { 'process.env.NODE_ENV': '"production"' } });
await build({ entryPoints: ['src/content.mjs'], outfile: outdir + '/content.js', bundle: true, format: 'iife', platform: 'browser', target: 'chrome120' });
await copyFile('src/dashboard.html', outdir + '/dashboard.html'); await copyFile('src/dashboard.css', outdir + '/dashboard.css');
await copyFile('src/flap-bindings.js', outdir + '/flap-bindings.js');
await writeFile(outdir + '/manifest.json', JSON.stringify({ manifest_version: 3, minimum_chrome_version: '120', name: 'Agent Trade · BSC', version: '0.1.3',
  description: 'Four / Flap / Gang 一键交易，默认 0.001 BNB。独立客户端，不经过聊天模型。',
  permissions: ['storage', 'webRequest', 'declarativeNetRequestWithHostAccess'],
  host_permissions: ['https://www.binance.com/*', 'https://bsc-dataseed1.bnbchain.org/*'],
  background: { service_worker: 'background.js', type: 'module' }, action: { default_title: 'Agent Trade 设置与订单' },
  content_scripts: [
    { matches: ['https://flap.sh/apps/agent-bonding-curve*'], js: ['flap-bindings.js'], world: 'MAIN', run_at: 'document_idle', all_frames: false },
    { matches: ['https://four.meme/*', 'https://flap.sh/*', 'https://gang.fun/*'], js: ['content.js'], run_at: 'document_idle', all_frames: false },
  ],
  content_security_policy: { extension_pages: "script-src 'self'; object-src 'none'; base-uri 'none'" },
}, null, 2) + '\n');
console.log('Built unpacked/ — load this folder in chrome://extensions');
