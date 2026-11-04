import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VirtualPLC, type PlcSnapshot } from './virtual-plc.ts';
import { PerceptionGateway } from '../perception/gateway.ts';
import { DisabledAdapter } from '../perception/disabled-adapter.ts';
import { FixtureAdapter } from '../perception/fixture-adapter.ts';
import type { PerceptionAdapter } from '../perception/types.ts';
import { fakeFrames } from '../perception/test-frames.ts';

const TTL = 2000;

function setup(adapter: PerceptionAdapter, { camera = true } = {}) {
  let t = Date.parse('2026-10-27T12:00:00.000Z');
  const now = () => new Date(t);
  const gw = new PerceptionGateway({
    adapter,
    frames: fakeFrames(now),
    freshnessTtlMs: TTL,
    timeoutMs: 1000,
    frameTimeoutMs: 1000,
    now,
  });
  if (camera) gw.setCameraConnected('cam-01', true);
  const history: PlcSnapshot[] = [];
  const plc = new VirtualPLC({
    machineId: 'pg-01',
    cameraId: 'cam-01',
    gateway: gw,
    onChange: (s) => history.push(s),
  });
  return { plc, gw, history, advance: (ms: number) => (t += ms) };
}

test('arranca en IDLE', () => {
  const { plc } = setup(new DisabledAdapter());
  assert.equal(plc.snapshot().state, 'IDLE');
});

test('inferencia apagada ⇒ BLOCKED con INFERENCE_DISABLED', async () => {
  const { plc, history } = setup(new DisabledAdapter());
  await plc.requestStart('auth-1');
  assert.deepEqual(
    history.map((s) => s.state),
    ['START_REQUESTED', 'BLOCKED'],
  );
  assert.equal(plc.snapshot().reason, 'INFERENCE_DISABLED');
});

test('sin cámara ⇒ BLOCKED con NO_CAMERA', async () => {
  const { plc } = setup(new FixtureAdapter('NO_RISK_OBSERVED'), { camera: false });
  await plc.requestStart('auth-1');
  assert.equal(plc.snapshot().state, 'BLOCKED');
  assert.equal(plc.snapshot().reason, 'NO_CAMERA');
});

test('riesgo observado ⇒ BLOCKED con RISK_OBSERVED', async () => {
  const { plc } = setup(new FixtureAdapter('RISK_OBSERVED'));
  await plc.requestStart('auth-1');
  assert.equal(plc.snapshot().state, 'BLOCKED');
  assert.equal(plc.snapshot().reason, 'RISK_OBSERVED');
});

test('error de modelo ⇒ BLOCKED con MODEL_ERROR', async () => {
  const adapter: PerceptionAdapter = {
    id: 'boom',
    analyze: async () => {
      throw new Error('boom');
    },
  };
  const { plc } = setup(adapter);
  await plc.requestStart('auth-1');
  assert.equal(plc.snapshot().reason, 'MODEL_ERROR');
});

test('zona libre fresca + autorización nueva ⇒ ENABLED', async () => {
  const { plc } = setup(new FixtureAdapter('NO_RISK_OBSERVED'));
  await plc.requestStart('auth-1');
  assert.equal(plc.snapshot().state, 'ENABLED');
  assert.equal(plc.snapshot().authorizationId, 'auth-1');
  assert.equal(plc.snapshot().reason, null);
});

test('evidencia vencida entre ENABLED y el arranque ⇒ BLOCKED con STALE_RESULT', async () => {
  const { plc, advance } = setup(new FixtureAdapter('NO_RISK_OBSERVED'));
  await plc.requestStart('auth-1');
  advance(TTL + 1);
  plc.machineStarted();
  assert.equal(plc.snapshot().state, 'BLOCKED');
  assert.equal(plc.snapshot().reason, 'STALE_RESULT');
});

test('ENABLED con evidencia fresca ⇒ RUNNING al arrancar la máquina simulada', async () => {
  const { plc } = setup(new FixtureAdapter('NO_RISK_OBSERVED'));
  await plc.requestStart('auth-1');
  plc.machineStarted();
  assert.equal(plc.snapshot().state, 'RUNNING');
});

test('cada arranque pide autorización nueva: reusar ⇒ BLOCKED AUTHORIZATION_REUSED', async () => {
  const { plc } = setup(new FixtureAdapter('NO_RISK_OBSERVED'));
  await plc.requestStart('auth-1');
  plc.machineStarted();
  plc.stop();
  assert.equal(plc.snapshot().state, 'STOPPED');
  await plc.requestStart('auth-1');
  assert.equal(plc.snapshot().state, 'BLOCKED');
  assert.equal(plc.snapshot().reason, 'AUTHORIZATION_REUSED');
});

test('una autorización usada en un pedido bloqueado tampoco se reusa', async () => {
  const { plc } = setup(new FixtureAdapter('RISK_OBSERVED'));
  await plc.requestStart('auth-1');
  await plc.requestStart('auth-1');
  assert.equal(plc.snapshot().reason, 'AUTHORIZATION_REUSED');
});

test('no autoarranque: BLOCKED no sale solo aunque la zona quede libre', async () => {
  let status: 'RISK_OBSERVED' | 'NO_RISK_OBSERVED' = 'RISK_OBSERVED';
  const adapter: PerceptionAdapter = {
    id: 'switch',
    analyze: async () => ({ status, source: 'simulation', detail: null }),
  };
  const { plc, gw, history } = setup(adapter);
  await plc.requestStart('auth-1');
  status = 'NO_RISK_OBSERVED';
  await gw.evaluate('cam-01');
  plc.machineStarted();
  assert.equal(plc.snapshot().state, 'BLOCKED');
  assert.deepEqual(
    history.map((s) => s.state),
    ['START_REQUESTED', 'BLOCKED'],
  );
});

test('pedido de arranque estando RUNNING no cambia el estado', async () => {
  const { plc } = setup(new FixtureAdapter('NO_RISK_OBSERVED'));
  await plc.requestStart('auth-1');
  plc.machineStarted();
  const result = await plc.requestStart('auth-2');
  assert.equal(result.accepted, false);
  assert.equal(plc.snapshot().state, 'RUNNING');
});

test('dos pedidos simultáneos: el segundo se rechaza sin cambiar el estado', async () => {
  const { plc } = setup(new FixtureAdapter('NO_RISK_OBSERVED'));
  const first = plc.requestStart('auth-1');
  const second = await plc.requestStart('auth-2');
  assert.equal(second.accepted, false);
  await first;
  assert.equal(plc.snapshot().state, 'ENABLED');
  assert.equal(plc.snapshot().authorizationId, 'auth-1');
});

test('stop durante la evaluación gana: no se pisa con ENABLED ni llega a RUNNING', async () => {
  let release!: () => void;
  const slow: PerceptionAdapter = {
    id: 'slow-fixture',
    async analyze() {
      await new Promise<void>((r) => (release = r));
      return new FixtureAdapter('NO_RISK_OBSERVED').analyze();
    },
  };
  const { plc, history } = setup(slow);
  const pending = plc.requestStart('auth-1');
  await new Promise((r) => setImmediate(r));
  assert.equal(plc.snapshot().state, 'START_REQUESTED');
  plc.stop();
  release();
  await pending;
  plc.machineStarted();
  assert.equal(plc.snapshot().state, 'STOPPED');
  assert.ok(!history.some((s) => s.state === 'ENABLED' || s.state === 'RUNNING'));
});
