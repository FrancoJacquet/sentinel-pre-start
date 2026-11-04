import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { PROTOCOL_VERSION, parseServerMessage, type ServerMessage } from '@sentinel/contracts';
import { startServer } from './server.ts';
import { DisabledAdapter } from './perception/disabled-adapter.ts';
import { MetaSparkExplainer } from './perception/meta/spark-explainer.ts';
import { SpendGuard } from './perception/meta/spend-guard.ts';
import type { Advice, Explainer, PerceptionAdapter } from './perception/types.ts';
import { WEARABLE_TEMPLATE_TEXT } from './wearable.ts';
import { loadConfig } from './config.ts';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { FAKE_JPEG } from './perception/test-frames.ts';

type FrameMode = 'jpeg' | 'silent' | 'not-jpeg';

async function newServer(
  frameTimeoutMs = 1000,
  adapter: PerceptionAdapter = new DisabledAdapter(),
  explainer: Explainer | null = null,
  over: Partial<ReturnType<typeof loadConfig>> = {},
) {
  const evidenceDir = await mkdtemp(join(tmpdir(), 'sentinel-srv-'));
  const server = await startServer({ ...loadConfig({}), port: 0, evidenceDir, frameTimeoutMs, ...over }, { adapter, explainer });
  const closeServer = server.close;
  return Object.assign(server, {
    evidenceDir,
    async close() {
      await closeServer();
      await rm(evidenceDir, { recursive: true, force: true });
    },
  });
}

async function connect(existing?: Awaited<ReturnType<typeof newServer>>, frames: FrameMode = 'jpeg') {
  const server = existing ?? (await newServer());
  const ws = new WebSocket(`ws://127.0.0.1:${server.ports[0]}/ws`);
  const inbox: ServerMessage[] = [];
  const waiters: Array<() => void> = [];
  ws.on('message', (data) => {
    // Todo lo que manda el servidor tiene que cumplir el contrato.
    const msg = parseServerMessage(JSON.parse(String(data)));
    inbox.push(msg);
    waiters.splice(0).forEach((w) => w());
    // Cámara de prueba: responde con bytes sintéticos (no es un render).
    if (msg.type === 'frame.request' && frames !== 'silent') {
      const bytes = frames === 'jpeg' ? FAKE_JPEG : Buffer.from('GIF89a not a jpeg');
      send('frame.capture', {
        ...msg.payload,
        captureTs: new Date().toISOString(),
        mime: 'image/jpeg',
        sceneRevision: 'hall-v1',
        dataBase64: bytes.toString('base64'),
        simTruth: { operatorInZone: true },
      });
    }
  });
  await new Promise((resolve, reject) => ws.once('open', resolve).once('error', reject));
  let seq = 0;
  const send = (type: string, payload: unknown) =>
    ws.send(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        seq: seq++,
        ts: new Date().toISOString(),
        correlationId: `c-${seq}`,
        requestId: `r-${seq}`,
        type,
        payload,
      }),
    );
  const waitFor = async (pred: (m: ServerMessage) => boolean, ms = 2000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const hit = inbox.find(pred);
      if (hit) return hit;
      if (Date.now() > deadline) throw new Error(`timeout; inbox: ${JSON.stringify(inbox.map((m) => m.type))}`);
      await new Promise<void>((r) => {
        waiters.push(r);
        setTimeout(r, 50);
      });
    }
  };
  const close = async () => {
    ws.close();
    if (!existing) await server.close();
  };
  return { ws, inbox, send, waitFor, close, server };
}

test('al conectar recibe el estado actual: PLC IDLE y percepción NO_CAMERA', async (t) => {
  const c = await connect();
  t.after(c.close);
  const plc = await c.waitFor((m) => m.type === 'plc.state');
  assert.equal(plc.type === 'plc.state' && plc.payload.state, 'IDLE');
  const per = await c.waitFor((m) => m.type === 'perception.state');
  assert.equal(per.type === 'perception.state' && per.payload.status, 'NO_CAMERA');
});

test('pedido de arranque con inferencia apagada ⇒ BLOCKED INFERENCE_DISABLED + alerta', async (t) => {
  const c = await connect();
  t.after(c.close);
  c.send('camera.status', { cameraId: 'cam-01', connected: true });
  c.send('start.request', { machineId: 'pg-01', authorizationId: 'auth-1' });
  const blocked = await c.waitFor((m) => m.type === 'plc.state' && m.payload.state === 'BLOCKED');
  assert.equal(blocked.type === 'plc.state' && blocked.payload.reason, 'INFERENCE_DISABLED');
  const alert = await c.waitFor((m) => m.type === 'alert');
  assert.equal(alert.type === 'alert' && alert.payload.code, 'INFERENCE_DISABLED');
  const per = await c.waitFor((m) => m.type === 'perception.state' && m.payload.status === 'INFERENCE_DISABLED');
  assert.equal(per.type === 'perception.state' && per.payload.source, 'none');
});

test('las respuestas a un pedido llevan su correlationId', async (t) => {
  const c = await connect();
  t.after(c.close);
  c.send('camera.status', { cameraId: 'cam-01', connected: true });
  c.send('start.request', { machineId: 'pg-01', authorizationId: 'auth-1' });
  const blocked = await c.waitFor((m) => m.type === 'plc.state' && m.payload.state === 'BLOCKED');
  assert.equal(blocked.correlationId, 'c-2');
});

test('mensaje fuera de contrato ⇒ protocol.error, el PLC no se mueve', async (t) => {
  const c = await connect();
  t.after(c.close);
  c.ws.send(JSON.stringify({ type: 'plc.force_enable' }));
  await c.waitFor((m) => m.type === 'protocol.error');
  assert.ok(!c.inbox.some((m) => m.type === 'plc.state' && m.payload.state !== 'IDLE'));
});

test('máquina desconocida ⇒ protocol.error', async (t) => {
  const c = await connect();
  t.after(c.close);
  c.send('start.request', { machineId: 'lathe-99', authorizationId: 'auth-1' });
  await c.waitFor((m) => m.type === 'protocol.error');
});

test('si se cae el cliente que reportó la cámara, la cámara queda desconectada', async (t) => {
  const a = await connect();
  t.after(() => a.server.close());
  a.send('camera.status', { cameraId: 'cam-01', connected: true });
  a.send('start.request', { machineId: 'pg-01', authorizationId: 'auth-1' });
  await a.waitFor((m) => m.type === 'plc.state' && m.payload.state === 'BLOCKED');
  a.ws.close();
  await new Promise((r) => a.ws.once('close', r));
  const b = await connect(a.server);
  t.after(b.close);
  b.send('start.request', { machineId: 'pg-01', authorizationId: 'auth-2' });
  const blocked = await b.waitFor(
    (m) => m.type === 'plc.state' && m.payload.state === 'BLOCKED' && m.payload.authorizationId === 'auth-2',
  );
  assert.equal(blocked.type === 'plc.state' && blocked.payload.reason, 'NO_CAMERA');
});

test('el pedido de arranque captura un frame real de la cámara y lo guarda como evidencia', async (t) => {
  const c = await connect();
  t.after(c.close);
  c.send('camera.status', { cameraId: 'cam-01', connected: true });
  c.send('start.request', { machineId: 'pg-01', authorizationId: 'auth-1' });
  const per = await c.waitFor((m) => m.type === 'perception.state' && m.payload.frame !== null);
  assert.ok(per.type === 'perception.state' && per.payload.frame);
  const { frameId, sha256 } = per.payload.frame;
  assert.equal(sha256, createHash('sha256').update(FAKE_JPEG).digest('hex'));
  assert.equal(per.payload.status, 'INFERENCE_DISABLED');
  const jpg = await readFile(join(c.server.evidenceDir, `${frameId}.jpg`));
  assert.deepEqual(jpg, FAKE_JPEG);
  const meta = JSON.parse(await readFile(join(c.server.evidenceDir, `${frameId}.json`), 'utf8'));
  assert.equal(meta.simulation.label, 'SIMULATION');
  assert.equal(meta.simulation.truth.operatorInZone, true);
});

test('cámara que no responde el frame ⇒ BLOCKED con CAPTURE_FAILED', async (t) => {
  const server = await newServer(100);
  const c = await connect(server, 'silent');
  t.after(async () => {
    await c.close();
    await server.close();
  });
  c.send('camera.status', { cameraId: 'cam-01', connected: true });
  c.send('start.request', { machineId: 'pg-01', authorizationId: 'auth-1' });
  const blocked = await c.waitFor((m) => m.type === 'plc.state' && m.payload.state === 'BLOCKED');
  assert.equal(blocked.type === 'plc.state' && blocked.payload.reason, 'CAPTURE_FAILED');
});

test('frame que no es JPEG ⇒ BLOCKED con CAPTURE_FAILED', async (t) => {
  const server = await newServer();
  const c = await connect(server, 'not-jpeg');
  t.after(async () => {
    await c.close();
    await server.close();
  });
  c.send('camera.status', { cameraId: 'cam-01', connected: true });
  c.send('start.request', { machineId: 'pg-01', authorizationId: 'auth-1' });
  const blocked = await c.waitFor((m) => m.type === 'plc.state' && m.payload.state === 'BLOCKED');
  assert.equal(blocked.type === 'plc.state' && blocked.payload.reason, 'CAPTURE_FAILED');
});

test('frame.capture sin pedido previo ⇒ protocol.error', async (t) => {
  const c = await connect();
  t.after(c.close);
  c.send('frame.capture', {
    cameraId: 'cam-01',
    frameRequestId: 'fr-nope',
    frameId: 'f-nope',
    captureTs: new Date().toISOString(),
    width: 1280,
    height: 720,
    mime: 'image/jpeg',
    sceneRevision: 'hall-v1',
    dataBase64: FAKE_JPEG.toString('base64'),
    simTruth: { operatorInZone: false },
  });
  await c.waitFor((m) => m.type === 'protocol.error');
});

test('perception.state lleva overlay null cuando no hubo modelo', async (t) => {
  const c = await connect();
  t.after(c.close);
  c.send('camera.status', { cameraId: 'cam-01', connected: true });
  c.send('start.request', { machineId: 'pg-01', authorizationId: 'auth-1' });
  const per = await c.waitFor((m) => m.type === 'perception.state' && m.payload.frame !== null);
  assert.equal(per.type === 'perception.state' && per.payload.overlay, null);
});

test('overlay del modelo: viaja en perception.state y queda guardado con la evidencia del frame', async (t) => {
  // SIMULACIÓN: adaptador de prueba que devuelve un overlay armado a mano
  // como si fuera del modelo; prueba el cableado, no una detección.
  const overlay = {
    width: 1280,
    height: 720,
    polygon: [[526, 663], [869, 450], [684, 352], [361, 492]] as [number, number][],
    persons: [{ x1: 560, y1: 200, x2: 660, y2: 560, c: 0.9, foot: [610, 560] as [number, number], inZone: true }],
  };
  const adapter: PerceptionAdapter = {
    id: 'overlay-spy',
    analyze: async () => ({ status: 'RISK_OBSERVED', source: 'model', detail: 'test', overlay }),
  };
  const server = await newServer(1000, adapter);
  const c = await connect(server);
  t.after(async () => {
    await c.close();
    await server.close();
  });
  c.send('camera.status', { cameraId: 'cam-01', connected: true });
  c.send('start.request', { machineId: 'pg-01', authorizationId: 'auth-1' });
  const per = await c.waitFor((m) => m.type === 'perception.state' && m.payload.overlay !== null);
  assert.ok(per.type === 'perception.state' && per.payload.frame);
  assert.deepEqual(per.payload.overlay, overlay);
  const meta = JSON.parse(await readFile(join(server.evidenceDir, `${per.payload.frame.frameId}.json`), 'utf8'));
  assert.deepEqual(meta.evaluation.overlay, overlay);
  // Vencida la observación, el overlay deja de emitirse como actual.
  const stale = await c.waitFor((m) => m.type === 'perception.state' && m.payload.status === 'STALE_RESULT', 4000);
  assert.equal(stale.type === 'perception.state' && stale.payload.overlay, null);
});

test('explicación de Muse Spark: llega después de la decisión con la observación fresca, se guarda cruda con la evidencia y se cae al vencer', async (t) => {
  // SIMULACIÓN: SAM y Spark de prueba con salidas armadas a mano; prueban el
  // cableado, no una detección ni una explicación real.
  const overlay = {
    width: 1280,
    height: 720,
    polygon: [[526, 663], [869, 450], [684, 352], [361, 492]] as [number, number][],
    persons: [{ x1: 560, y1: 200, x2: 660, y2: 560, c: 0.9, foot: [610, 560] as [number, number], inZone: true }],
  };
  const adapter: PerceptionAdapter = {
    id: 'sam-spy',
    analyze: async () => ({ status: 'RISK_OBSERVED', source: 'model', detail: 'test', overlay }),
  };
  const raw = '{"explanation":"A worker is inside the zone.","person_in_zone_visible":true}';
  const explainer: Explainer = {
    id: 'spark-spy',
    explain: async ({ samStatus }) => ({
      model: 'muse-spark-1.3',
      ok: true,
      samStatus,
      text: 'A worker is inside the zone.',
      technicianAlert: null,
      personInZoneVisible: true,
      reason: null,
      prompt: 'p',
      raw,
      request: '1/5',
    }),
  };
  const server = await newServer(1000, adapter, explainer);
  const c = await connect(server);
  t.after(async () => {
    await c.close();
    await server.close();
  });
  c.send('camera.status', { cameraId: 'cam-01', connected: true });
  c.send('start.request', { machineId: 'pg-01', authorizationId: 'auth-1' });
  const per = await c.waitFor((m) => m.type === 'perception.state' && m.payload.explanation !== null);
  assert.ok(per.type === 'perception.state' && per.payload.frame);
  assert.deepEqual(per.payload.explanation, { model: 'muse-spark-1.3', text: 'A worker is inside the zone.' });
  const meta = JSON.parse(await readFile(join(server.evidenceDir, `${per.payload.frame.frameId}.json`), 'utf8'));
  assert.deepEqual(meta.evaluation.overlay, overlay);
  assert.equal(meta.evaluation.spark.raw, raw);
  assert.equal(meta.evaluation.spark.model, 'muse-spark-1.3');
  const stale = await c.waitFor((m) => m.type === 'perception.state' && m.payload.status === 'STALE_RESULT', 4000);
  assert.equal(stale.type === 'perception.state' && stale.payload.explanation, null);
});

// ── wearable simulado y Spark en segundo plano ─────────────────────
// SIMULACIÓN: SAM y Spark de prueba con salidas armadas a mano; prueban el
// cableado, no una detección. Ningún test toca la red.
const ZONE_OVERLAY = {
  width: 1280,
  height: 720,
  polygon: [[526, 663], [869, 450], [684, 352], [361, 492]] as [number, number][],
  persons: [{ x1: 560, y1: 200, x2: 660, y2: 560, c: 0.9, foot: [610, 560] as [number, number], inZone: true }],
};

function samAdapter(status: 'RISK_OBSERVED' | 'NO_RISK_OBSERVED' | 'UNVERIFIED'): PerceptionAdapter {
  const observed = status !== 'UNVERIFIED';
  return {
    id: 'sam-spy',
    analyze: async () => ({ status, source: observed ? 'model' : 'none', detail: 'test', overlay: observed ? ZONE_OVERLAY : null }),
  };
}

function sparkReply(over: Partial<Advice> = {}): Explainer & { calls: number } {
  const ex = {
    id: 'spark-spy',
    calls: 0,
    explain: async ({ samStatus }: { samStatus: Advice['samStatus'] }): Promise<Advice> => {
      ex.calls++;
      return {
        model: 'muse-spark-1.3',
        ok: true,
        samStatus,
        text: 'A worker stands under the crane load inside the work zone.',
        technicianAlert: 'Someone is trying to energize the crane above you. Step out of the zone now.',
        personInZoneVisible: samStatus === 'RISK_OBSERVED',
        reason: null,
        prompt: 'p',
        raw: '{}',
        request: '1/5',
        ...over,
      };
    },
  };
  return ex;
}

const wearables = (inbox: ServerMessage[]) => inbox.filter((m): m is Extract<ServerMessage, { type: 'wearable.notify' }> => m.type === 'wearable.notify');
const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

async function startAndBlock(server: Awaited<ReturnType<typeof newServer>>, mode: FrameMode = 'jpeg') {
  const c = await connect(server, mode);
  c.send('camera.status', { cameraId: 'cam-01', connected: true });
  c.send('start.request', { machineId: 'pg-01', authorizationId: 'auth-1' });
  return c;
}

test('wearable: RISK_OBSERVED bloqueado ⇒ un aviso fijo al técnico, rotulado simulado, y queda en la evidencia', async (t) => {
  const server = await newServer(1000, samAdapter('RISK_OBSERVED'));
  const c = await startAndBlock(server);
  t.after(async () => {
    await c.close();
    await server.close();
  });
  const blocked = await c.waitFor((m) => m.type === 'plc.state' && m.payload.state === 'BLOCKED');
  assert.equal(blocked.type === 'plc.state' && blocked.payload.reason, 'RISK_OBSERVED');
  const n = await c.waitFor((m) => m.type === 'wearable.notify');
  assert.ok(n.type === 'wearable.notify');
  assert.equal(n.payload.source, 'template');
  assert.equal(n.payload.text, WEARABLE_TEMPLATE_TEXT);
  assert.equal(n.payload.recipient, 'technician');
  assert.equal(n.payload.severity, 'warning');
  assert.equal(n.payload.simulated, true);
  const per = await c.waitFor((m) => m.type === 'perception.state' && m.payload.frame !== null);
  assert.ok(per.type === 'perception.state' && per.payload.frame);
  assert.equal(n.payload.frameId, per.payload.frame.frameId);
  await settle();
  assert.equal(wearables(c.inbox).length, 1);
  const meta = JSON.parse(await readFile(join(server.evidenceDir, `${n.payload.frameId}.json`), 'utf8'));
  assert.deepEqual(meta.evaluation.wearable, [{ notificationId: n.payload.notificationId, at: n.payload.at, text: WEARABLE_TEMPLATE_TEXT, source: 'template' }]);
});

test('wearable: el aviso de Spark reemplaza al fijo con el MISMO notificationId; los dos quedan en la evidencia', async (t) => {
  const spark = sparkReply();
  const server = await newServer(1000, samAdapter('RISK_OBSERVED'), spark);
  const c = await startAndBlock(server);
  t.after(async () => {
    await c.close();
    await server.close();
  });
  await c.waitFor(() => wearables(c.inbox).length >= 2);
  const [first, second] = wearables(c.inbox);
  assert.equal(first!.payload.source, 'template');
  assert.equal(second!.payload.source, 'muse-spark-1.3');
  assert.equal(second!.payload.notificationId, first!.payload.notificationId);
  assert.equal(second!.payload.frameId, first!.payload.frameId);
  assert.equal(second!.payload.text, 'Someone is trying to energize the crane above you. Step out of the zone now.');
  // El fijo sale antes que cualquier cosa de Spark.
  const iFirst = c.inbox.indexOf(first!);
  assert.equal(c.inbox.slice(0, iFirst).some((m) => m.type === 'perception.state' && m.payload.explanation !== null), false);
  await settle();
  assert.equal(wearables(c.inbox).length, 2);
  assert.equal(spark.calls, 1);
  const meta = JSON.parse(await readFile(join(server.evidenceDir, `${first!.payload.frameId}.json`), 'utf8'));
  assert.deepEqual(
    meta.evaluation.wearable.map((w: { source: string }) => w.source),
    ['template', 'muse-spark-1.3'],
  );
  assert.equal(meta.evaluation.spark.technicianAlert, second!.payload.text);
  // Spark comunica: el PLC sigue BLOCKED, nunca pasó a ENABLED.
  assert.equal(c.inbox.some((m) => m.type === 'plc.state' && m.payload.state === 'ENABLED'), false);
});

const sparkOnlyTemplate: [string, Explainer, Partial<ReturnType<typeof loadConfig>>][] = [
  ['falla (ok=false)', sparkReply({ ok: false, text: null, technicianAlert: null, personInZoneVisible: null, reason: 'meta http 500' }), {}],
  ['tira', { id: 'boom', explain: async () => { throw new Error('boom'); } }, {}],
  ['timeout', { id: 'slow', explain: () => new Promise<Advice>(() => {}) }, { sparkTimeoutMs: 100 }],
  ['sin aviso (null)', sparkReply({ technicianAlert: null }), {}],
  ['aviso que tranquiliza ("safe")', sparkReply({ technicianAlert: 'You are safe, you may stay.' }), {}],
];
for (const [name, explainer, over] of sparkOnlyTemplate) {
  test(`wearable: Spark ${name} ⇒ sólo el aviso fijo`, async (t) => {
    const server = await newServer(1000, samAdapter('RISK_OBSERVED'), explainer, over);
    const c = await startAndBlock(server);
    t.after(async () => {
      await c.close();
      await server.close();
    });
    await c.waitFor((m) => m.type === 'wearable.notify');
    // Spark terminó (bien o mal) cuando se publica su explicación o su motivo.
    await c.waitFor((m) => m.type === 'perception.state' && (m.payload.explanation !== null || /not used/.test(m.payload.detail ?? '')), 3000);
    await settle();
    const sent = wearables(c.inbox);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.payload.source, 'template');
  });
}

test('wearable: Spark con tope lleno ⇒ sin llamada a la red y sólo el aviso fijo', async (t) => {
  const ledgerDir = await mkdtemp(join(tmpdir(), 'sentinel-spark-'));
  const file = join(ledgerDir, 'meta-spark-spend.json');
  const guard = new SpendGuard({ file, maxRequests: 1 });
  // Se gasta el único lugar antes de arrancar.
  const slot = await guard.reserve('muse-spark-1.3', 'f-pre');
  assert.equal(slot.ok, true);
  guard.release();
  let fetches = 0;
  const fakeFetch = (async () => {
    fetches++;
    return new Response('{}');
  }) as unknown as typeof fetch;
  const explainer = new MetaSparkExplainer({ apiKey: 'k-test', guard: new SpendGuard({ file, maxRequests: 1 }), fetch: fakeFetch });
  const server = await newServer(1000, samAdapter('RISK_OBSERVED'), explainer);
  const c = await startAndBlock(server);
  t.after(async () => {
    await c.close();
    await server.close();
    await rm(ledgerDir, { recursive: true, force: true });
  });
  await c.waitFor((m) => m.type === 'perception.state' && /spark budget 1\/1/.test(m.payload.detail ?? ''));
  await settle();
  assert.equal(fetches, 0);
  assert.equal(wearables(c.inbox).length, 1);
  assert.equal(wearables(c.inbox)[0]!.payload.source, 'template');
});

test('wearable: NO_RISK habilita sin aviso al reloj, aunque Spark mande un aviso', async (t) => {
  const server = await newServer(1000, samAdapter('NO_RISK_OBSERVED'), sparkReply());
  const c = await startAndBlock(server);
  t.after(async () => {
    await c.close();
    await server.close();
  });
  await c.waitFor((m) => m.type === 'plc.state' && m.payload.state === 'ENABLED');
  await c.waitFor((m) => m.type === 'perception.state' && m.payload.explanation !== null);
  await settle();
  assert.equal(wearables(c.inbox).length, 0);
});

const noNotify: [string, () => Promise<Awaited<ReturnType<typeof newServer>>>, FrameMode, string][] = [
  ['INFERENCE_DISABLED', () => newServer(), 'jpeg', 'INFERENCE_DISABLED'],
  ['CAPTURE_FAILED', () => newServer(100), 'silent', 'CAPTURE_FAILED'],
  ['UNVERIFIED', () => newServer(1000, samAdapter('UNVERIFIED'), sparkReply()), 'jpeg', 'UNVERIFIED'],
];
for (const [name, make, mode, reason] of noNotify) {
  test(`wearable: ${name} (UNKNOWN) ⇒ BLOCKED sin aviso al reloj`, async (t) => {
    const server = await make();
    const c = await startAndBlock(server, mode);
    t.after(async () => {
      await c.close();
      await server.close();
    });
    const blocked = await c.waitFor((m) => m.type === 'plc.state' && m.payload.state === 'BLOCKED');
    assert.equal(blocked.type === 'plc.state' && blocked.payload.reason, reason);
    await settle();
    assert.equal(wearables(c.inbox).length, 0);
  });
}

test('wearable: NO_CAMERA ⇒ BLOCKED sin aviso al reloj', async (t) => {
  const c = await connect();
  t.after(c.close);
  c.send('start.request', { machineId: 'pg-01', authorizationId: 'auth-1' });
  const blocked = await c.waitFor((m) => m.type === 'plc.state' && m.payload.state === 'BLOCKED');
  assert.equal(blocked.type === 'plc.state' && blocked.payload.reason, 'NO_CAMERA');
  await settle();
  assert.equal(wearables(c.inbox).length, 0);
});

test('wearable: es un evento, no estado: un cliente que se conecta después no lo recibe', async (t) => {
  const server = await newServer(1000, samAdapter('RISK_OBSERVED'));
  const a = await startAndBlock(server);
  await a.waitFor((m) => m.type === 'wearable.notify');
  const b = await connect(server);
  t.after(async () => {
    await b.close();
    await a.close();
    await server.close();
  });
  await b.waitFor((m) => m.type === 'perception.state');
  await settle();
  assert.equal(wearables(b.inbox).length, 0);
});

test('desacuerdo de punta a punta: SAM NO_RISK + Spark ve a alguien ⇒ el PLC habilita igual (decide SAM), la nota queda en la evidencia y la key no aparece', async (t) => {
  // SIMULACIÓN: SAM de prueba y el explicador real de Spark con fetch
  // inyectado (respuesta armada a mano). No hay red ni llamada a Meta.
  const KEY = 'SENTINEL-KEY-do-not-leak-91c2';
  const overlay = {
    width: 1280,
    height: 720,
    polygon: [[526, 663], [869, 450], [684, 352], [361, 492]] as [number, number][],
    persons: [],
  };
  const adapter: PerceptionAdapter = {
    id: 'sam-spy',
    analyze: async () => ({ status: 'NO_RISK_OBSERVED', source: 'model', detail: 'test', overlay }),
  };
  const out = { explanation: 'A worker stands inside the work zone.', technician_alert: null, person_in_zone_visible: true };
  const sent: RequestInit[] = [];
  const fakeFetch = (async (_url: string, init: RequestInit) => {
    sent.push(init);
    return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(out) }] }] }));
  }) as unknown as typeof fetch;
  const ledgerDir = await mkdtemp(join(tmpdir(), 'sentinel-spark-'));
  const explainer = new MetaSparkExplainer({
    apiKey: KEY,
    guard: new SpendGuard({ file: join(ledgerDir, 'meta-spark-spend.json'), maxRequests: 1 }),
    fetch: fakeFetch,
  });
  const server = await newServer(1000, adapter, explainer);
  const c = await connect(server);
  t.after(async () => {
    await c.close();
    await server.close();
    await rm(ledgerDir, { recursive: true, force: true });
  });
  c.send('camera.status', { cameraId: 'cam-01', connected: true });
  c.send('start.request', { machineId: 'pg-01', authorizationId: 'auth-1' });
  await c.waitFor((m) => m.type === 'plc.state' && m.payload.state === 'ENABLED');
  const per = await c.waitFor((m) => m.type === 'perception.state' && /models disagree/.test(m.payload.detail ?? ''));
  assert.ok(per.type === 'perception.state' && per.payload.frame);
  assert.equal(per.payload.status, 'NO_RISK_OBSERVED');
  // En desacuerdo el texto de Spark no se muestra al lado del PLC.
  assert.equal(per.payload.explanation, null);
  assert.equal(c.inbox.some((m) => m.type === 'plc.state' && m.payload.state === 'BLOCKED'), false);
  assert.equal(wearables(c.inbox).length, 0);
  // La key sólo viaja en el header de la solicitud (fake).
  assert.equal(sent.length, 1);
  assert.equal((sent[0]!.headers as Record<string, string>).authorization, `Bearer ${KEY}`);
  const metaText = await readFile(join(server.evidenceDir, `${per.payload.frame.frameId}.json`), 'utf8');
  const meta = JSON.parse(metaText);
  assert.equal(meta.evaluation.status, 'NO_RISK_OBSERVED');
  assert.equal(meta.evaluation.sparkNote, 'models disagree: Muse Spark sees a person in the work zone; SAM decision stands');
  assert.equal(meta.evaluation.spark.personInZoneVisible, true);
  assert.equal(meta.evaluation.explanation.text, 'A worker stands inside the work zone.');
  // Tampoco como evidencia junto al frame evaluado.
  assert.equal(c.inbox.some((m) => m.type === 'perception.state' && m.payload.evidenceExplanation !== null), false);
  const jsonl = await readFile(join(server.evidenceDir, 'evaluations.jsonl'), 'utf8');
  for (const [name, text] of [['evidence json', metaText], ['evaluations.jsonl', jsonl], ['ws inbox', JSON.stringify(c.inbox)]] as const) {
    assert.equal(text.includes(KEY), false, `key in ${name}`);
  }
});

test('key-sentinel con aviso al reloj: RISK + Spark real (fetch inyectado) ⇒ dos avisos y la key en ningún lado', async (t) => {
  const KEY = 'SENTINEL-KEY-do-not-leak-wear-5d1e';
  const out = {
    explanation: 'A worker stands under the crane load inside the work zone.',
    technician_alert: 'Someone is trying to energize the crane above you. Step out now.',
    person_in_zone_visible: true,
  };
  const fakeFetch = (async () =>
    new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(out) }] }] }))) as unknown as typeof fetch;
  const ledgerDir = await mkdtemp(join(tmpdir(), 'sentinel-spark-'));
  const explainer = new MetaSparkExplainer({
    apiKey: KEY,
    guard: new SpendGuard({ file: join(ledgerDir, 'meta-spark-spend.json'), maxRequests: 1 }),
    fetch: fakeFetch,
  });
  const server = await newServer(1000, samAdapter('RISK_OBSERVED'), explainer);
  const c = await startAndBlock(server);
  t.after(async () => {
    await c.close();
    await server.close();
    await rm(ledgerDir, { recursive: true, force: true });
  });
  await c.waitFor(() => wearables(c.inbox).length >= 2);
  const frameId = wearables(c.inbox)[0]!.payload.frameId!;
  await settle();
  assert.equal(wearables(c.inbox)[1]!.payload.text, out.technician_alert);
  const metaText = await readFile(join(server.evidenceDir, `${frameId}.json`), 'utf8');
  const jsonl = await readFile(join(server.evidenceDir, 'evaluations.jsonl'), 'utf8');
  for (const [name, text] of [['evidence json', metaText], ['evaluations.jsonl', jsonl], ['ws inbox', JSON.stringify(c.inbox)]] as const) {
    assert.equal(text.includes(KEY), false, `key in ${name}`);
  }
});

test('Spark no se llama si el bloqueo no es por lo que vio SAM (STALE_RESULT sobre un frame NO_RISK)', async (t) => {
  // Reloj falso que avanza 3 s por lectura: la observación ya está vencida
  // (TTL 2 s) cuando el PLC la lee, como con una escritura de evidencia lenta.
  const spark = sparkReply();
  const evidenceDir = await mkdtemp(join(tmpdir(), 'sentinel-srv-'));
  let tick = 0;
  const base = Date.now();
  const running = await startServer(
    { ...loadConfig({}), port: 0, evidenceDir, frameTimeoutMs: 1000 },
    { adapter: samAdapter('NO_RISK_OBSERVED'), explainer: spark, now: () => new Date(base + tick++ * 3000) },
  );
  const server = Object.assign(running, { evidenceDir });
  const c = await startAndBlock(server as Awaited<ReturnType<typeof newServer>>);
  t.after(async () => {
    await c.close();
    await running.close();
    await rm(evidenceDir, { recursive: true, force: true });
  });
  const blocked = await c.waitFor((m) => m.type === 'plc.state' && m.payload.state === 'BLOCKED');
  assert.equal(blocked.type === 'plc.state' && blocked.payload.reason, 'STALE_RESULT');
  // Vencida ya al decidir: nunca pasó por ENABLED.
  assert.equal(c.inbox.some((m) => m.type === 'plc.state' && m.payload.state === 'ENABLED'), false);
  await settle();
  assert.equal(spark.calls, 0);
  assert.equal(wearables(c.inbox).length, 0);
});

// Spark que contesta recién cuando el test lo suelta.
function sparkOnDemand() {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const inner = sparkReply();
  const ex: Explainer & { calls: number; release: () => void } = {
    id: 'spark-gate',
    calls: 0,
    release: () => release(),
    explain: async (input) => {
      ex.calls++;
      await gate;
      return inner.explain(input);
    },
  };
  return ex;
}

for (const second of ['RISK_OBSERVED', 'NO_RISK_OBSERVED'] as const) {
  test(`wearable: Spark que llega después de un segundo pedido (${second}) no reenvía el aviso viejo`, async (t) => {
    let status: 'RISK_OBSERVED' | 'NO_RISK_OBSERVED' = 'RISK_OBSERVED';
    const adapter: PerceptionAdapter = {
      id: 'sam-spy',
      analyze: async () => samAdapter(status).analyze({} as never),
    };
    const spark = sparkOnDemand();
    const server = await newServer(1000, adapter, spark, { inferenceTimeoutMs: 5000 });
    const c = await startAndBlock(server);
    t.after(async () => {
      spark.release();
      await c.close();
      await server.close();
    });
    const a = await c.waitFor((m) => m.type === 'wearable.notify');
    assert.ok(a.type === 'wearable.notify');
    await c.waitFor(() => spark.calls === 1);
    status = second;
    c.send('start.request', { machineId: 'pg-01', authorizationId: 'auth-2' });
    if (second === 'RISK_OBSERVED') {
      await c.waitFor((m) => m.type === 'wearable.notify' && m.payload.notificationId !== a.payload.notificationId);
    } else {
      await c.waitFor((m) => m.type === 'plc.state' && m.payload.state === 'RUNNING');
    }
    const before = c.inbox.length;
    spark.release();
    await settle(300);
    assert.equal(spark.calls, 1);
    assert.equal(
      c.inbox.slice(before).some((m) => m.type === 'wearable.notify'),
      false,
    );
    assert.equal(wearables(c.inbox).some((m) => m.payload.source === 'muse-spark-1.3'), false);
    // Queda en la evidencia del frame viejo como no enviado.
    const meta = JSON.parse(await readFile(join(server.evidenceDir, `${a.payload.frameId}.json`), 'utf8'));
    assert.equal(meta.evaluation.wearableSuppressed.notificationId, a.payload.notificationId);
    assert.equal(meta.evaluation.wearableSuppressed.source, 'muse-spark-1.3');
    assert.deepEqual(meta.evaluation.wearable.map((w: { source: string }) => w.source), ['template']);
  });
}

// ── explicación como evidencia del frame evaluado ───────────────────
// SIMULACIÓN: SAM y Spark de prueba; prueban el cableado, no una detección.
const perceptions = (inbox: ServerMessage[]) =>
  inbox.filter((m): m is Extract<ServerMessage, { type: 'perception.state' }> => m.type === 'perception.state');

test('evidencia: Spark llega con la observación vencida ⇒ explanation null, evidenceExplanation atada a ese frame; al desconectar se cae', async (t) => {
  const spark = sparkOnDemand();
  const server = await newServer(1000, samAdapter('RISK_OBSERVED'), spark, { freshnessTtlMs: 300 });
  const c = await startAndBlock(server);
  t.after(async () => {
    spark.release();
    await c.close();
    await server.close();
  });
  await c.waitFor(() => spark.calls === 1);
  const stale = await c.waitFor((m) => m.type === 'perception.state' && m.payload.status === 'STALE_RESULT', 4000);
  assert.ok(stale.type === 'perception.state' && stale.payload.frame);
  assert.equal(stale.payload.evidenceExplanation, null);
  spark.release();
  const per = await c.waitFor((m) => m.type === 'perception.state' && m.payload.evidenceExplanation !== null);
  assert.ok(per.type === 'perception.state' && per.payload.frame && per.payload.evidenceExplanation);
  assert.equal(per.payload.status, 'STALE_RESULT');
  assert.equal(per.payload.explanation, null);
  assert.equal(per.payload.overlay, null);
  assert.equal(per.payload.evidenceExplanation.frameId, stale.payload.frame.frameId);
  assert.equal(per.payload.evidenceExplanation.frameId, per.payload.frame.frameId);
  assert.equal(per.payload.evidenceExplanation.model, 'muse-spark-1.3');
  assert.equal(per.payload.evidenceExplanation.text, 'A worker stands under the crane load inside the work zone.');
  c.send('camera.status', { cameraId: 'cam-01', connected: false });
  const gone = await c.waitFor((m) => m.type === 'perception.state' && m.payload.status === 'NO_CAMERA');
  assert.equal(gone.type === 'perception.state' && gone.payload.evidenceExplanation, null);
  // Que terminen de escribirse las enmiendas de la evidencia antes de borrar el dir.
  await settle();
});

test('evidencia: un pedido nuevo la borra antes de que Spark conteste, y la respuesta tarde del frame viejo no se pega al nuevo', async (t) => {
  // La 1.ª consulta contesta enseguida; la 2.ª espera al test (la tarde). La
  // 3.ª evaluación llega con la 2.ª en vuelo: su Spark sale "already in flight".
  const fast = sparkReply();
  const slow = sparkOnDemand();
  let calls = 0;
  const spark: Explainer = { id: 'spark-mixed', explain: (i) => (++calls === 1 ? fast.explain(i) : slow.explain(i)) };
  const server = await newServer(1000, samAdapter('RISK_OBSERVED'), spark);
  const c = await startAndBlock(server);
  t.after(async () => {
    slow.release();
    await c.close();
    await server.close();
  });
  const first = await c.waitFor((m) => m.type === 'perception.state' && m.payload.evidenceExplanation !== null);
  assert.ok(first.type === 'perception.state' && first.payload.frame);
  const frameA = first.payload.frame.frameId;
  // Frame B: la evidencia de A se cae antes de que Spark conteste por B.
  c.send('start.request', { machineId: 'pg-01', authorizationId: 'auth-2' });
  const b = await c.waitFor((m) => m.type === 'perception.state' && !!m.payload.frame && m.payload.frame.frameId !== frameA);
  assert.ok(b.type === 'perception.state' && b.payload.frame);
  assert.equal(b.payload.evidenceExplanation, null);
  const frameB = b.payload.frame.frameId;
  await c.waitFor(() => slow.calls === 1);
  // Frame C con la respuesta de B todavía pendiente.
  c.send('start.request', { machineId: 'pg-01', authorizationId: 'auth-3' });
  const cState = await c.waitFor(
    (m) => m.type === 'perception.state' && !!m.payload.frame && m.payload.frame.frameId !== frameA && m.payload.frame.frameId !== frameB,
  );
  assert.ok(cState.type === 'perception.state' && cState.payload.frame);
  const frameC = cState.payload.frame.frameId;
  const fromC = c.inbox.indexOf(cState);
  // Ahora sí contesta Spark por B, tarde.
  slow.release();
  await settle(300);
  assert.equal(slow.calls, 1);
  for (const m of perceptions(c.inbox.slice(fromC))) {
    assert.equal(m.payload.frame?.frameId, frameC);
    assert.notEqual(m.payload.evidenceExplanation?.frameId, frameB);
  }
  for (const m of perceptions(c.inbox)) {
    const e = m.payload.evidenceExplanation;
    if (e) assert.equal(e.frameId, m.payload.frame?.frameId);
  }
  const last = perceptions(c.inbox).at(-1)!;
  assert.equal(last.payload.frame?.frameId, frameC);
  assert.equal(last.payload.evidenceExplanation, null);
});
