import { SPARK_MODEL_ID, WEARABLE_TEXT_MAX_CHARS, type ServerPayload } from '@sentinel/contracts';
import type { Advice } from './perception/types.ts';

// Reloj SIMULADO del técnico en la zona. No hay hardware: es un mensaje
// wearable.notify que la escena dibuja en su muñeca.
export type WearableNotification = ServerPayload<'wearable.notify'>;

// Texto fijo (source 'template'): sale apenas el PLC bloquea, sin esperar a
// ninguna IA. No es una detección: sólo repite la decisión ya tomada.
export const WEARABLE_TEMPLATE_TEXT =
  'Energize request on PG-01 blocked — you are in the work zone. Stay clear until your lock is removed.';

// El reloj sólo advierte: un texto del modelo que suene a "es seguro / podés
// seguir" no sale (queda el fijo). Conservador a propósito: también descarta
// advertencias que usen esas palabras ("stay clear"). Sólo filtra al modelo;
// el texto fijo no pasa por acá.
const REASSURING =
  /\b(safe|safely|clear(ed)?|proceed|continue|go ahead|ok(ay)?|free to|you may|you can|no (risk|danger|hazard)|not (in danger|at risk|under))\b/i;

export function isWarningText(text: string): boolean {
  const t = text.trim();
  return t.length > 0 && t.length <= WEARABLE_TEXT_MAX_CHARS && !REASSURING.test(t);
}

// Aviso de Spark para reemplazar el texto fijo; null si no hay uno usable.
export function sparkAlertText(advice: Advice | null): string | null {
  // Si el mismo Spark dice que no ve a nadie, su aviso contradiría su propia
  // respuesta: queda el fijo.
  if (advice?.ok !== true || advice.model !== SPARK_MODEL_ID || advice.samStatus !== 'RISK_OBSERVED' || advice.personInZoneVisible !== true) return null;
  const text = advice.technicianAlert?.trim() ?? '';
  return isWarningText(text) ? text : null;
}
