import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PerceptionGateway } from './gateway.ts';
import { DisabledAdapter } from './disabled-adapter.ts';
import { FixtureAdapter } from './fixture-adapter.ts';
import type { AdapterResult, Advice, ExplainInput, Explainer, FrameSource, PerceptionAdapter } from './types.ts';
import { fakeFrames } from './test-frames.ts';
import { VirtualPLC } from '../plc/virtual-plc.ts';

const TTL = 2000;

function clock(start = Date.parse('2026-10-27T12:00:00.000Z')) {
  let t = start;
  return { now: () => new Date(t), advance: (ms: number) => (t += ms) };
}

function gateway(adapter: PerceptionAdapter, c = clock(), timeoutMs = 1000, frames: FrameSource = fakeFrames(c.now)) {
  const gw = new PerceptionGateway({ adapter, frames, freshnessTtlMs: TTL, timeoutMs, frameTimeoutMs: 1000, now: c.now });
  return { gw, c };
}

test('sin cámara conectada ⇒ NO_CAMERA, sin llamar al adaptador', async () => {
  let calls = 0;
  const adapter: PerceptionAdapter = {
    id: 'spy',
    analyze: async () => {
      calls++;
      return { status: 'NO_RISK_OBSERVED', source: 'simulation', detail: null };
    },
  };
  const { gw } = gateway(adapter);
  const ev = await gw.evaluate('cam-01');
  assert.equal(ev.status, 'NO_CAMERA');
  assert.equal(ev.source, 'none');
  assert.equal(calls, 0);
});

test('inferencia apagada ⇒ INFERENCE_DISABLED', async () => {
  const { gw } = gateway(new DisabledAdapter());
  gw.setCameraConnected('cam-01', true);
  const ev = await gw.evaluate('cam-01');
  assert.equal(ev.status, 'INFERENCE_DISABLED');
  assert.equal(ev.observedAt, null);
});

test('error del modelo ⇒ MODEL_ERROR', async () => {
  const adapter: PerceptionAdapter = {
    id: 'boom',
    analyze: async () => {
      throw new Error('500 upstream');
    },
  };
  const { gw } = gateway(adapter);
  gw.setCameraConnected('cam-01', true);
  const ev = await gw.evaluate('cam-01');
  assert.equal(ev.status, 'MODEL_ERROR');
  assert.match(ev.detail ?? '', /500 upstream/);
});

test('timeout del modelo ⇒ MODEL_ERROR y se aborta la señal', async () => {
  let aborted = false;
  const adapter: PerceptionAdapter = {
    id: 'slow',
    analyze: ({ signal }) =>
      new Promise((_, reject) => {
        signal.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('aborted'));
        });
      }),
  };
  const { gw } = gateway(adapter, clock(), 20);
  gw.setCameraConnected('cam-01', true);
  const ev = await gw.evaluate('cam-01');
  assert.equal(ev.status, 'MODEL_ERROR');
  assert.match(ev.detail ?? '', /timeout/i);
  assert.equal(aborted, true);
});

test('concurrencia 1: una segunda evaluación en vuelo ⇒ UNVERIFIED sin otra llamada', async () => {
  let calls = 0;
  let release!: () => void;
  let called!: () => void;
  const analyzing = new Promise<void>((r) => (called = r));
  const adapter: PerceptionAdapter = {
    id: 'gate',
    analyze: () => {
      calls++;
      called();
      return new Promise((resolve) => {
        release = () => resolve({ status: 'RISK_OBSERVED', source: 'simulation', detail: null });
      });
    },
  };
  const { gw } = gateway(adapter);
  gw.setCameraConnected('cam-01', true);
  const first = gw.evaluate('cam-01');
  const second = await gw.evaluate('cam-01');
  assert.equal(second.status, 'UNVERIFIED');
  await analyzing;
  release();
  assert.equal((await first).status, 'RISK_OBSERVED');
  assert.equal(calls, 1);
});

test('resultado vencido ⇒ STALE_RESULT, no se sigue mostrando como actual', async () => {
  const { gw, c } = gateway(new FixtureAdapter('NO_RISK_OBSERVED'));
  gw.setCameraConnected('cam-01', true);
  assert.equal((await gw.evaluate('cam-01')).status, 'NO_RISK_OBSERVED');
  c.advance(TTL + 1);
  const ev = gw.current('cam-01');
  assert.equal(ev.status, 'STALE_RESULT');
});

test('cámara desconectada después de un resultado ⇒ NO_CAMERA en current()', async () => {
  const { gw } = gateway(new FixtureAdapter('NO_RISK_OBSERVED'));
  gw.setCameraConnected('cam-01', true);
  await gw.evaluate('cam-01');
  gw.setCameraConnected('cam-01', false);
  assert.equal(gw.current('cam-01').status, 'NO_CAMERA');
});

test('el fixture se rotula como simulation, nunca como model', async () => {
  const { gw } = gateway(new FixtureAdapter('RISK_OBSERVED'));
  gw.setCameraConnected('cam-01', true);
  const ev = await gw.evaluate('cam-01');
  assert.equal(ev.source, 'simulation');
});

test('sin frame no hay inferencia: captura fallida ⇒ CAPTURE_FAILED y el adaptador no se llama', async () => {
  let calls = 0;
  const adapter: PerceptionAdapter = {
    id: 'spy',
    analyze: async () => {
      calls++;
      return { status: 'NO_RISK_OBSERVED', source: 'simulation', detail: null };
    },
  };
  const frames: FrameSource = {
    capture: async () => {
      throw new Error('render target lost');
    },
  };
  const { gw } = gateway(adapter, clock(), 1000, frames);
  gw.setCameraConnected('cam-01', true);
  const ev = await gw.evaluate('cam-01');
  assert.equal(ev.status, 'CAPTURE_FAILED');
  assert.match(ev.detail ?? '', /render target lost/);
  assert.equal(calls, 0);
});

test('la captura que no llega a tiempo ⇒ CAPTURE_FAILED', async () => {
  const frames: FrameSource = {
    capture: (_cam, signal) =>
      new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))),
  };
  const c = clock();
  const gw = new PerceptionGateway({
    adapter: new DisabledAdapter(),
    frames,
    freshnessTtlMs: TTL,
    timeoutMs: 1000,
    frameTimeoutMs: 20,
    now: c.now,
  });
  gw.setCameraConnected('cam-01', true);
  const ev = await gw.evaluate('cam-01');
  assert.equal(ev.status, 'CAPTURE_FAILED');
  assert.match(ev.detail ?? '', /timeout/i);
});

test('el adaptador recibe el frame capturado y la evidencia lo referencia, sin la verdad del simulador', async () => {
  let seen: unknown;
  const adapter: PerceptionAdapter = {
    id: 'spy',
    analyze: async ({ frame }) => {
      seen = frame;
      return { status: 'INFERENCE_DISABLED', source: 'none', detail: null };
    },
  };
  const { gw } = gateway(adapter);
  gw.setCameraConnected('cam-01', true);
  const ev = await gw.evaluate('cam-01');
  assert.ok(ev.frame);
  assert.equal((seen as { frameId: string }).frameId, ev.frame.frameId);
  assert.equal('simTruth' in (seen as object), false);
  assert.equal('bytes' in ev.frame, false);
});

test('onEvidence recibe cada evaluación con su frame', async () => {
  const seen: string[] = [];
  const c = clock();
  const gw = new PerceptionGateway({
    adapter: new DisabledAdapter(),
    frames: fakeFrames(c.now),
    freshnessTtlMs: TTL,
    timeoutMs: 1000,
    frameTimeoutMs: 1000,
    now: c.now,
    onEvidence: (ev, frame) => {
      seen.push(`${ev.status}:${frame?.frameId ?? '-'}`);
    },
  });
  gw.setCameraConnected('cam-01', true);
  await gw.evaluate('cam-01');
  assert.equal(seen.length, 1);
  assert.match(seen[0]!, /^INFERENCE_DISABLED:f-test-/);
});

test('si no se pudo guardar la evidencia, la observación no cuenta ⇒ UNVERIFIED', async () => {
  const c = clock();
  const gw = new PerceptionGateway({
    adapter: new FixtureAdapter('NO_RISK_OBSERVED'),
    frames: fakeFrames(c.now),
    freshnessTtlMs: TTL,
    timeoutMs: 1000,
    frameTimeoutMs: 1000,
    now: c.now,
    onEvidence: async () => {
      throw new Error('disk full');
    },
  });
  gw.setCameraConnected('cam-01', true);
  const ev = await gw.evaluate('cam-01');
  assert.equal(ev.status, 'UNVERIFIED');
  assert.match(ev.detail ?? '', /disk full/);
  assert.equal(gw.current('cam-01').status, 'UNVERIFIED');
});

test('al reconectar la cámara no se muestra la evaluación de la conexión anterior', async () => {
  const frames: FrameSource = {
    capture: async () => {
      throw new Error('render target lost');
    },
  };
  const { gw } = gateway(new DisabledAdapter(), clock(), 1000, frames);
  gw.setCameraConnected('cam-01', true);
  await gw.evaluate('cam-01');
  assert.equal(gw.current('cam-01').status, 'CAPTURE_FAILED');
  gw.setCameraConnected('cam-01', false);
  gw.setCameraConnected('cam-01', true);
  assert.equal(gw.current('cam-01').status, 'UNVERIFIED');
  assert.equal(gw.current('cam-01').detail, 'no evaluation yet');
});

// SIMULACIÓN: overlay armado a mano para probar el gateway; no es salida de un modelo.
const OVERLAY = {
  width: 1280,
  height: 720,
  polygon: [[526, 663], [869, 450], [684, 352], [361, 492]] as [number, number][],
  persons: [{ x1: 560, y1: 200, x2: 660, y2: 560, c: 0.9, foot: [610, 560] as [number, number], inZone: true }],
};
const withOverlay = (status: 'RISK_OBSERVED' | 'NO_RISK_OBSERVED' | 'UNVERIFIED', source: 'model' | 'simulation' = 'model'): PerceptionAdapter => ({
  id: 'overlay-spy',
  analyze: async () => ({ status, source, detail: null, overlay: OVERLAY }),
});

test('overlay del modelo: se guarda con la evidencia y queda en current() mientras es vigente', async () => {
  const stored: unknown[] = [];
  const c = clock();
  const gw = new PerceptionGateway({
    adapter: withOverlay('RISK_OBSERVED'),
    frames: fakeFrames(c.now),
    freshnessTtlMs: TTL,
    timeoutMs: 1000,
    frameTimeoutMs: 1000,
    now: c.now,
    onEvidence: (ev) => {
      stored.push(ev.overlay);
    },
  });
  gw.setCameraConnected('cam-01', true);
  const ev = await gw.evaluate('cam-01');
  assert.deepEqual(ev.overlay, OVERLAY);
  assert.deepEqual(stored, [OVERLAY]);
  c.advance(TTL);
  assert.deepEqual(gw.current('cam-01').overlay, OVERLAY);
});

test('overlay vencido ⇒ STALE_RESULT sin overlay (no se dibuja una detección vieja)', async () => {
  const { gw, c } = gateway(withOverlay('NO_RISK_OBSERVED'));
  gw.setCameraConnected('cam-01', true);
  await gw.evaluate('cam-01');
  c.advance(TTL + 1);
  const ev = gw.current('cam-01');
  assert.equal(ev.status, 'STALE_RESULT');
  assert.equal(ev.overlay, null);
});

test('después de un overlay, un MODEL_ERROR o una captura fallida no arrastran el overlay viejo', async () => {
  let fail = false;
  const adapter: PerceptionAdapter = {
    id: 'flaky',
    analyze: async () => {
      if (fail) throw new Error('meta http 500');
      return { status: 'RISK_OBSERVED', source: 'model', detail: null, overlay: OVERLAY };
    },
  };
  const { gw } = gateway(adapter);
  gw.setCameraConnected('cam-01', true);
  assert.ok((await gw.evaluate('cam-01')).overlay);
  fail = true;
  const ev = await gw.evaluate('cam-01');
  assert.equal(ev.status, 'MODEL_ERROR');
  assert.equal(ev.overlay, null);
  assert.equal(gw.current('cam-01').overlay, null);
});

test('overlay sólo con observación del modelo: UNVERIFIED o simulación ⇒ null', async () => {
  for (const a of [withOverlay('UNVERIFIED'), withOverlay('RISK_OBSERVED', 'simulation')]) {
    const { gw } = gateway(a);
    gw.setCameraConnected('cam-01', true);
    assert.equal((await gw.evaluate('cam-01')).overlay, null);
  }
});

test('evidencia no guardada ⇒ UNVERIFIED sin overlay', async () => {
  const c = clock();
  const gw = new PerceptionGateway({
    adapter: withOverlay('RISK_OBSERVED'),
    frames: fakeFrames(c.now),
    freshnessTtlMs: TTL,
    timeoutMs: 1000,
    frameTimeoutMs: 1000,
    now: c.now,
    onEvidence: async () => {
      throw new Error('disk full');
    },
  });
  gw.setCameraConnected('cam-01', true);
  const ev = await gw.evaluate('cam-01');
  assert.equal(ev.status, 'UNVERIFIED');
  assert.equal(ev.overlay, null);
  assert.equal(gw.current('cam-01').overlay, null);
});

test('sin cámara o sin evaluación ⇒ overlay null', async () => {
  const { gw } = gateway(withOverlay('RISK_OBSERVED'));
  assert.equal(gw.current('cam-01').overlay, null);
  gw.setCameraConnected('cam-01', true);
  assert.equal(gw.current('cam-01').overlay, null);
});

// ── Muse Spark (comunica, no decide) ───────────────────────────────
// SIMULACIÓN: adaptador y explicador de prueba con salidas armadas a mano;
// prueban el cableado y la regla, no una detección.
const SPARK_OVERLAY = {
  width: 1280,
  height: 720,
  polygon: [[526, 663], [869, 450], [684, 352], [361, 492]] as [number, number][],
  persons: [],
};

function samLike(status: AdapterResult['status'], source: AdapterResult['source'] = 'model'): PerceptionAdapter {
  return { id: 'sam-spy', analyze: async () => ({ status, source, detail: 'sam detail', overlay: source === 'model' ? SPARK_OVERLAY : null }) };
}

function sparkSpy(reply: (input: ExplainInput) => Promise<Advice> | Advice) {
  const calls: ExplainInput[] = [];
  const explainer: Explainer = {
    id: 'spark-spy',
    explain: async (input) => {
      calls.push(input);
      return await reply(input);
    },
  };
  return { explainer, calls };
}

const sparkAdvice = (input: ExplainInput, over: Partial<Advice> = {}): Advice => ({
  model: 'muse-spark-1.3',
  ok: true,
  samStatus: input.samStatus,
  text: 'Nobody is inside the work zone.',
  technicianAlert: null,
  personInZoneVisible: input.samStatus === 'RISK_OBSERVED',
  reason: null,
  prompt: 'p',
  raw: '{}',
  request: '1/5',
  ...over,
});

const plcStateFor = (status: string) => (status === 'NO_RISK_OBSERVED' ? 'ENABLED' : 'BLOCKED') as 'ENABLED' | 'BLOCKED';

function sparkGateway(adapter: PerceptionAdapter, explainer: Explainer, c = clock(), explainTimeoutMs = 1000) {
  const gw = new PerceptionGateway({ adapter, frames: fakeFrames(c.now), freshnessTtlMs: TTL, timeoutMs: 1000, frameTimeoutMs: 1000, explainer, explainTimeoutMs, now: c.now });
  gw.setCameraConnected('cam-01', true);
  return { gw, c };
}

for (const sam of ['NO_RISK_OBSERVED', 'RISK_OBSERVED'] as const) {
  test(`la decisión no espera a Spark: evaluate (${sam}) no lo consulta y vuelve sin explicación`, async () => {
    const s = sparkSpy((i) => sparkAdvice(i));
    const { gw } = sparkGateway(samLike(sam), s.explainer);
    const ev = await gw.evaluate('cam-01');
    assert.equal(ev.status, sam);
    assert.equal(ev.source, 'model');
    assert.ok(ev.overlay);
    assert.equal(ev.explanation, null);
    assert.equal(s.calls.length, 0);
  });
}

test('Spark que nunca responde no frena nada: evaluate vuelve y el PLC habilita con NO_RISK fresco', async () => {
  const s = sparkSpy(() => new Promise<Advice>(() => {}));
  const { gw } = sparkGateway(samLike('NO_RISK_OBSERVED'), s.explainer, clock(), 60_000);
  const plc = new VirtualPLC({ machineId: 'pg-01', cameraId: 'cam-01', gateway: gw });
  const result = await plc.requestStart('auth-1');
  assert.equal(result.snapshot.state, 'ENABLED');
  assert.equal(result.evidence?.status, 'NO_RISK_OBSERVED');
  // Aunque se le pida explicar, la decisión ya estaba tomada y no se espera.
  void gw.explain('cam-01', result.evidence!.frame!.frameId, 'ENABLED');
  assert.equal(gw.current('cam-01').status, 'NO_RISK_OBSERVED');
});

for (const status of ['INFERENCE_DISABLED', 'BUDGET_EXHAUSTED', 'UNVERIFIED', 'MODEL_ERROR'] as const) {
  test(`Spark sólo después de una observación de SAM: ${status} ⇒ explain no consulta`, async () => {
    const s = sparkSpy((i) => sparkAdvice(i));
    const { gw } = sparkGateway(samLike(status, 'none'), s.explainer);
    const ev = await gw.evaluate('cam-01');
    assert.equal(ev.status, status);
    assert.equal(await gw.explain('cam-01', ev.frame?.frameId ?? 'x', 'BLOCKED'), null);
    assert.equal(s.calls.length, 0);
  });
}

test('Spark no se consulta sobre una observación de simulación (fixture)', async () => {
  const s = sparkSpy((i) => sparkAdvice(i));
  const { gw } = sparkGateway(samLike('NO_RISK_OBSERVED', 'simulation'), s.explainer);
  const ev = await gw.evaluate('cam-01');
  assert.equal(ev.status, 'NO_RISK_OBSERVED');
  assert.equal(await gw.explain('cam-01', ev.frame!.frameId, 'ENABLED'), null);
  assert.equal(s.calls.length, 0);
});

test('Spark no se consulta con una decisión que no coincide con lo que vio SAM', async () => {
  for (const [sam, plcState] of [['NO_RISK_OBSERVED', 'BLOCKED'], ['RISK_OBSERVED', 'ENABLED']] as const) {
    const s = sparkSpy((i) => sparkAdvice(i));
    const { gw } = sparkGateway(samLike(sam), s.explainer);
    const ev = await gw.evaluate('cam-01');
    assert.equal(await gw.explain('cam-01', ev.frame!.frameId, plcState), null, `${sam}/${plcState}`);
    assert.equal(s.calls.length, 0);
  }
});

test('sin explicador ⇒ explain devuelve null', async () => {
  const { gw } = gateway(samLike('RISK_OBSERVED'));
  gw.setCameraConnected('cam-01', true);
  const ev = await gw.evaluate('cam-01');
  assert.equal(await gw.explain('cam-01', ev.frame!.frameId, 'BLOCKED'), null);
});

test('Spark recibe el frame (sin verdad del simulador), el estado, la decisión y el overlay de SAM', async () => {
  const s = sparkSpy((i) => sparkAdvice(i));
  const { gw } = sparkGateway(samLike('RISK_OBSERVED'), s.explainer);
  const ev = await gw.evaluate('cam-01');
  await gw.explain('cam-01', ev.frame!.frameId, 'BLOCKED');
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0]!.samStatus, 'RISK_OBSERVED');
  assert.equal(s.calls[0]!.plcState, 'BLOCKED');
  assert.deepEqual(s.calls[0]!.overlay, SPARK_OVERLAY);
  assert.equal(s.calls[0]!.frame.frameId, ev.frame!.frameId);
  assert.equal('simTruth' in s.calls[0]!.frame, false);
});

test('acuerdo: la explicación llega después y no toca estado, hora ni overlay', async () => {
  const s = sparkSpy((i) => sparkAdvice(i));
  const { gw } = sparkGateway(samLike('NO_RISK_OBSERVED'), s.explainer);
  const ev = await gw.evaluate('cam-01');
  const advice = await gw.explain('cam-01', ev.frame!.frameId, 'ENABLED');
  assert.equal(advice?.ok, true);
  const cur = gw.current('cam-01');
  assert.equal(cur.status, 'NO_RISK_OBSERVED');
  assert.equal(cur.observedAt?.getTime(), ev.observedAt?.getTime());
  assert.deepEqual(cur.overlay, ev.overlay);
  assert.deepEqual(cur.explanation, { model: 'muse-spark-1.3', text: 'Nobody is inside the work zone.' });
  assert.equal(cur.sparkNote, null);
  assert.equal(cur.detail, 'sam detail');
});

test('desacuerdo: SAM NO_RISK pero Spark ve a alguien ⇒ sólo se anota; el estado no cambia (decide SAM)', async () => {
  const s = sparkSpy((i) => sparkAdvice(i, { personInZoneVisible: true, text: 'A worker is inside the zone.' }));
  const { gw } = sparkGateway(samLike('NO_RISK_OBSERVED'), s.explainer);
  const ev = await gw.evaluate('cam-01');
  await gw.explain('cam-01', ev.frame!.frameId, 'ENABLED');
  const cur = gw.current('cam-01');
  assert.equal(cur.status, 'NO_RISK_OBSERVED');
  assert.ok(cur.overlay);
  assert.equal(cur.explanation, null);
  assert.equal(cur.sparkNote, 'models disagree: Muse Spark sees a person in the work zone; SAM decision stands');
  assert.equal(cur.detail, 'sam detail · models disagree: Muse Spark sees a person in the work zone; SAM decision stands');
  assert.equal(cur.advice?.personInZoneVisible, true);
});

test('desacuerdo al revés: SAM RISK y Spark no ve a nadie ⇒ sigue RISK, sin el texto de Spark y con la nota', async () => {
  const s = sparkSpy((i) => sparkAdvice(i, { personInZoneVisible: false, text: 'Nobody is in the zone.' }));
  const { gw } = sparkGateway(samLike('RISK_OBSERVED'), s.explainer);
  const ev = await gw.evaluate('cam-01');
  await gw.explain('cam-01', ev.frame!.frameId, 'BLOCKED');
  const cur = gw.current('cam-01');
  assert.equal(cur.status, 'RISK_OBSERVED');
  assert.ok(cur.overlay);
  assert.equal(cur.explanation, null);
  assert.equal(cur.detail, 'sam detail · models disagree: Muse Spark sees nobody; SAM decision stands');
});

const failures: [string, (i: ExplainInput) => Promise<Advice> | Advice][] = [
  ['ok=false (HTTP, tope o JSON inválido)', (i) => sparkAdvice(i, { ok: false, text: null, personInZoneVisible: null, reason: 'meta http 500' })],
  ['tira', async () => {
    throw new Error('boom');
  }],
  ['timeout', () => new Promise<Advice>(() => {})],
];
for (const [name, reply] of failures) {
  for (const sam of ['NO_RISK_OBSERVED', 'RISK_OBSERVED'] as const) {
    test(`Spark falla (${name}) ⇒ la decisión de SAM (${sam}) queda igual, sin explicación y con el motivo`, async () => {
      const s = sparkSpy(reply);
      const { gw } = sparkGateway(samLike(sam), s.explainer, clock(), 50);
      const ev = await gw.evaluate('cam-01');
      const advice = await gw.explain('cam-01', ev.frame!.frameId, plcStateFor(sam));
      assert.equal(advice?.ok, false);
      const cur = gw.current('cam-01');
      assert.equal(cur.status, sam);
      assert.equal(cur.source, 'model');
      assert.ok(cur.overlay);
      assert.equal(cur.explanation, null);
      assert.equal(cur.advice?.ok, false);
      assert.match(cur.detail ?? '', /^sam detail · muse-spark-1\.3 not used: /);
    });
  }
}

test('Spark lento: la explicación llega con la observación vencida ⇒ null en vivo, el texto queda en la evidencia', async () => {
  const c = clock();
  const s = sparkSpy((i) => {
    c.advance(TTL + 1);
    return sparkAdvice(i);
  });
  const { gw } = sparkGateway(samLike('NO_RISK_OBSERVED'), s.explainer, c);
  const ev = await gw.evaluate('cam-01');
  const advice = await gw.explain('cam-01', ev.frame!.frameId, 'ENABLED');
  assert.equal(advice?.text, 'Nobody is inside the work zone.');
  const stale = gw.current('cam-01');
  assert.equal(stale.status, 'STALE_RESULT');
  assert.equal(stale.explanation, null);
  assert.equal(stale.overlay, null);
  assert.equal(stale.advice?.text, 'Nobody is inside the work zone.');
});

test('Spark nunca habilita: tras explicar, ningún estado que no sea NO_RISK pasa a NO_RISK', async () => {
  for (const sam of ['RISK_OBSERVED'] as const) {
    for (const seen of [true, false]) {
      const s = sparkSpy((i) => sparkAdvice(i, { personInZoneVisible: seen }));
      const { gw } = sparkGateway(samLike(sam), s.explainer);
      const ev = await gw.evaluate('cam-01');
      await gw.explain('cam-01', ev.frame!.frameId, 'BLOCKED');
      assert.equal(gw.current('cam-01').status, sam);
    }
  }
});

test('explain sobre otro frame ⇒ null; una evaluación nueva no se pisa con la respuesta vieja', async () => {
  let release!: (a: Advice) => void;
  const s = sparkSpy(() => new Promise<Advice>((r) => (release = r)));
  const { gw } = sparkGateway(samLike('NO_RISK_OBSERVED'), s.explainer);
  const first = await gw.evaluate('cam-01');
  assert.equal(await gw.explain('cam-01', 'other-frame', 'ENABLED'), null);
  const pending = gw.explain('cam-01', first.frame!.frameId, 'ENABLED');
  await new Promise((r) => setTimeout(r, 5));
  const second = await gw.evaluate('cam-01');
  assert.notEqual(second.frame!.frameId, first.frame!.frameId);
  release(sparkAdvice(s.calls[0]!));
  assert.equal((await pending)?.ok, true);
  assert.equal(gw.current('cam-01').frame?.frameId, second.frame!.frameId);
  assert.equal(gw.current('cam-01').explanation, null);
});

test('concurrencia 1 en Spark: con una explicación en vuelo la segunda no sale', async () => {
  let release!: (a: Advice) => void;
  const s = sparkSpy(() => new Promise<Advice>((r) => (release = r)));
  const { gw } = sparkGateway(samLike('RISK_OBSERVED'), s.explainer);
  const ev = await gw.evaluate('cam-01');
  const first = gw.explain('cam-01', ev.frame!.frameId, 'BLOCKED');
  await new Promise((r) => setTimeout(r, 5));
  const second = await gw.explain('cam-01', ev.frame!.frameId, 'BLOCKED');
  assert.equal(second?.ok, false);
  assert.match(second?.reason ?? '', /in flight/);
  release(sparkAdvice(s.calls[0]!));
  assert.equal((await first)?.ok, true);
  assert.equal(s.calls.length, 1);
});

test('sin evidencia guardada ⇒ UNVERIFIED y Spark no se consulta', async () => {
  const s = sparkSpy((i) => sparkAdvice(i));
  const c = clock();
  const gw = new PerceptionGateway({
    adapter: samLike('NO_RISK_OBSERVED'),
    frames: fakeFrames(c.now),
    freshnessTtlMs: TTL,
    timeoutMs: 1000,
    frameTimeoutMs: 1000,
    explainer: s.explainer,
    now: c.now,
    onEvidence: () => {
      throw new Error('disk full');
    },
  });
  gw.setCameraConnected('cam-01', true);
  const ev = await gw.evaluate('cam-01');
  assert.equal(ev.status, 'UNVERIFIED');
  assert.equal(ev.explanation, null);
  assert.equal(await gw.explain('cam-01', ev.frame!.frameId, 'BLOCKED'), null);
  assert.equal(s.calls.length, 0);
});

test('cámara desconectada ⇒ no queda nada para explicar', async () => {
  const s = sparkSpy((i) => sparkAdvice(i));
  const { gw } = sparkGateway(samLike('RISK_OBSERVED'), s.explainer);
  const ev = await gw.evaluate('cam-01');
  gw.setCameraConnected('cam-01', false);
  assert.equal(await gw.explain('cam-01', ev.frame!.frameId, 'BLOCKED'), null);
  assert.equal(s.calls.length, 0);
});

// ── explicación como evidencia del frame evaluado ───────────────────
// SIMULACIÓN: SAM y Spark de prueba; prueban el cableado, no una detección.

test('evidencia: Spark llega con la observación vencida ⇒ en vivo null, pero queda atada a ese frame', async () => {
  const c = clock();
  const s = sparkSpy((i) => {
    c.advance(TTL + 1);
    return sparkAdvice(i);
  });
  const { gw } = sparkGateway(samLike('NO_RISK_OBSERVED'), s.explainer, c);
  const ev = await gw.evaluate('cam-01');
  assert.equal(ev.evidenceExplanation, null);
  await gw.explain('cam-01', ev.frame!.frameId, 'ENABLED');
  const stale = gw.current('cam-01');
  assert.equal(stale.status, 'STALE_RESULT');
  assert.equal(stale.explanation, null);
  assert.equal(stale.frame?.frameId, ev.frame!.frameId);
  assert.deepEqual(stale.evidenceExplanation, {
    frameId: ev.frame!.frameId,
    model: 'muse-spark-1.3',
    text: 'Nobody is inside the work zone.',
    at: c.now().toISOString(),
  });
  // Sigue mucho después: es evidencia de esa decisión, no una lectura actual.
  c.advance(60_000);
  assert.equal(gw.current('cam-01').evidenceExplanation?.frameId, ev.frame!.frameId);
});

test('evidencia: una evaluación nueva la borra (aunque Spark todavía no haya contestado la nueva)', async () => {
  const s = sparkSpy((i) => sparkAdvice(i));
  const { gw } = sparkGateway(samLike('RISK_OBSERVED'), s.explainer);
  const first = await gw.evaluate('cam-01');
  await gw.explain('cam-01', first.frame!.frameId, 'BLOCKED');
  assert.equal(gw.current('cam-01').evidenceExplanation?.frameId, first.frame!.frameId);
  const second = await gw.evaluate('cam-01');
  assert.equal(second.evidenceExplanation, null);
  assert.equal(gw.current('cam-01').evidenceExplanation, null);
  // La nueva sí recibe la suya cuando Spark contesta por ella.
  await gw.explain('cam-01', second.frame!.frameId, 'BLOCKED');
  assert.equal(gw.current('cam-01').evidenceExplanation?.frameId, second.frame!.frameId);
});

test('evidencia: Spark tarde sobre el frame viejo nunca se pega al frame nuevo', async () => {
  let release!: (a: Advice) => void;
  const s = sparkSpy(() => new Promise<Advice>((r) => (release = r)));
  const { gw } = sparkGateway(samLike('NO_RISK_OBSERVED'), s.explainer);
  const first = await gw.evaluate('cam-01');
  const pending = gw.explain('cam-01', first.frame!.frameId, 'ENABLED');
  await new Promise((r) => setTimeout(r, 5));
  const second = await gw.evaluate('cam-01');
  release(sparkAdvice(s.calls[0]!));
  assert.equal((await pending)?.ok, true);
  const cur = gw.current('cam-01');
  assert.equal(cur.frame?.frameId, second.frame!.frameId);
  assert.equal(cur.evidenceExplanation, null);
});

test('evidencia: al caerse la cámara se borra y al reconectar no vuelve', async () => {
  const s = sparkSpy((i) => sparkAdvice(i));
  const { gw } = sparkGateway(samLike('RISK_OBSERVED'), s.explainer);
  const ev = await gw.evaluate('cam-01');
  await gw.explain('cam-01', ev.frame!.frameId, 'BLOCKED');
  assert.ok(gw.current('cam-01').evidenceExplanation);
  gw.setCameraConnected('cam-01', false);
  assert.equal(gw.current('cam-01').evidenceExplanation, null);
  gw.setCameraConnected('cam-01', true);
  assert.equal(gw.current('cam-01').evidenceExplanation, null);
});

test('evidencia: desacuerdo o Spark fallido ⇒ null (el texto queda sólo en la evidencia guardada)', async () => {
  const replies: [string, 'NO_RISK_OBSERVED' | 'RISK_OBSERVED', (i: ExplainInput) => Advice][] = [
    ['NO_RISK + Spark ve a alguien', 'NO_RISK_OBSERVED', (i) => sparkAdvice(i, { personInZoneVisible: true, text: 'A worker is inside the zone.' })],
    ['RISK + Spark no ve a nadie', 'RISK_OBSERVED', (i) => sparkAdvice(i, { personInZoneVisible: false, text: 'Nobody is in the zone.' })],
    ['ok=false', 'RISK_OBSERVED', (i) => sparkAdvice(i, { ok: false, text: null, personInZoneVisible: null, reason: 'meta http 500' })],
  ];
  for (const [name, sam, reply] of replies) {
    const s = sparkSpy(reply);
    const { gw } = sparkGateway(samLike(sam), s.explainer);
    const ev = await gw.evaluate('cam-01');
    await gw.explain('cam-01', ev.frame!.frameId, plcStateFor(sam));
    const cur = gw.current('cam-01');
    assert.equal(cur.evidenceExplanation, null, name);
    assert.ok(cur.advice, name);
  }
});

test('evidencia: sin observación del modelo (simulación) no hay explicación de evidencia', async () => {
  const s = sparkSpy((i) => sparkAdvice(i));
  const { gw } = sparkGateway(samLike('RISK_OBSERVED', 'simulation'), s.explainer);
  const ev = await gw.evaluate('cam-01');
  assert.equal(await gw.explain('cam-01', ev.frame!.frameId, 'BLOCKED'), null);
  assert.equal(gw.current('cam-01').evidenceExplanation, null);
});
