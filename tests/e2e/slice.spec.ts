import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { E2E_EVIDENCE_DIR } from './playwright.config.ts';

test('vertical slice: con la inferencia apagada no se energiza', async ({ page }, testInfo) => {
  // Con seta y RESET el recorrido suma un pedido más (~12 s cada uno sin GPU).
  test.setTimeout(300_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  // Calidad baja: el e2e corre sin GPU (SwiftShader); prueba comportamiento, no aspecto.
  await page.goto('/?quality=low');
  await expect(page.getByTestId('connection')).toHaveText('Virtual PLC connected');
  await expect(page.locator('canvas.scene')).toBeVisible();

  // La cámara se conecta sola cuando la escena está lista; sin modelo, "No model data"
  // en el panel del frame evaluado y la línea que explica qué hace Sentinel.
  await expect(page.getByTestId('camera-toggle')).toHaveText('Disconnect camera', { timeout: 120_000 });
  await expect(page.getByTestId('camera-no-data')).toHaveText('No model data');
  await expect(page.getByTestId('mission')).toContainText('Person or unknown ⇒ no energize');
  await expect(page.locator('header.bar')).toContainText('Simulation — not a safety system');
  await expect(page.getByTestId('plc-state')).toHaveAttribute('data-state', 'IDLE');

  // Con el operario fuera de la zona (verdad del simulador), igual no habilita:
  // no hay evidencia del modelo.
  await expect(page.getByTestId('sim-truth')).toContainText('outside');
  await page.getByTestId('request-start').click();
  // El pedido espera el frame de CAM-01 (lento sin GPU).
  await expect(page.getByTestId('plc-state')).toHaveAttribute('data-state', 'BLOCKED', { timeout: 60_000 });
  await expect(page.getByTestId('plc-reason')).toHaveAttribute('data-reason', 'INFERENCE_DISABLED');
  await expect(page.getByTestId('perception')).toHaveAttribute('data-verdict', 'unknown');
  await expect(page.getByTestId('log')).toContainText('inference is off');
  await expect(page.getByTestId('plc-state')).toContainText('Energization blocked');
  // Sin modelo no hay overlay: no se dibuja ninguna detección.
  await expect(page.getByTestId('camera-evaluated')).toHaveAttribute('data-overlay', 'none');
  await expect(page.getByTestId('overlay-person')).toHaveCount(0);
  await expect(page.getByTestId('camera-no-data')).toHaveText('No model data');

  // Aunque no haya modelo, el pedido capturó píxeles reales de CAM-01 y quedaron
  // como evidencia: JPEG 1280×720 con el hash que muestra el panel.
  const info = page.getByTestId('frame-info');
  await expect(info).toContainText('1280×720');
  const frameId = await info.getAttribute('data-frame-id');
  expect(frameId).toMatch(/^f-\d{8}T\d{9}-[0-9a-f]{6}$/);
  const jpg = await readFile(join(E2E_EVIDENCE_DIR, `${frameId}.jpg`));
  expect([...jpg.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
  const meta = JSON.parse(await readFile(join(E2E_EVIDENCE_DIR, `${frameId}.json`), 'utf8'));
  expect(meta.frame.sha256).toBe(createHash('sha256').update(jpg).digest('hex'));
  expect(meta.frame.width).toBe(1280);
  expect(meta.simulation).toEqual({ label: 'SIMULATION', truth: { operatorInZone: false } });
  await expect(info).toContainText(meta.frame.sha256.slice(0, 12));

  await page.waitForTimeout(500);
  await page.screenshot({ path: testInfo.outputPath('slice-blocked.png') });

  // Operario dentro de la zona: la verdad cambia, el veredicto sigue desconocido.
  await page.getByTestId('op-to-zone').click();
  await expect(page.getByTestId('sim-truth')).toContainText('inside', { timeout: 15_000 });
  await page.getByTestId('request-start').click();
  await expect(info).not.toHaveAttribute('data-frame-id', frameId!, { timeout: 60_000 });
  await expect(page.getByTestId('plc-reason')).toHaveAttribute('data-reason', 'INFERENCE_DISABLED');
  await expect(info).not.toHaveAttribute('data-frame-id', frameId!);
  const inside = await info.getAttribute('data-frame-id');
  const insideMeta = JSON.parse(await readFile(join(E2E_EVIDENCE_DIR, `${inside}.json`), 'utf8'));
  expect(insideMeta.simulation.truth.operatorInZone).toBe(true);

  // Bloqueado: ENERGIZE se puede apretar pero no está iluminada (verde prendido
  // es "habilitada/en marcha", nunca al lado de un piloto rojo).
  await expect(page.getByTestId('pendant-lamp')).toHaveAttribute('data-lamp', 'red');
  await expect(page.getByTestId('request-start')).toHaveAttribute('data-lit', 'false');
  // Ningún rechazo de protocolo en el registro (un frame tardío es dato, no error).
  await expect(page.getByTestId('log')).not.toContainText('Request rejected');

  // Seta de emergencia: queda enclavada y ENERGIZE no responde.
  await expect(page.getByTestId('request-start')).toBeEnabled();
  await expect(page.getByTestId('estop-reset')).toBeDisabled();
  await page.getByTestId('estop').click();
  await expect(page.getByTestId('pendant')).toHaveAttribute('data-latched', 'true');
  await expect(page.getByTestId('request-start')).toBeDisabled();
  await expect(page.getByTestId('pendant-lamp')).toHaveAttribute('data-lamp', 'red');
  await expect(page.getByTestId('log')).toContainText('Emergency stop latched');
  const latchedState = await page.getByTestId('plc-state').getAttribute('data-state');
  expect(['BLOCKED', 'STOPPED']).toContain(latchedState);

  // RESET: desenclava pero no energiza. El PLC no pasa a ENABLED ni RUNNING.
  await page.getByTestId('estop-reset').click();
  await expect(page.getByTestId('pendant')).toHaveAttribute('data-latched', 'false');
  await expect(page.getByTestId('request-start')).toBeEnabled();
  await page.waitForTimeout(1500);
  const afterReset = await page.getByTestId('plc-state').getAttribute('data-state');
  expect(['BLOCKED', 'STOPPED']).toContain(afterReset);
  await expect(info).toHaveAttribute('data-frame-id', inside!);

  // Después del RESET hace falta otro ENERGIZE, y con la inferencia apagada
  // sigue terminando bloqueada.
  await page.getByTestId('request-start').click();
  await expect(info).not.toHaveAttribute('data-frame-id', inside!, { timeout: 60_000 });
  await expect(page.getByTestId('plc-state')).toHaveAttribute('data-state', 'BLOCKED');
  await expect(page.getByTestId('plc-reason')).toHaveAttribute('data-reason', 'INFERENCE_DISABLED');

  // Sin cámara: NO_CAMERA.
  await page.getByTestId('camera-toggle').click();
  await page.getByTestId('request-start').click();
  await expect(page.getByTestId('plc-reason')).toHaveAttribute('data-reason', 'NO_CAMERA');
  await expect(page.getByTestId('request-stop')).toBeDisabled();
  await expect(page.getByTestId('camera-view')).toContainText('No signal');
  await page.screenshot({ path: testInfo.outputPath('slice-no-camera.png') });

  expect(errors).toEqual([]);
});
