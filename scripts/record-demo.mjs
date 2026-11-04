// Graba la demo de punta a punta en un Chromium headless con GPU real:
//   node scripts/record-demo.mjs <url> <carpeta-salida>
// Guarda cada frame del screencast (JPEG) con su timestamp y un events.json con
// el momento de cada paso, para cortar en edición. Cada ENERGIZE con Meta
// prendida es una llamada paga a SAM 3.1: este guion hace como mucho 2.
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const [url, out] = process.argv.slice(2);
if (!url || !out) {
  console.error('uso: node scripts/record-demo.mjs <url> <carpeta-salida>');
  process.exit(2);
}
const framesDir = join(out, 'frames');
await mkdir(framesDir, { recursive: true });

const browser = await chromium.launch({
  args: ['--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--enable-gpu'],
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
const cdp = await page.context().newCDPSession(page);

const t0 = Date.now();
const events = [];
const mark = (name) => {
  events.push({ name, t: (Date.now() - t0) / 1000 });
  console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s ${name}`);
};

const frames = [];
let n = 0;
const writes = [];
cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
  const file = `${String(n++).padStart(6, '0')}.jpg`;
  frames.push({ file, ts: metadata.timestamp });
  writes.push(writeFile(join(framesDir, file), Buffer.from(data, 'base64')));
  cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
});

const click = (id) => page.getByTestId(id).dispatchEvent('click');
const wait = (ms) => page.waitForTimeout(ms);
const state = (s, timeout = 40_000) =>
  page.locator(`[data-testid="plc-state"][data-state="${s}"]`).waitFor({ timeout });
const inside = (v) => page.locator(`[data-testid="sim-truth"][data-inside="${v}"]`).waitFor({ timeout: 60_000 });

await page.goto(url);
await page.locator('[data-testid="connection"][data-conn="open"]').waitFor({ timeout: 60_000 });
await page.locator('[data-testid="camera-toggle"][data-camera="on"]').waitFor({ state: 'attached', timeout: 120_000 });
await wait(2000);
await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
mark('start');

// Planos de apertura: general, seccionador, técnico.
await wait(6000);
mark('view-disconnect');
await page.keyboard.press('2');
await wait(5000);
mark('view-technician');
await page.keyboard.press('3');
await wait(5000);
mark('view-overview');
await page.keyboard.press('1');
await wait(3000);

// A: técnico en la zona ⇒ bloqueado.
mark('A-to-zone');
await click('op-to-zone');
await inside('true');
await wait(1500);
mark('A-energize');
await click('request-start');
await state('BLOCKED');
mark('A-blocked');
await wait(3000);
// Plano del técnico: el reloj de la muñeca recibe el aviso (fijo y después Spark).
mark('A-watch');
await page.keyboard.press('3');
await page.locator('[data-testid="wearable"][data-source="muse-spark-1.3"]').waitFor({ timeout: 20_000 }).catch(() => {});
mark('A-watch-spark');
await wait(5000);
await page.keyboard.press('1');
await wait(2000);

// B: el técnico sale, pedido nuevo ⇒ habilita y la grúa se mueve.
mark('B-out');
await click('op-out');
await inside('false');
await wait(1500);
mark('B-energize');
await click('request-start');
await state('RUNNING');
mark('B-running');
await wait(12000);
mark('B-deenergize');
await click('request-stop');
await state('STOPPED');
await wait(2000);

// C: cámara desconectada ⇒ UNKNOWN, bloquea sin llamar al modelo.
mark('C-disconnect');
await click('camera-toggle');
await wait(1500);
mark('C-energize');
await click('request-start');
await state('BLOCKED');
mark('C-blocked');
await wait(7000);
mark('end');

await cdp.send('Page.stopScreencast');
await Promise.all(writes);
await writeFile(join(out, 'frames.json'), JSON.stringify(frames));
await writeFile(join(out, 'events.json'), JSON.stringify(events, null, 2));
await browser.close();
console.log(`${frames.length} frames`);
