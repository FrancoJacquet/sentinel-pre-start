import type { Advice } from './types.ts';

export const DISAGREE_DETAIL = 'models disagree: Muse Spark sees a person in the work zone; SAM decision stands';
export const RISK_DISAGREE_DETAIL = 'models disagree: Muse Spark sees nobody; SAM decision stands';

// Desacuerdo entre Spark y SAM sobre el mismo frame. Sólo se ANOTA (evidencia
// y detail): Spark llega con la decisión del PLC ya tomada y nunca la cambia,
// ni para endurecer ni para aflojar. Decide SAM + la regla de zona. Si SAM no
// vio a nadie y Spark sí, el PLC pudo haber habilitado igual: es una
// limitación conocida de la demo y queda registrada, no se oculta. Un fallo
// del explicador (ok=false) no es desacuerdo.
export function disagreementNote(samStatus: Advice['samStatus'], advice: Advice | null): string | null {
  if (advice?.ok !== true || advice.personInZoneVisible === null) return null;
  if (samStatus === 'NO_RISK_OBSERVED' && advice.personInZoneVisible) return DISAGREE_DETAIL;
  if (samStatus === 'RISK_OBSERVED' && !advice.personInZoneVisible) return RISK_DISAGREE_DETAIL;
  return null;
}
