import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PERCEPTION_STATUSES, PLC_BLOCK_REASONS, PLC_STATES, WEARABLE_SOURCES } from '@sentinel/contracts';
import {
  ALERT_LABEL,
  PLC_LABEL,
  REASON_LABEL,
  WEARABLE_SOURCE_LABEL,
  alertText,
  evidenceExplanationLine,
  liveExplanation,
  overlayDrawable,
  personsSummary,
  shortFrameId,
  zoneTitle,
  zoneVerdict,
} from './labels.ts';

test('todo estado y motivo tiene rótulo en inglés', () => {
  for (const st of PLC_STATES) assert.ok(PLC_LABEL[st], st);
  for (const r of [...PERCEPTION_STATUSES, ...PLC_BLOCK_REASONS]) assert.ok(REASON_LABEL[r], r);
  assert.equal(PLC_LABEL.BLOCKED, 'Energization blocked');
  assert.equal(REASON_LABEL.RISK_OBSERVED, 'Person detected in work zone.');
});

test('UNKNOWN nunca es zona libre', () => {
  assert.equal(zoneVerdict('NO_RISK_OBSERVED'), 'clear');
  assert.equal(zoneVerdict('RISK_OBSERVED'), 'risk');
  for (const st of PERCEPTION_STATUSES.filter((s) => !s.endsWith('_OBSERVED'))) assert.equal(zoneVerdict(st), 'unknown');
  assert.equal(zoneVerdict(undefined), 'unknown');
});

test('las alertas se rotulan por código, no por el texto del servidor', () => {
  assert.equal(alertText('INFERENCE_DISABLED', 'Arranque no habilitado: …'), ALERT_LABEL.INFERENCE_DISABLED);
  assert.match(alertText('INFERENCE_DISABLED', 'x'), /^Energization blocked: inference is off/);
  assert.match(alertText('RISK_OBSERVED', 'x'), /person detected in work zone/i);
  // Código desconocido: se muestra lo que dijo el servidor, sin inventar.
  assert.equal(alertText('NEW_CODE', 'Server text'), 'Server text');
});

test('id corto del frame: el sufijo aleatorio', () => {
  assert.equal(shortFrameId('f-20261103T165838413-d307c6'), 'd307c6');
  assert.equal(shortFrameId('raro'), 'raro');
});

test('resumen de personas del overlay', () => {
  const p = (inZone: boolean) => ({ x1: 0, y1: 0, x2: 1, y2: 1, c: 0.9, foot: [0, 1] as [number, number], inZone });
  assert.equal(personsSummary([]), 'No person detected');
  assert.equal(personsSummary([p(true)]), '1 person · 1 in work zone');
  assert.equal(personsSummary([p(true), p(false)]), '2 persons · 1 in work zone');
  assert.equal(personsSummary([p(false)]), '1 person · 0 in work zone');
});

test('el overlay sólo se dibuja como actual con una observación fresca del modelo', () => {
  const ov = { width: 1280, height: 720, polygon: [], persons: [] };
  assert.equal(overlayDrawable({ source: 'model', status: 'RISK_OBSERVED', overlay: ov }), true);
  assert.equal(overlayDrawable({ source: 'model', status: 'NO_RISK_OBSERVED', overlay: ov }), true);
  assert.equal(overlayDrawable({ source: 'model', status: 'STALE_RESULT', overlay: ov }), false);
  assert.equal(overlayDrawable({ source: 'simulation', status: 'RISK_OBSERVED', overlay: ov }), false);
  assert.equal(overlayDrawable({ source: 'model', status: 'RISK_OBSERVED', overlay: null }), false);
  assert.equal(overlayDrawable({ source: 'model', status: 'RISK_OBSERVED' }), false);
  assert.equal(overlayDrawable(null), false);
});

test('resultado vencido: sigue siendo unknown, pero el título dice que venció', () => {
  assert.equal(zoneVerdict('STALE_RESULT'), 'unknown');
  assert.equal(zoneTitle('STALE_RESULT'), 'Last check expired');
  assert.equal(zoneTitle('NO_CAMERA'), 'Work zone unknown');
  assert.equal(zoneTitle('RISK_OBSERVED'), 'Person in work zone');
});

test('la explicación de Muse Spark sólo se muestra con una observación fresca del modelo', () => {
  const overlay = { width: 1, height: 1, polygon: [], persons: [] };
  const explanation = { model: 'muse-spark-1.3', text: 'Nobody is in the zone.' };
  assert.equal(liveExplanation({ source: 'model', status: 'NO_RISK_OBSERVED', overlay, explanation }), 'Nobody is in the zone.');
  // Con RISK la API sólo manda un texto que coincide con SAM; si Spark no ve a
  // nadie, la explicación llega null (ver gateway) y no se contradice el bloqueo.
  const risk = { model: 'muse-spark-1.3', text: 'A worker is inside the zone.' };
  assert.equal(liveExplanation({ source: 'model', status: 'RISK_OBSERVED', overlay, explanation: risk }), 'A worker is inside the zone.');
  assert.equal(liveExplanation({ source: 'model', status: 'RISK_OBSERVED', overlay, explanation: null }), null);
  assert.equal(liveExplanation({ source: 'model', status: 'STALE_RESULT', overlay, explanation }), null);
  assert.equal(liveExplanation({ source: 'none', status: 'UNVERIFIED', overlay: null, explanation }), null);
  assert.equal(liveExplanation({ source: 'model', status: 'NO_RISK_OBSERVED', overlay, explanation: null }), null);
  assert.equal(liveExplanation(null), null);
});

test('explicación como evidencia: sólo junto al frame con el mismo frameId', () => {
  const at = '2026-10-27T12:00:12.000Z';
  const hhmmss = new Date(at).toLocaleTimeString('en-GB', { hour12: false });
  const e = { frameId: 'f-1', model: 'muse-spark-1.3', text: 'A worker is inside the zone.', at };
  assert.equal(evidenceExplanationLine(e, 'f-1'), `Muse Spark 1.3 · explained ${hhmmss} — A worker is inside the zone.`);
  assert.match(hhmmss, /^\d{2}:\d{2}:\d{2}$/);
  assert.equal(evidenceExplanationLine(e, 'f-2'), null);
  assert.equal(evidenceExplanationLine(e, null), null);
  assert.equal(evidenceExplanationLine(null, 'f-1'), null);
  assert.equal(evidenceExplanationLine({ ...e, at: 'ayer' }, 'f-1'), null);
});

test('el reloj simulado rotula la fuente de cada texto posible', () => {
  for (const s of WEARABLE_SOURCES) assert.ok(WEARABLE_SOURCE_LABEL[s], s);
  assert.equal(WEARABLE_SOURCE_LABEL.template, 'fixed warning');
});
