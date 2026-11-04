import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAdapter, createExplainer, META_SPARK_SPEND_LEDGER, META_SPEND_LEDGER } from './adapter.ts';
import { loadConfig } from './config.ts';
import { fakeFrame } from './perception/test-frames.ts';

// Ningún test toca la red: el fetch es inyectado y cuenta llamadas.
function countingFetch() {
  let calls = 0;
  const fn = (async () => {
    calls++;
    return new Response(JSON.stringify({ status: 'completed', output_text: '' }));
  }) as unknown as typeof fetch;
  return { fn, calls: () => calls };
}

const explode = (async () => {
  throw new Error('network must not be used');
}) as unknown as typeof fetch;

async function tmpDir(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(join(tmpdir(), 'sentinel-adapter-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function lotoFrame() {
  const { simTruth: _t, ...f } = fakeFrame();
  return { ...f, sceneRevision: 'loto-v1' };
}

test('Meta apagada (default) ⇒ DisabledAdapter, sin red', async (t) => {
  const evidenceDir = await tmpDir(t);
  const adapter = createAdapter({ ...loadConfig({}), evidenceDir }, explode);
  assert.equal(adapter.id, 'disabled');
  const r = await adapter.analyze({ cameraId: 'cam-01', frame: lotoFrame(), signal: new AbortController().signal });
  assert.equal(r.status, 'INFERENCE_DISABLED');
  await assert.rejects(readFile(join(evidenceDir, META_SPEND_LEDGER)));
});

test('Meta prendida con tope ⇒ MetaSamAdapter con ledger en EVIDENCE_DIR/meta-spend.json y el tope de la config', async (t) => {
  const evidenceDir = await tmpDir(t);
  const config = { ...loadConfig({ META_API_ENABLED: 'true', MODEL_API_KEY: 'k-test', META_MAX_REQUESTS: '1' }), evidenceDir };
  const f = countingFetch();
  const adapter = createAdapter(config, f.fn);
  assert.equal(adapter.id, 'meta-sam-3.1');
  const input = { cameraId: 'cam-01', frame: lotoFrame(), signal: new AbortController().signal };
  assert.equal((await adapter.analyze(input)).status, 'NO_RISK_OBSERVED');
  const ledger = JSON.parse(await readFile(join(evidenceDir, META_SPEND_LEDGER), 'utf8'));
  assert.equal(ledger.requests, 1);
  // Tope 1 alcanzado: la segunda no sale.
  assert.equal((await adapter.analyze(input)).status, 'BUDGET_EXHAUSTED');
  assert.equal(f.calls(), 1);
  // Un reinicio (adaptador nuevo sobre el mismo ledger) tampoco resetea el tope.
  assert.equal((await createAdapter(config, f.fn).analyze(input)).status, 'BUDGET_EXHAUSTED');
  assert.equal(f.calls(), 1);
});

test('Spark apagado (default, aun con Meta prendida) ⇒ sin explicador', async (t) => {
  const evidenceDir = await tmpDir(t);
  assert.equal(createExplainer({ ...loadConfig({}), evidenceDir }, explode), null);
  const on = loadConfig({ META_API_ENABLED: 'true', MODEL_API_KEY: 'k-test', META_MAX_REQUESTS: '1' });
  assert.equal(createExplainer({ ...on, evidenceDir }, explode), null);
});

test('Spark prendido ⇒ ledger propio meta-spark-spend.json con su tope; el tope corta antes del fetch', async (t) => {
  const evidenceDir = await tmpDir(t);
  const config = {
    ...loadConfig({
      META_API_ENABLED: 'true',
      MODEL_API_KEY: 'k-test',
      META_MAX_REQUESTS: '5',
      META_SPARK_ENABLED: 'true',
      META_SPARK_MAX_REQUESTS: '1',
    }),
    evidenceDir,
  };
  const f = countingFetch();
  const explainer = createExplainer(config, f.fn);
  assert.ok(explainer);
  assert.equal(explainer.id, 'meta-muse-spark-1.3');
  const overlay = { width: 1280, height: 720, polygon: [[1, 2]] as [number, number][], persons: [] };
  const input = { cameraId: 'cam-01', frame: lotoFrame(), samStatus: 'NO_RISK_OBSERVED' as const, plcState: 'ENABLED' as const, overlay, signal: new AbortController().signal };
  // Salida vacía no es JSON: falla advisory, pero la solicitud ya contó.
  assert.equal((await explainer.explain(input)).ok, false);
  const ledger = JSON.parse(await readFile(join(evidenceDir, META_SPARK_SPEND_LEDGER), 'utf8'));
  assert.equal(ledger.requests, 1);
  assert.equal(ledger.last.model, 'muse-spark-1.3');
  // El ledger de SAM no se tocó.
  await assert.rejects(readFile(join(evidenceDir, META_SPEND_LEDGER)));
  // Tope 1 alcanzado, también tras un reinicio: no sale nada.
  const again = await createExplainer(config, f.fn)!.explain(input);
  assert.equal(again.ok, false);
  assert.match(again.reason ?? '', /spark budget 1\/1/);
  assert.equal(f.calls(), 1);
});
