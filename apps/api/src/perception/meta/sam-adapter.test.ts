import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSamRequest, extractOutputText, MetaSamAdapter, META_RESPONSES_URL, SAM_MODEL } from './sam-adapter.ts';
import { parseSamOutput } from './sam-output.ts';
import { SpendGuard } from './spend-guard.ts';
import { CAM01_ZONE, decideZone, pointInPolygon } from '../zone-rule.ts';
import { fakeFrame } from '../test-frames.ts';
import type { ModelFrame } from '../types.ts';

// SIMULACIÓN: respuestas armadas a mano con la gramática de la doc de SAM 3.1.
// No son salida del modelo; sólo prueban el parser y la regla.
const box = (id: number, x1: number, y1: number, x2: number, y2: number, c = 0.91) =>
  `${id}<|box;x1=${x1};y1=${y1};x2=${x2};y2=${y2};w=1280;h=720;c=${c}|><|mask;x=0;y=0;c=${c};data=40,80,!a|b>~;c|>`;
const IN_ZONE = `<0f>${box(0, 560, 200, 660, 560)}`;
const OUTSIDE = `<0f>${box(3, 200, 150, 280, 390)}`;

async function tmpGuard(maxRequests: number) {
  const dir = await mkdtemp(join(tmpdir(), 'sentinel-guard-'));
  const file = join(dir, 'meta-spend.json');
  return { guard: new SpendGuard({ file, maxRequests }), file };
}

function modelFrame(over: Partial<ModelFrame> = {}): ModelFrame {
  const { simTruth: _t, ...f } = fakeFrame();
  return { ...f, sceneRevision: 'loto-v1', ...over };
}

function fakeFetch(body: unknown, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const completed = (text: string) => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }] });

test('parser: lee id, caja y confianza; la máscara base85 con | y ; no rompe', () => {
  const boxes = parseSamOutput(`<0f>${box(0, 1, 2, 3, 4)},${box(2, 5, 6, 7, 8, 0.4)}`);
  assert.equal(boxes.length, 2);
  assert.deepEqual(
    boxes.map((b) => [b.objectId, b.x1, b.y2, b.c, b.hasMask]),
    [
      [0, 1, 4, 0.91, true],
      [2, 5, 8, 0.4, true],
    ],
  );
});

test('parser: salida vacía = cero coincidencias, no error', () => {
  assert.deepEqual(parseSamOutput(''), []);
});

test('parser: texto fuera de gramática ⇒ error (no se adivina)', () => {
  assert.throws(() => parseSamOutput('I see a person near the machine'));
  assert.throws(() => parseSamOutput('<0f>hola'));
  assert.throws(() => parseSamOutput(`<0f>${box(0, 1, 2, 3, 4)}basura`));
});

test('zona: el polígono calibrado contiene el apoyo del operario en la zona y no el de afuera', () => {
  assert.equal(pointInPolygon([610, 560], CAM01_ZONE.polygon), true);
  assert.equal(pointInPolygon([240, 390], CAM01_ZONE.polygon), false);
  // Pies del operario en loto-v1 (misma cámara y zona que crane-v1, proyectados): bajo la bobina, en el paso
  // peatonal fuera de la zona, y el gruista detrás de la estantería.
  assert.equal(pointInPolygon([644, 460], CAM01_ZONE.polygon), true);
  assert.equal(pointInPolygon([962, 674], CAM01_ZONE.polygon), false);
  assert.equal(pointInPolygon([878, 343], CAM01_ZONE.polygon), false);
});

test('regla: persona con el pie en la zona ⇒ RISK_OBSERVED; sólo afuera ⇒ NO_RISK_OBSERVED', () => {
  assert.equal(decideZone(parseSamOutput(IN_ZONE), CAM01_ZONE).status, 'RISK_OBSERVED');
  assert.equal(decideZone(parseSamOutput(`${OUTSIDE}`), CAM01_ZONE).status, 'NO_RISK_OBSERVED');
  assert.equal(decideZone([], CAM01_ZONE).status, 'NO_RISK_OBSERVED');
});

test('regla: caja de otro tamaño de frame ⇒ UNVERIFIED', () => {
  const boxes = parseSamOutput('<0f>0<|box;x1=1;y1=2;x2=3;y2=4;w=640;h=360|>');
  assert.equal(decideZone(boxes, CAM01_ZONE).status, 'UNVERIFIED');
});

test('adaptador apagado ⇒ INFERENCE_DISABLED sin tocar la red ni el contador, aunque haya key', async () => {
  const { guard, file } = await tmpGuard(5);
  const f = fakeFetch(completed(IN_ZONE));
  const adapter = new MetaSamAdapter({ enabled: false, apiKey: 'k-test', guard, zone: CAM01_ZONE, fetch: f.fn });
  const r = await adapter.analyze({ cameraId: 'cam-01', frame: modelFrame(), signal: new AbortController().signal });
  assert.equal(r.status, 'INFERENCE_DISABLED');
  assert.equal(f.calls.length, 0);
  await assert.rejects(readFile(file));
});

test('adaptador: request a la Responses API con sam-3.1, store:false y la imagen en data URL', async () => {
  const { guard } = await tmpGuard(1);
  const f = fakeFetch(completed(IN_ZONE));
  const adapter = new MetaSamAdapter({ enabled: true, apiKey: 'k-test', guard, zone: CAM01_ZONE, fetch: f.fn });
  const frame = modelFrame();
  const r = await adapter.analyze({ cameraId: 'cam-01', frame, signal: new AbortController().signal });
  assert.equal(r.status, 'RISK_OBSERVED');
  assert.equal(r.source, 'model');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0]!.url, META_RESPONSES_URL);
  const body = JSON.parse(String(f.calls[0]!.init.body));
  assert.equal(body.model, SAM_MODEL);
  assert.equal(body.store, false);
  assert.equal(body.stream, false);
  assert.deepEqual(body, buildSamRequest(frame.bytes.toString('base64')));
  assert.equal(SAM_MODEL.includes('contributor'), false);
});

test('tope: con el contador lleno ⇒ BUDGET_EXHAUSTED sin llamar; sobrevive reinicio', async () => {
  const { guard, file } = await tmpGuard(1);
  const f = fakeFetch(completed(''));
  const adapter = new MetaSamAdapter({ enabled: true, apiKey: 'k-test', guard, zone: CAM01_ZONE, fetch: f.fn });
  const input = { cameraId: 'cam-01', frame: modelFrame(), signal: new AbortController().signal };
  assert.equal((await adapter.analyze(input)).status, 'NO_RISK_OBSERVED');
  const again = new MetaSamAdapter({ enabled: true, apiKey: 'k-test', guard: new SpendGuard({ file, maxRequests: 1 }), zone: CAM01_ZONE, fetch: f.fn });
  assert.equal((await again.analyze(input)).status, 'BUDGET_EXHAUSTED');
  assert.equal(f.calls.length, 1);
});

test('tope: una solicitud fallida igual cuenta y no se reintenta', async () => {
  const { guard } = await tmpGuard(3);
  const f = fakeFetch({ error: { message: 'secret-ish detail' } }, 500);
  const adapter = new MetaSamAdapter({ enabled: true, apiKey: 'k-test', guard, zone: CAM01_ZONE, fetch: f.fn });
  await assert.rejects(
    adapter.analyze({ cameraId: 'cam-01', frame: modelFrame(), signal: new AbortController().signal }),
    (err: Error) => err.message === 'meta http 500',
  );
  assert.equal(f.calls.length, 1);
  assert.equal(await guard.used(), 1);
});

test('concurrencia 1: con una solicitud en vuelo la segunda no sale', async () => {
  const { guard } = await tmpGuard(5);
  let release!: () => void;
  let calls = 0;
  const slow = (async () => {
    calls++;
    await new Promise<void>((r) => (release = r));
    return new Response(JSON.stringify(completed('')));
  }) as unknown as typeof fetch;
  const adapter = new MetaSamAdapter({ enabled: true, apiKey: 'k-test', guard, zone: CAM01_ZONE, fetch: slow });
  const input = { cameraId: 'cam-01', frame: modelFrame(), signal: new AbortController().signal };
  const first = adapter.analyze(input);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal((await adapter.analyze(input)).status, 'UNVERIFIED');
  release();
  assert.equal((await first).status, 'NO_RISK_OBSERVED');
  assert.equal(calls, 1);
});

test('frame de otra revisión de escena ⇒ UNVERIFIED sin gastar', async () => {
  const { guard } = await tmpGuard(5);
  const f = fakeFetch(completed(IN_ZONE));
  const adapter = new MetaSamAdapter({ enabled: true, apiKey: 'k-test', guard, zone: CAM01_ZONE, fetch: f.fn });
  const r = await adapter.analyze({ cameraId: 'cam-01', frame: modelFrame({ sceneRevision: 'hall-v1' }), signal: new AbortController().signal });
  assert.equal(r.status, 'UNVERIFIED');
  assert.equal(f.calls.length, 0);
  assert.equal(await guard.used(), 0);
});

test('contador ilegible ⇒ error, no se asume cero', async () => {
  const { guard, file } = await tmpGuard(5);
  await writeFile(file, '{"requests":"mucho"}');
  await assert.rejects(guard.reserve(SAM_MODEL, 'f-x'), /corrupt/);
});

test('respuesta incompleta o con otro status ⇒ error', () => {
  assert.throws(() => extractOutputText({ status: 'failed', output: [] }));
  assert.throws(() => extractOutputText(null));
  assert.equal(extractOutputText({ output_text: '' }), '');
});

test('zona: CAM-01 calibrada para loto-v1 (misma cámara y ZONE que crane-v1, mismo polígono)', () => {
  assert.equal(CAM01_ZONE.sceneRevision, 'loto-v1');
  assert.deepEqual(CAM01_ZONE.polygon, [
    [526, 663],
    [869, 450],
    [684, 352],
    [361, 492],
  ]);
});

test('frame de crane-v1 ya no tiene calibración ⇒ UNVERIFIED sin gastar', async () => {
  const { guard } = await tmpGuard(5);
  const f = fakeFetch(completed(IN_ZONE));
  const adapter = new MetaSamAdapter({ enabled: true, apiKey: 'k-test', guard, zone: CAM01_ZONE, fetch: f.fn });
  const r = await adapter.analyze({ cameraId: 'cam-01', frame: modelFrame({ sceneRevision: 'crane-v1' }), signal: new AbortController().signal });
  assert.equal(r.status, 'UNVERIFIED');
  assert.equal(r.overlay ?? null, null);
  assert.equal(f.calls.length, 0);
});

test('overlay: cajas reales parseadas, pie, inZone y el polígono de la calibración', async () => {
  const { guard } = await tmpGuard(1);
  const f = fakeFetch(completed(`<0f>${box(0, 560, 200, 660, 560)},${box(3, 200, 150, 280, 390, 0.5)}`));
  const adapter = new MetaSamAdapter({ enabled: true, apiKey: 'k-test', guard, zone: CAM01_ZONE, fetch: f.fn });
  const r = await adapter.analyze({ cameraId: 'cam-01', frame: modelFrame(), signal: new AbortController().signal });
  assert.equal(r.status, 'RISK_OBSERVED');
  assert.deepEqual(r.overlay, {
    width: 1280,
    height: 720,
    polygon: CAM01_ZONE.polygon.map(([x, y]) => [x, y]),
    persons: [
      { x1: 560, y1: 200, x2: 660, y2: 560, c: 0.91, foot: [610, 560], inZone: true },
      { x1: 200, y1: 150, x2: 280, y2: 390, c: 0.5, foot: [240, 390], inZone: false },
    ],
  });
});

test('overlay: sin personas detectadas ⇒ polígono y lista vacía (lo que el modelo vio)', async () => {
  const { guard } = await tmpGuard(1);
  const adapter = new MetaSamAdapter({ enabled: true, apiKey: 'k-test', guard, zone: CAM01_ZONE, fetch: fakeFetch(completed('')).fn });
  const r = await adapter.analyze({ cameraId: 'cam-01', frame: modelFrame(), signal: new AbortController().signal });
  assert.equal(r.status, 'NO_RISK_OBSERVED');
  assert.deepEqual(r.overlay?.persons, []);
  assert.equal(r.overlay?.polygon.length, 4);
});

test('overlay: cajas de otro tamaño de frame ⇒ UNVERIFIED y sin overlay', async () => {
  const { guard } = await tmpGuard(1);
  const f = fakeFetch(completed('<0f>0<|box;x1=1;y1=2;x2=3;y2=4;w=640;h=360|>'));
  const adapter = new MetaSamAdapter({ enabled: true, apiKey: 'k-test', guard, zone: CAM01_ZONE, fetch: f.fn });
  const r = await adapter.analyze({ cameraId: 'cam-01', frame: modelFrame(), signal: new AbortController().signal });
  assert.equal(r.status, 'UNVERIFIED');
  assert.equal(r.overlay ?? null, null);
});

test('overlay: más de 32 personas ⇒ se recorta a 32 sin perder ninguna que pise la zona', async () => {
  const { guard } = await tmpGuard(1);
  const outside = Array.from({ length: 40 }, (_, i) => box(i, 200, 150, 280, 390));
  const text = `<0f>${[...outside, box(99, 560, 200, 660, 560)].join(',')}`;
  const adapter = new MetaSamAdapter({ enabled: true, apiKey: 'k-test', guard, zone: CAM01_ZONE, fetch: fakeFetch(completed(text)).fn });
  const r = await adapter.analyze({ cameraId: 'cam-01', frame: modelFrame(), signal: new AbortController().signal });
  assert.equal(r.status, 'RISK_OBSERVED');
  assert.equal(r.overlay?.persons.length, 32);
  assert.equal(r.overlay?.persons.filter((p) => p.inZone).length, 1);
});
