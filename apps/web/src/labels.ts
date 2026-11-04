import type { PerceptionStatus, PlcState, WearableSource } from '@sentinel/contracts';

// Toda la UI va en inglés: es lo que lee el jurado global. Los comentarios
// siguen en español, como el resto del repo.

export const PLC_LABEL: Record<PlcState, string> = {
  IDLE: 'De-energized',
  START_REQUESTED: 'Checking work zone',
  BLOCKED: 'Energization blocked',
  ENABLED: 'Energization enabled',
  RUNNING: 'Energized',
  STOPPED: 'De-energized',
};

export const REASON_LABEL: Record<string, string> = {
  NO_CAMERA: 'CAM-01 is disconnected.',
  CAPTURE_FAILED: 'CAM-01 did not deliver a valid frame.',
  INFERENCE_DISABLED: 'Inference is off: no evidence that the work zone is clear.',
  BUDGET_EXHAUSTED: 'Inference spend cap reached.',
  MODEL_ERROR: 'The model returned an error.',
  STALE_RESULT: 'Results expire after 2 s on purpose; the next ENERGIZE checks the zone again.',
  UNVERIFIED: 'The work zone has not been checked yet.',
  RISK_OBSERVED: 'Person detected in work zone.',
  NO_RISK_OBSERVED: 'The model observed the work zone clear.',
  AUTHORIZATION_REUSED: 'That authorization was already used. Each ENERGIZE needs a new one.',
  INVALID_TRANSITION: 'The request does not match the current state.',
};

// Alertas del servidor: se rotulan por código (el texto del servidor puede
// venir en otro idioma). Código desconocido ⇒ se muestra el texto tal cual.
export const ALERT_LABEL: Record<string, string> = {
  NO_CAMERA: 'Energization blocked: CAM-01 is disconnected.',
  CAPTURE_FAILED: 'Energization blocked: CAM-01 did not deliver a valid frame.',
  INFERENCE_DISABLED: 'Energization blocked: inference is off, no evidence that the work zone is clear.',
  BUDGET_EXHAUSTED: 'Energization blocked: inference spend cap reached.',
  MODEL_ERROR: 'Energization blocked: model error.',
  STALE_RESULT: 'Energization blocked: the evidence has expired.',
  UNVERIFIED: 'Energization blocked: work zone not checked.',
  RISK_OBSERVED: 'Energization blocked: person detected in work zone.',
  AUTHORIZATION_REUSED: 'Energization blocked: authorization already used; each ENERGIZE needs a new one.',
};

export function alertText(code: string, serverMessage: string): string {
  return ALERT_LABEL[code] ?? serverMessage;
}

export type ZoneVerdict = 'clear' | 'risk' | 'unknown';

// UNKNOWN nunca es zona segura: todo lo que no sea una observación cuenta como
// desconocido.
export function zoneVerdict(status: PerceptionStatus | undefined): ZoneVerdict {
  if (status === 'NO_RISK_OBSERVED') return 'clear';
  if (status === 'RISK_OBSERVED') return 'risk';
  return 'unknown';
}

export const ZONE_LABEL: Record<ZoneVerdict, string> = {
  clear: 'Work zone clear',
  risk: 'Person in work zone',
  unknown: 'Work zone unknown',
};

// Título de la zona. Un resultado vencido sigue siendo UNKNOWN (no habilita),
// pero se dice qué pasó: venció, no "se perdió" la cámara.
export function zoneTitle(status: PerceptionStatus | undefined): string {
  if (status === 'STALE_RESULT') return 'Last check expired';
  return ZONE_LABEL[zoneVerdict(status)];
}

// Sufijo aleatorio del frameId (f-<fecha>-<hex>): alcanza para reconocerlo.
export function shortFrameId(frameId: string): string {
  const m = /-([0-9a-f]{4,})$/.exec(frameId);
  return m ? m[1]! : frameId;
}

export interface OverlayPerson {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  c: number | null;
  foot: [number, number];
  inZone: boolean;
}

export function personsSummary(persons: readonly OverlayPerson[]): string {
  if (!persons.length) return 'No person detected';
  const inZone = persons.filter((p) => p.inZone).length;
  return `${persons.length} ${persons.length === 1 ? 'person' : 'persons'} · ${inZone} in work zone`;
}

// La salida del modelo sólo se dibuja como actual si es una observación fresca
// del modelo. Vencida, de simulación o sin overlay ⇒ no se dibuja: una
// detección vieja nunca se muestra como actual.
export function overlayDrawable(
  p: { source: string; status: PerceptionStatus; overlay?: unknown } | null | undefined,
): boolean {
  return !!p && p.source === 'model' && zoneVerdict(p.status) !== 'unknown' && p.overlay != null;
}

export const EXPLANATION_LABEL = 'Muse Spark 1.3:';

// Explicación de Muse Spark: misma regla que el overlay (sólo con observación
// fresca del modelo). El texto es el del modelo tal cual; la UI no inventa nada.
export function liveExplanation(
  p: { source: string; status: PerceptionStatus; overlay?: unknown; explanation?: { text: string } | null } | null | undefined,
): string | null {
  return overlayDrawable(p) && p!.explanation?.text ? p!.explanation.text : null;
}

// Explicación de Muse Spark como EVIDENCIA del frame evaluado que se muestra
// (llega después de decidido, casi siempre con la observación ya vencida). Sólo
// si es de ESE frame: con otro frameId, o sin frame mostrado, no hay línea. La
// hora es la de la respuesta de Spark (después de la decisión), y se rotula así
// para que no se lea como una observación más nueva que el frame.
export function evidenceExplanationLine(
  e: { frameId: string; text: string; at: string } | null | undefined,
  shownFrameId: string | null | undefined,
): string | null {
  if (!e || !shownFrameId || e.frameId !== shownFrameId || !e.text) return null;
  const at = new Date(e.at);
  if (Number.isNaN(at.getTime())) return null;
  return `Muse Spark 1.3 · explained ${at.toLocaleTimeString('en-GB', { hour12: false })} — ${e.text}`;
}

// De dónde salió el texto del reloj simulado: fijo (no espera a una IA) o
// reescrito por Muse Spark para el mismo frame.
export const WEARABLE_SOURCE_LABEL: Record<WearableSource, string> = {
  template: 'fixed warning',
  'muse-spark-1.3': 'Muse Spark 1.3',
};
