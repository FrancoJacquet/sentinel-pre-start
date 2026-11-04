import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WEARABLE_TEXT_MAX_CHARS } from '@sentinel/contracts';
import { isWarningText, sparkAlertText, WEARABLE_TEMPLATE_TEXT } from './wearable.ts';
import type { Advice } from './perception/types.ts';

// SIMULACIÓN: avisos armados a mano; prueban el filtro, no al modelo.
const advice = (over: Partial<Advice>): Advice => ({
  model: 'muse-spark-1.3',
  ok: true,
  samStatus: 'RISK_OBSERVED',
  text: 't',
  technicianAlert: 'Someone is trying to energize the crane above you. Step out now.',
  personInZoneVisible: true,
  reason: null,
  prompt: '',
  raw: '',
  request: '1/1',
  ...over,
});

test('el texto fijo es una advertencia válida para el contrato', () => {
  // El fijo no pasa por el filtro del modelo (dice "Stay clear").
  assert.ok(WEARABLE_TEMPLATE_TEXT.length > 0 && WEARABLE_TEMPLATE_TEXT.length <= WEARABLE_TEXT_MAX_CHARS);
});

test('el reloj nunca dice que es seguro ni que puede seguir', () => {
  for (const t of [
    'You are safe.',
    'All clear, carry on.',
    'You may proceed.',
    'Go ahead, no risk.',
    'You can stay there safely.',
    'Zone is clear.',
    "You're clear.",
    'Area cleared, energizing now.',
    'Area clear, energizing now.',
    'Proceed with the lift.',
    'Continue working.',
    'OK to stay.',
    'Okay, nothing to do.',
    'You are free to move.',
    'No hazard detected.',
    'You are not in danger.',
    'You are not at risk.',
    'You are not under the load.',
  ]) {
    assert.equal(isWarningText(t), false, t);
  }
  assert.equal(isWarningText('Unsafe: step out of the zone.'), true);
  assert.equal(isWarningText(''), false);
  assert.equal(isWarningText('x'.repeat(WEARABLE_TEXT_MAX_CHARS + 1)), false);
});

test('aviso de Spark: sólo ok, del modelo Standard, sobre RISK y con texto de advertencia', () => {
  assert.equal(sparkAlertText(advice({})), 'Someone is trying to energize the crane above you. Step out now.');
  assert.equal(sparkAlertText(null), null);
  assert.equal(sparkAlertText(advice({ ok: false })), null);
  assert.equal(sparkAlertText(advice({ model: 'muse-spark-1.3-contributor' })), null);
  assert.equal(sparkAlertText(advice({ samStatus: 'NO_RISK_OBSERVED' })), null);
  assert.equal(sparkAlertText(advice({ technicianAlert: null })), null);
  assert.equal(sparkAlertText(advice({ technicianAlert: 'You are safe now.' })), null);
  // Spark dice que no ve a nadie (RISK_DISAGREE): su aviso no sale.
  assert.equal(sparkAlertText(advice({ personInZoneVisible: false })), null);
  assert.equal(sparkAlertText(advice({ personInZoneVisible: null })), null);
});
