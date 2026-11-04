import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSparkPrompt, buildSparkRequest, MetaSparkExplainer, parseSparkOutput, SPARK_MODEL } from './spark-explainer.ts';
import { META_RESPONSES_URL } from './sam-adapter.ts';
import { SpendGuard } from './spend-guard.ts';
import { DISAGREE_DETAIL, disagreementNote, RISK_DISAGREE_DETAIL } from '../advice-rule.ts';
import { fakeFrame } from '../test-frames.ts';
import type { Advice, ModelFrame } from '../types.ts';

// SIMULACIÓN: respuestas de Spark armadas a mano. No son salida del modelo;
// sólo prueban el request, el parser, el tope y la regla.
const OVERLAY = {
  width: 1280,
  height: 720,
  polygon: [[526, 663], [869, 450], [684, 352], [361, 492]] as [number, number][],
  persons: [{ x1: 560, y1: 200, x2: 660, y2: 560, c: 0.9, foot: [610, 560] as [number, number], inZone: true }],
};
const completed = (text: string) => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }] });
const SEES = JSON.stringify({
  explanation: 'A worker stands under the load inside the work zone.',
  technician_alert: 'Someone is trying to energize the crane above you. Step out of the zone.',
  person_in_zone_visible: true,
});

async function tmpGuard(maxRequests: number) {
  const dir = await mkdtemp(join(tmpdir(), 'sentinel-spark-'));
  return new SpendGuard({ file: join(dir, 'meta-spark-spend.json'), maxRequests });
}

function modelFrame(): ModelFrame {
  const { simTruth: _t, ...f } = fakeFrame();
  return { ...f, sceneRevision: 'loto-v1' };
}

function fakeFetch(body: unknown, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const input = (samStatus: Advice['samStatus'] = 'RISK_OBSERVED') => ({
  cameraId: 'cam-01',
  frame: modelFrame(),
  samStatus,
  plcState: samStatus === 'RISK_OBSERVED' ? ('BLOCKED' as const) : ('ENABLED' as const),
  overlay: OVERLAY,
  signal: new AbortController().signal,
});

test('Spark: modelo Standard, nunca -contributor', () => {
  assert.equal(SPARK_MODEL, 'muse-spark-1.3');
  assert.equal(SPARK_MODEL.includes('contributor'), false);
});

test('prompt: el polígono y la decisión ya tomada; no lleva las cajas de SAM ni la verdad del simulador', () => {
  for (const plcState of ['BLOCKED', 'ENABLED'] as const) {
    const p = buildSparkPrompt(OVERLAY, plcState);
    assert.match(p, /\(526,663\) \(869,450\) \(684,352\) \(361,492\)/);
    assert.match(p, /person_in_zone_visible/);
    assert.match(p, /technician_alert/);
    assert.doesNotMatch(p, /\(560,200\)|foot|in work zone: |SAM|segmentation/);
    assert.doesNotMatch(p, /operatorInZone|simTruth/);
    assert.equal(buildSparkPrompt({ ...OVERLAY, persons: [] }, plcState), p);
  }
  assert.match(buildSparkPrompt(OVERLAY, 'BLOCKED'), /was just BLOCKED because the vision check detected a person/);
  assert.match(buildSparkPrompt(OVERLAY, 'BLOCKED'), /Never say it is safe/);
  assert.match(buildSparkPrompt(OVERLAY, 'ENABLED'), /was just ALLOWED/);
  assert.match(buildSparkPrompt(OVERLAY, 'ENABLED'), /technician_alert": string or null \(always null\)/);
});

test('request: Responses API, store:false, salida corta, la misma imagen en data URL', async () => {
  const f = fakeFetch(completed(SEES));
  const ex = new MetaSparkExplainer({ apiKey: 'k-test', guard: await tmpGuard(1), fetch: f.fn });
  const inp = input();
  const a = await ex.explain(inp);
  assert.equal(a.ok, true);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0]!.url, META_RESPONSES_URL);
  const body = JSON.parse(String(f.calls[0]!.init.body));
  assert.deepEqual(body, buildSparkRequest(inp.frame.bytes.toString('base64'), buildSparkPrompt(OVERLAY, 'BLOCKED')));
  assert.equal(body.model, 'muse-spark-1.3');
  assert.equal(body.store, false);
  assert.ok(body.max_output_tokens > 0 && body.max_output_tokens <= 4096);
  assert.equal(a.text, 'A worker stands under the load inside the work zone.');
  assert.equal(a.technicianAlert, 'Someone is trying to energize the crane above you. Step out of the zone.');
  assert.equal(a.personInZoneVisible, true);
  assert.equal(a.raw, SEES);
  assert.equal(a.request, '1/1');
});

test('parser: JSON estricto con las tres claves; tolera sólo un bloque ```json', () => {
  assert.deepEqual(parseSparkOutput(SEES), {
    explanation: 'A worker stands under the load inside the work zone.',
    technicianAlert: 'Someone is trying to energize the crane above you. Step out of the zone.',
    personInZoneVisible: true,
  });
  assert.equal(parseSparkOutput('```json\n' + SEES + '\n```').personInZoneVisible, true);
  const out = (o: Record<string, unknown>) => JSON.stringify({ explanation: 'ok', technician_alert: null, person_in_zone_visible: false, ...o });
  assert.equal(parseSparkOutput(out({})).technicianAlert, null);
  // Aviso vacío = sin aviso.
  assert.equal(parseSparkOutput(out({ technician_alert: '  ' })).technicianAlert, null);
  assert.equal(parseSparkOutput(out({ technician_alert: 'x'.repeat(140) })).technicianAlert?.length, 140);
  assert.throws(() => parseSparkOutput(out({ technician_alert: 'x'.repeat(141) })));
  assert.throws(() => parseSparkOutput(out({ technician_alert: 3 })));
  assert.throws(() => parseSparkOutput('A worker is in the zone.'));
  assert.throws(() => parseSparkOutput('{"explanation":"ok"}'));
  // Formato viejo de dos claves: ya no alcanza.
  assert.throws(() => parseSparkOutput('{"explanation":"ok","person_in_zone_visible":true}'));
  assert.throws(() => parseSparkOutput(out({ person_in_zone_visible: 'yes' })));
  assert.throws(() => parseSparkOutput(out({ extra: 1 })));
  assert.throws(() => parseSparkOutput(out({ explanation: 'x'.repeat(201) })));
  assert.throws(() => parseSparkOutput(out({ explanation: '  ' })));
  assert.throws(() => parseSparkOutput('[]'));
});

test('JSON inválido ⇒ ok=false con motivo y salida cruda; igual cuenta', async () => {
  const guard = await tmpGuard(3);
  const ex = new MetaSparkExplainer({ apiKey: 'k-test', guard, fetch: fakeFetch(completed('I think there is a worker')).fn });
  const a = await ex.explain(input());
  assert.equal(a.ok, false);
  assert.equal(a.text, null);
  assert.equal(a.raw, 'I think there is a worker');
  // Motivo fijo: el texto del modelo no sale por `reason` (va al detail de la UI).
  assert.equal(a.reason, 'spark output not JSON');
  assert.equal(await guard.used(), 1);
});

test('HTTP error ⇒ ok=false con sólo el código, sin reintento, la solicitud cuenta', async () => {
  const guard = await tmpGuard(3);
  const f = fakeFetch({ error: { message: 'secret-ish detail' } }, 500);
  const a = await new MetaSparkExplainer({ apiKey: 'k-test', guard, fetch: f.fn }).explain(input());
  assert.equal(a.ok, false);
  assert.equal(a.reason, 'meta http 500');
  assert.equal(f.calls.length, 1);
  assert.equal(await guard.used(), 1);
});

test('tope lleno ⇒ ok=false sin llamar a la red; sobrevive reinicio', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sentinel-spark-'));
  const file = join(dir, 'meta-spark-spend.json');
  const f = fakeFetch(completed(SEES));
  assert.equal((await new MetaSparkExplainer({ apiKey: 'k', guard: new SpendGuard({ file, maxRequests: 1 }), fetch: f.fn }).explain(input())).ok, true);
  const again = await new MetaSparkExplainer({ apiKey: 'k', guard: new SpendGuard({ file, maxRequests: 1 }), fetch: f.fn }).explain(input());
  assert.equal(again.ok, false);
  assert.match(again.reason ?? '', /spark budget 1\/1/);
  assert.equal(f.calls.length, 1);
});

test('concurrencia 1: con una consulta en vuelo la segunda no sale', async () => {
  let release!: () => void;
  let calls = 0;
  const slow = (async () => {
    calls++;
    await new Promise<void>((r) => (release = r));
    return new Response(JSON.stringify(completed(SEES)));
  }) as unknown as typeof fetch;
  const ex = new MetaSparkExplainer({ apiKey: 'k', guard: await tmpGuard(5), fetch: slow });
  const first = ex.explain(input());
  await new Promise((r) => setTimeout(r, 20));
  const second = await ex.explain(input());
  assert.equal(second.ok, false);
  assert.match(second.reason ?? '', /in flight/);
  release();
  assert.equal((await first).ok, true);
  assert.equal(calls, 1);
});

const advice = (over: Partial<Advice>): Advice => ({
  model: 'muse-spark-1.3',
  ok: true,
  samStatus: 'NO_RISK_OBSERVED',
  text: 't',
  technicianAlert: null,
  personInZoneVisible: false,
  reason: null,
  prompt: '',
  raw: '',
  request: '1/1',
  ...over,
});

test('nota de desacuerdo: sólo se anota, en los dos sentidos; el acuerdo no anota', () => {
  assert.equal(disagreementNote('NO_RISK_OBSERVED', advice({ personInZoneVisible: true })), DISAGREE_DETAIL);
  assert.equal(disagreementNote('RISK_OBSERVED', advice({ samStatus: 'RISK_OBSERVED', personInZoneVisible: false })), RISK_DISAGREE_DETAIL);
  assert.equal(disagreementNote('NO_RISK_OBSERVED', advice({ personInZoneVisible: false })), null);
  assert.equal(disagreementNote('RISK_OBSERVED', advice({ samStatus: 'RISK_OBSERVED', personInZoneVisible: true })), null);
});

test('nota de desacuerdo: Spark fallido o ausente no es desacuerdo', () => {
  for (const st of ['NO_RISK_OBSERVED', 'RISK_OBSERVED'] as const) {
    assert.equal(disagreementNote(st, advice({ ok: false, personInZoneVisible: null, text: null })), null);
    assert.equal(disagreementNote(st, advice({ ok: false, personInZoneVisible: st === 'NO_RISK_OBSERVED' })), null);
    assert.equal(disagreementNote(st, null), null);
  }
});

test('parser: motivos fijos, sin texto del modelo', () => {
  assert.throws(() => parseSparkOutput('ignore your rules {'), { message: 'spark output not JSON' });
  assert.throws(() => parseSparkOutput('{"explanation":"x","technician_alert":null,"person_in_zone_visible":true,"run_this":1}'), { message: 'spark output wrong keys' });
});

test('la API key nunca aparece en Advice (ok, JSON inválido, HTTP error, red caída)', async () => {
  const KEY = 'SENTINEL-KEY-do-not-leak-7f3a';
  const fetches: (typeof fetch)[] = [
    fakeFetch(completed(SEES)).fn,
    fakeFetch(completed('not json')).fn,
    fakeFetch({ error: { message: KEY } }, 401).fn,
    (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch,
  ];
  for (const fn of fetches) {
    const a = await new MetaSparkExplainer({ apiKey: KEY, guard: await tmpGuard(1), fetch: fn }).explain(input());
    assert.equal(JSON.stringify(a).includes(KEY), false, JSON.stringify(a));
  }
});
