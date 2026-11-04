import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROTOCOL_VERSION,
  parseClientMessage,
  parseServerMessage,
  isStartAllowedStatus,
  PERCEPTION_STATUSES,
} from './index.ts';

const base = { v: PROTOCOL_VERSION, seq: 1, ts: '2026-10-27T12:00:00.000Z', correlationId: 'c-1' };

test('start.request válido con autorización nueva', () => {
  const msg = parseClientMessage({
    ...base,
    type: 'start.request',
    requestId: 'r-1',
    payload: { machineId: 'pg-01', authorizationId: 'auth-abc' },
  });
  assert.equal(msg.type, 'start.request');
});

test('start.request sin authorizationId se rechaza', () => {
  assert.throws(() =>
    parseClientMessage({ ...base, type: 'start.request', requestId: 'r-1', payload: { machineId: 'pg-01' } }),
  );
});

test('versión de protocolo distinta se rechaza', () => {
  assert.throws(() =>
    parseClientMessage({
      ...base,
      v: PROTOCOL_VERSION + 1,
      type: 'stop.request',
      requestId: 'r-2',
      payload: { machineId: 'pg-01' },
    }),
  );
});

test('tipo desconocido se rechaza', () => {
  assert.throws(() => parseClientMessage({ ...base, type: 'plc.force_enable', requestId: 'r', payload: {} }));
});

test('perception.state lleva fuente y antigüedad', () => {
  const msg = parseServerMessage({
    ...base,
    type: 'perception.state',
    payload: {
      cameraId: 'cam-01',
      status: 'INFERENCE_DISABLED',
      source: 'none',
      observedAt: null,
      freshnessTtlMs: 2000,
      detail: 'META_API_ENABLED=false',
    },
  });
  assert.equal(msg.type, 'perception.state');
});

test('sólo NO_RISK_OBSERVED es un estado que permite arrancar', () => {
  const allowed = PERCEPTION_STATUSES.filter(isStartAllowedStatus);
  assert.deepEqual(allowed, ['NO_RISK_OBSERVED']);
});

test('frame.capture válido: JPEG en base64 con frameId pedido por el servidor', () => {
  const msg = parseClientMessage({
    ...base,
    type: 'frame.capture',
    requestId: 'r-9',
    payload: {
      cameraId: 'cam-01',
      frameRequestId: 'fr-1',
      frameId: 'f-1',
      captureTs: '2026-10-27T12:00:00.100Z',
      width: 1280,
      height: 720,
      mime: 'image/jpeg',
      sceneRevision: 'hall-v1',
      dataBase64: '/9j/2Q==',
      simTruth: { operatorInZone: true },
    },
  });
  assert.equal(msg.type, 'frame.capture');
});

test('frame.capture con otro formato de imagen se rechaza', () => {
  assert.throws(() =>
    parseClientMessage({
      ...base,
      type: 'frame.capture',
      requestId: 'r-9',
      payload: {
        cameraId: 'cam-01',
        frameRequestId: 'fr-1',
        frameId: 'f-1',
        captureTs: '2026-10-27T12:00:00.100Z',
        width: 1280,
        height: 720,
        mime: 'image/gif',
        sceneRevision: 'hall-v1',
        dataBase64: 'R0lG',
        simTruth: { operatorInZone: false },
      },
    }),
  );
});

test('perception.state puede referenciar el frame evaluado', () => {
  const msg = parseServerMessage({
    ...base,
    type: 'perception.state',
    payload: {
      cameraId: 'cam-01',
      status: 'INFERENCE_DISABLED',
      source: 'none',
      observedAt: null,
      freshnessTtlMs: 2000,
      detail: null,
      frame: { frameId: 'f-1', receivedAt: '2026-10-27T12:00:00.200Z', sha256: 'a'.repeat(64), width: 1280, height: 720 },
    },
  });
  assert.equal(msg.type === 'perception.state' && msg.payload.frame?.frameId, 'f-1');
});

const perceptionBase = {
  cameraId: 'cam-01',
  status: 'RISK_OBSERVED',
  source: 'model',
  observedAt: '2026-10-27T12:00:01.000Z',
  freshnessTtlMs: 2000,
  detail: null,
};
const person = { x1: 560, y1: 200, x2: 660, y2: 560, c: 0.91, foot: [610, 560], inZone: true };
const overlay = { width: 1280, height: 720, polygon: [[526, 663], [869, 450], [684, 352], [361, 492]], persons: [person] };
const perception = (payload: object) => parseServerMessage({ ...base, type: 'perception.state', payload: { ...perceptionBase, ...payload } });

test('perception.state sin overlay ⇒ null por defecto (no hubo modelo)', () => {
  const msg = perception({});
  assert.equal(msg.type === 'perception.state' && msg.payload.overlay, null);
});

test('perception.state con el overlay del modelo: polígono y personas con pie y zona', () => {
  const msg = perception({ overlay });
  assert.ok(msg.type === 'perception.state' && msg.payload.overlay);
  assert.deepEqual(msg.payload.overlay.persons[0]!.foot, [610, 560]);
  assert.equal(msg.payload.overlay.persons[0]!.inZone, true);
});

test('overlay: confianza puede faltar (null) y la lista de personas puede estar vacía', () => {
  assert.doesNotThrow(() => perception({ overlay: { ...overlay, persons: [{ ...person, c: null }] } }));
  assert.doesNotThrow(() => perception({ overlay: { ...overlay, persons: [] } }));
});

test('overlay inválido se rechaza: tamaño no positivo, vértice no entero, demasiados', () => {
  assert.throws(() => perception({ overlay: { ...overlay, width: 0 } }));
  assert.throws(() => perception({ overlay: { ...overlay, height: 1.5 } }));
  assert.throws(() => perception({ overlay: { ...overlay, polygon: [[1.5, 2]] } }));
  assert.throws(() => perception({ overlay: { ...overlay, polygon: Array.from({ length: 17 }, () => [1, 2]) } }));
  assert.throws(() => perception({ overlay: { ...overlay, persons: Array.from({ length: 33 }, () => person) } }));
  assert.throws(() => perception({ overlay: { ...overlay, persons: [{ ...person, inZone: undefined }] } }));
  assert.throws(() => perception({ overlay: { ...overlay, persons: [{ ...person, foot: [1] }] } }));
});

test('perception.state sin explicación ⇒ null por defecto', () => {
  const msg = perception({ overlay });
  assert.equal(msg.type === 'perception.state' && msg.payload.explanation, null);
});

test('explicación de Muse Spark: modelo fijo y texto 1–200 caracteres', () => {
  const msg = perception({ overlay, explanation: { model: 'muse-spark-1.3', text: 'A worker stands inside the zone.' } });
  assert.equal(msg.type === 'perception.state' && msg.payload.explanation?.text, 'A worker stands inside the zone.');
  assert.doesNotThrow(() => perception({ explanation: { model: 'muse-spark-1.3', text: 'x'.repeat(200) } }));
  assert.throws(() => perception({ explanation: { model: 'muse-spark-1.3', text: 'x'.repeat(201) } }));
  assert.throws(() => perception({ explanation: { model: 'muse-spark-1.3', text: '' } }));
  assert.throws(() => perception({ explanation: { model: 'muse-spark-1.3-contributor', text: 'ok' } }));
  assert.throws(() => perception({ explanation: { model: 'muse-spark-1.3' } }));
});

test('explicación como evidencia: frameId, modelo fijo, texto 1–200 y hora; null por defecto', () => {
  const ok = { frameId: 'f-1', model: 'muse-spark-1.3', text: 'A worker stands inside the zone.', at: '2026-10-27T12:00:12.000Z' };
  const msg = perception({ status: 'STALE_RESULT', evidenceExplanation: ok });
  assert.deepEqual(msg.type === 'perception.state' && msg.payload.evidenceExplanation, ok);
  const none = perception({});
  assert.equal(none.type === 'perception.state' && none.payload.evidenceExplanation, null);
  assert.throws(() => perception({ evidenceExplanation: { ...ok, frameId: '' } }));
  assert.throws(() => perception({ evidenceExplanation: { ...ok, frameId: undefined } }));
  assert.throws(() => perception({ evidenceExplanation: { ...ok, at: 'ayer' } }));
  assert.throws(() => perception({ evidenceExplanation: { ...ok, text: 'x'.repeat(201) } }));
  assert.throws(() => perception({ evidenceExplanation: { ...ok, model: 'muse-spark-1.3-contributor' } }));
});

const wearable = (payload: Record<string, unknown>) =>
  parseServerMessage({
    ...base,
    type: 'wearable.notify',
    payload: {
      notificationId: 'wn-1',
      at: '2026-10-27T12:00:00.000Z',
      recipient: 'technician',
      frameId: 'f-1',
      severity: 'warning',
      text: 'Energize request blocked: you are in the work zone.',
      source: 'template',
      simulated: true,
      ...payload,
    },
  });

test('wearable.notify: aviso simulado al técnico, texto fijo o de Muse Spark', () => {
  const msg = wearable({});
  assert.equal(msg.type === 'wearable.notify' && msg.payload.source, 'template');
  assert.doesNotThrow(() => wearable({ source: 'muse-spark-1.3', text: 'x'.repeat(140) }));
  assert.doesNotThrow(() => wearable({ frameId: null }));
});

test('wearable.notify inválido se rechaza: sin rótulo de simulación, otro destinatario o severidad, texto vacío o largo, otra fuente', () => {
  assert.throws(() => wearable({ simulated: false }));
  assert.throws(() => wearable({ simulated: undefined }));
  assert.throws(() => wearable({ recipient: 'operator' }));
  assert.throws(() => wearable({ severity: 'info' }));
  assert.throws(() => wearable({ text: '' }));
  assert.throws(() => wearable({ text: 'x'.repeat(141) }));
  assert.throws(() => wearable({ source: 'muse-spark-1.3-contributor' }));
  assert.throws(() => wearable({ at: 'yesterday' }));
});
