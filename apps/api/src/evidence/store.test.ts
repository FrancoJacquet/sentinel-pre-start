import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { EvidenceStore } from './store.ts';
import { fakeFrame } from '../perception/test-frames.ts';

async function tempStore(maxFrames = 10) {
  const dir = await mkdtemp(join(tmpdir(), 'sentinel-evidence-'));
  return { dir, store: new EvidenceStore({ dir, maxFrames }), cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test('guarda el JPEG tal cual y un JSON con hash, metadatos y la evaluación', async (t) => {
  const { dir, store, cleanup } = await tempStore();
  t.after(cleanup);
  const frame = fakeFrame();
  await store.record(
    { cameraId: 'cam-01', status: 'INFERENCE_DISABLED', source: 'none', observedAt: null, detail: 'off', frame: null, overlay: null },
    frame,
    'disabled',
  );
  const jpg = await readFile(join(dir, `${frame.frameId}.jpg`));
  assert.equal(createHash('sha256').update(jpg).digest('hex'), frame.sha256);
  const meta = JSON.parse(await readFile(join(dir, `${frame.frameId}.json`), 'utf8'));
  assert.equal(meta.frame.sha256, frame.sha256);
  assert.equal(meta.evaluation.status, 'INFERENCE_DISABLED');
  assert.equal(meta.evaluation.adapter, 'disabled');
  // La verdad del simulador se guarda rotulada, separada de la evaluación.
  assert.deepEqual(meta.simulation, { label: 'SIMULATION', truth: { operatorInZone: false } });
});

test('evaluación sin frame (p. ej. NO_CAMERA) va al log, no crea imagen', async (t) => {
  const { dir, store, cleanup } = await tempStore();
  t.after(cleanup);
  await store.record(
    { cameraId: 'cam-01', status: 'NO_CAMERA', source: 'none', observedAt: null, detail: null, frame: null, overlay: null },
    null,
    'disabled',
  );
  const files = await readdir(dir);
  assert.deepEqual(files.filter((f) => f.endsWith('.jpg')), []);
  const log = await readFile(join(dir, 'evaluations.jsonl'), 'utf8');
  assert.match(log, /NO_CAMERA/);
});

test('retención: conserva sólo los últimos maxFrames frames', async (t) => {
  const { dir, store, cleanup } = await tempStore(3);
  t.after(cleanup);
  const ids: string[] = [];
  for (let i = 0; i < 5; i++) {
    const f = fakeFrame('cam-01', new Date(Date.parse('2026-10-27T12:00:00Z') + i * 1000));
    ids.push(f.frameId);
    await store.record(
      { cameraId: 'cam-01', status: 'INFERENCE_DISABLED', source: 'none', observedAt: null, detail: null, frame: null, overlay: null },
      f,
      'disabled',
    );
  }
  const jpgs = (await readdir(dir)).filter((f) => f.endsWith('.jpg')).sort();
  assert.deepEqual(jpgs, ids.slice(2).map((id) => `${id}.jpg`).sort());
});

test('un frameId con ruta se rechaza', async (t) => {
  const { store, cleanup } = await tempStore();
  t.after(cleanup);
  const f = { ...fakeFrame(), frameId: '../escape' };
  await assert.rejects(
    store.record(
      { cameraId: 'cam-01', status: 'INFERENCE_DISABLED', source: 'none', observedAt: null, detail: null, frame: null, overlay: null },
      f,
      'disabled',
    ),
  );
});

test('amend: agrega campos a la evaluación del frame, en fila, y lo anota en el log', async (t) => {
  const { dir, store, cleanup } = await tempStore();
  t.after(cleanup);
  const frame = fakeFrame();
  await store.record(
    { cameraId: 'cam-01', status: 'RISK_OBSERVED', source: 'model', observedAt: null, detail: null, frame: null, overlay: null },
    frame,
    'sam',
  );
  await Promise.all([store.amend(frame.frameId, { wearable: [{ source: 'template' }] }), store.amend(frame.frameId, { sparkNote: 'n' })]);
  const meta = JSON.parse(await readFile(join(dir, `${frame.frameId}.json`), 'utf8'));
  assert.equal(meta.evaluation.status, 'RISK_OBSERVED');
  assert.deepEqual(meta.evaluation.wearable, [{ source: 'template' }]);
  assert.equal(meta.evaluation.sparkNote, 'n');
  const log = (await readFile(join(dir, 'evaluations.jsonl'), 'utf8')).trim().split('\n');
  assert.equal(log.length, 3);
});

test('amend sobre un frame ya podado: sólo la línea del log; frameId inseguro se rechaza', async (t) => {
  const { dir, store, cleanup } = await tempStore();
  t.after(cleanup);
  await store.amend('f-gone', { sparkNote: null });
  assert.deepEqual((await readdir(dir)).filter((f) => f.endsWith('.json')), []);
  await assert.rejects(store.amend('../x', {}));
});
