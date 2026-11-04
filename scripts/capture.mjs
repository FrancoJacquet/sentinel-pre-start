// Captura de la UI para validación visual: node scripts/capture.mjs <url> <salida.png> [zone]
// Sin asserts: es una foto para aprobar a ojo, no un test.
// Espera atributos data-* (no textos): si cambia el idioma de la UI no se cuelga.
// CAPTURE_VIEWPORT=1920x1080 cambia el tamaño (default 1440x860, @2x).
import { chromium } from '@playwright/test';

const [url, out, mode] = process.argv.slice(2);
if (!url || !out) {
  console.error('uso: node scripts/capture.mjs <url> <salida.png> [zone]');
  process.exit(2);
}
const [width, height] = (process.env.CAPTURE_VIEWPORT ?? '1440x860').split('x').map(Number);
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 });
await page.goto(url);
await page.locator('[data-testid="connection"][data-conn="open"]').waitFor({ timeout: 60_000 });
// La escena está lista cuando conecta la cámara (antes de eso no hay nave).
await page.locator('[data-testid="camera-toggle"][data-camera="on"]').waitFor({ timeout: 400_000 });
if (mode === 'zone') {
  // dispatchEvent: sin GPU el canvas tarda en "estabilizarse" y click() espera de más.
  await page.getByTestId('op-to-zone').dispatchEvent('click');
  await page.locator('[data-testid="sim-truth"][data-inside="true"]').waitFor({ timeout: 400_000 });
}
await page.getByTestId('request-start').dispatchEvent('click');
await page.waitForTimeout(Number(process.env.SETTLE_MS ?? 2500));
await page.screenshot({ path: out, timeout: 600_000 });
await browser.close();
