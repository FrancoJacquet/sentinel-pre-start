// Placas del video (1920×1080 PNG) con la tipografía y la paleta de la UI:
//   node scripts/video/cards.mjs <carpeta-salida>
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = process.argv[2];
if (!out) {
  console.error('uso: node scripts/video/cards.mjs <carpeta-salida>');
  process.exit(2);
}
await mkdir(out, { recursive: true });

const fonts = fileURLToPath(new URL('../../apps/web/node_modules/@fontsource/', import.meta.url));
const face = (family, dir, w) =>
  `@font-face{font-family:'${family}';font-weight:${w};src:url('file://${fonts}${dir}/files/${dir}-latin-${w}-normal.woff2')}`;

const css = `
${face('Barlow Condensed', 'barlow-condensed', 600)}
${face('Barlow Condensed', 'barlow-condensed', 700)}
${face('Barlow Semi Condensed', 'barlow-semi-condensed', 400)}
${face('Barlow Semi Condensed', 'barlow-semi-condensed', 600)}
*{box-sizing:border-box;margin:0}
html,body{width:1920px;height:1080px}
body{background:#14181b;color:#eef0ee;font-family:'Barlow Semi Condensed',sans-serif;
  display:flex;flex-direction:column;justify-content:center;padding:0 180px;position:relative;overflow:hidden}
.stripe{position:absolute;left:0;right:0;bottom:0;height:22px;
  background:repeating-linear-gradient(-45deg,#e3a21a 0 28px,#22221f 28px 56px)}
h1{font:700 128px/1.02 'Barlow Condensed',sans-serif;letter-spacing:-0.5px}
h2{font:600 64px/1.1 'Barlow Condensed',sans-serif;color:#e3a21a;margin-top:28px}
p{font:400 40px/1.35 'Barlow Semi Condensed',sans-serif;color:#b9c1c5;margin-top:36px;max-width:1400px}
ul{list-style:none;padding:0;margin-top:44px}
li{font:600 50px/1.25 'Barlow Semi Condensed',sans-serif;padding:14px 0 14px 34px;border-left:8px solid #e3a21a;margin-bottom:22px}
li small{display:block;font:400 34px/1.3 'Barlow Semi Condensed',sans-serif;color:#b9c1c5}
.fine{position:absolute;left:180px;bottom:70px;font:400 30px/1.3 'Barlow Semi Condensed',sans-serif;color:#8d989e}
`;

const cards = {
  hook: `<h1>Someone restored the power.</h1><p>…while another person was still working on the machine.</p>`,
  problem: `<h1>Lockout / tagout</h1><p>A padlock is missing. The wrong circuit is switched on. Someone assumes the job is done.<br>The person at the switch often cannot see the person at risk.</p><div class="stripe"></div>`,
  title: `<h1>Sentinel</h1><h2>Look before you power.</h2><p>Right before power comes back, a camera checks the work zone. Meta's SAM 3.1 finds people in the image. Person or unknown ⇒ no energize.</p><div class="stripe"></div>`,
  built: `<h1>Built during the hackathon</h1><ul>
    <li>3D digital twin<small>Vue 3 + Babylon.js, CC0 assets</small></li>
    <li>Deterministic virtual PLC<small>every ENERGIZE is a new human authorization · unknown is never safe</small></li>
    <li>SAM 3.1 through the Meta Model API<small>one request at a time · hard spending cap · the model only sees pixels</small></li>
    <li>Muse Spark 1.3 writes the warnings<small>to the technician's simulated watch and the operator · it explains, it never decides</small></li>
  </ul>`,
  end: `<h1>It does not replace the lock.</h1><h2>It looks before you power.</h2><div class="fine">Sentinel · simulation, not a certified safety system. Real interlocks stay independent of AI.</div><div class="stripe"></div>`,
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
for (const [name, body] of Object.entries(cards)) {
  // Desde un archivo: una página about:blank no puede cargar fuentes file://.
  const html = join(out, `${name}.html`);
  await writeFile(html, `<!doctype html><html lang="en"><head><style>${css}</style></head><body>${body}</body></html>`);
  await page.goto(`file://${html}`);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(out, `${name}.png`) });
}
await browser.close();
console.log(Object.keys(cards).join(' '));
