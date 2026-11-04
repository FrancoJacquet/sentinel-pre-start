// Estados de percepción. Todo lo que no sea NO_RISK_OBSERVED fresco es UNKNOWN
// para el PLC: no habilita el arranque.
export const PERCEPTION_STATUSES = [
  'NO_CAMERA',
  'CAPTURE_FAILED',
  'INFERENCE_DISABLED',
  'BUDGET_EXHAUSTED',
  'MODEL_ERROR',
  'STALE_RESULT',
  'UNVERIFIED',
  'RISK_OBSERVED',
  'NO_RISK_OBSERVED',
] as const;

export type PerceptionStatus = (typeof PERCEPTION_STATUSES)[number];

export function isStartAllowedStatus(status: PerceptionStatus): boolean {
  return status === 'NO_RISK_OBSERVED';
}

// De dónde sale la evidencia. `simulation` = fixture rotulado, nunca salida de
// modelo; `none` = no hubo evidencia.
export const EVIDENCE_SOURCES = ['model', 'simulation', 'none'] as const;
export type EvidenceSource = (typeof EVIDENCE_SOURCES)[number];
