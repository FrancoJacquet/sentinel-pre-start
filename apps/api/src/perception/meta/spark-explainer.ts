import { EXPLANATION_MAX_CHARS, SPARK_MODEL_ID, WEARABLE_TEXT_MAX_CHARS, type PerceptionOverlay } from '@sentinel/contracts';
import type { Advice, ExplainInput, ExplainPlcState, Explainer } from '../types.ts';
import { extractOutputText, META_RESPONSES_URL } from './sam-adapter.ts';
import type { SpendGuard } from './spend-guard.ts';

// Muse Spark 1.3 (texto + imagen → texto) COMUNICA: explica al operario por
// qué se bloqueó o habilitó el arranque y redacta el aviso para el reloj del
// técnico. No decide: se consulta con la decisión del PLC ya tomada (SAM + la
// regla de zona) y, si falla, no cambia nada (ver advice-rule.ts).
// Standard mode: el contenido no se usa para entrenar. Nunca `-contributor`.
export const SPARK_MODEL = SPARK_MODEL_ID;
// Respuesta corta: un JSON con ≤ 200 caracteres de explicación y ≤ 140 de
// aviso, pero Spark razona dentro de este tope: con 300 las dos primeras
// llamadas reales (2026-11-04) volvieron `incomplete`. Si igual no alcanza,
// status ≠ completed ⇒ fallo, no se adivina. Con 2048 una de tres volvió
// incompleta; peor caso con 4096 ≈ US$0,017 de salida.
export const SPARK_MAX_OUTPUT_TOKENS = 4096;

export interface MetaSparkExplainerOptions {
  apiKey: string;
  // Ledger propio (meta-spark-spend.json), aparte del de SAM.
  guard: SpendGuard;
  // Inyectable: los tests nunca tocan la red.
  fetch: typeof globalThis.fetch;
}

const pt = ([x, y]: readonly [number, number]) => `(${Math.round(x)},${Math.round(y)})`;

// Contexto de la decisión ya tomada. Como Spark no juzga la compuerta, se le
// puede decir qué pasó; a cambio, `person_in_zone_visible` queda sesgado hacia
// esa decisión y sólo sirve como nota (advice-rule.ts), nunca como chequeo.
const DECISION_CONTEXT: Record<ExplainPlcState, string> = {
  BLOCKED: 'An energize request for overhead crane PG-01 was just BLOCKED because the vision check detected a person in the work zone.',
  ENABLED: 'An energize request for overhead crane PG-01 was just ALLOWED because the vision check detected no person in the work zone.',
};
const ALERT_RULE: Record<ExplainPlcState, string> = {
  BLOCKED: `a direct, short warning (at most ${WEARABLE_TEXT_MAX_CHARS} characters) for the technician inside the work zone, shown on their watch: someone is trying to energize the crane and they are under the load. Never say it is safe`,
  ENABLED: 'always null',
};

// Texto que acompaña al JPEG: el polígono calibrado y la decisión ya tomada.
// No lleva las cajas de SAM ni la verdad del simulador. Lo que SAM vio queda
// aparte en la evidencia.
export function buildSparkPrompt(overlay: PerceptionOverlay, plcState: ExplainPlcState): string {
  return [
    `This is a ${overlay.width}x${overlay.height} frame from camera CAM-01 of a 3D factory simulation.`,
    `Work zone polygon in image pixels: ${overlay.polygon.map(pt).join(' ')}.`,
    DECISION_CONTEXT[plcState],
    'Look at the image yourself. Reply with ONLY a JSON object, no markdown:',
    `{"explanation": string (at most ${EXPLANATION_MAX_CHARS} characters, plain English, for the operator at the switch: why the start was blocked or allowed, describing what is visible), "technician_alert": string or null (${ALERT_RULE[plcState]}), "person_in_zone_visible": boolean (true if you see any person inside the work zone polygon)}`,
  ].join('\n');
}

export function buildSparkRequest(jpegBase64: string, prompt: string) {
  return {
    model: SPARK_MODEL,
    input: [
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: prompt },
          { type: 'input_image', image_url: `data:image/jpeg;base64,${jpegBase64}` },
        ],
      },
    ],
    stream: false,
    // Sin copia del lado de Meta (default true).
    store: false,
    max_output_tokens: SPARK_MAX_OUTPUT_TOKENS,
  };
}

// JSON estricto: un objeto con exactamente las tres claves y sus tipos. Se
// tolera sólo un bloque ```json alrededor; cualquier otra cosa es error (no se
// adivina ni se recorta el texto del modelo).
export function parseSparkOutput(text: string): { explanation: string; technicianAlert: string | null; personInZoneVisible: boolean } {
  let body = text.trim();
  const fence = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/.exec(body);
  if (fence) body = fence[1]!.trim();
  // Motivos fijos: el texto del modelo no viaja en `reason` (llega al detail
  // que ve el navegador); el crudo queda en la evidencia (advice.raw).
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error('spark output not JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('spark output is not a JSON object');
  const keys = Object.keys(parsed).sort();
  if (keys.join(',') !== 'explanation,person_in_zone_visible,technician_alert') throw new Error('spark output wrong keys');
  const { explanation, technician_alert, person_in_zone_visible } = parsed as Record<string, unknown>;
  if (typeof person_in_zone_visible !== 'boolean') throw new Error('person_in_zone_visible is not a boolean');
  if (typeof explanation !== 'string') throw new Error('explanation is not a string');
  const trimmed = explanation.trim();
  if (trimmed.length === 0 || trimmed.length > EXPLANATION_MAX_CHARS) {
    throw new Error(`explanation length ${trimmed.length} outside 1..${EXPLANATION_MAX_CHARS}`);
  }
  // Aviso vacío = sin aviso; uno largo es error (no se recorta).
  if (technician_alert !== null && typeof technician_alert !== 'string') throw new Error('technician_alert is not a string or null');
  const alert = technician_alert?.trim() || null;
  if (alert && alert.length > WEARABLE_TEXT_MAX_CHARS) {
    throw new Error(`technician_alert length ${alert.length} > ${WEARABLE_TEXT_MAX_CHARS}`);
  }
  return { explanation: trimmed, technicianAlert: alert, personInZoneVisible: person_in_zone_visible };
}

function errorMessage(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 200);
}

// Una consulta por observación de SAM, con su propio tope persistente,
// concurrencia 1 y sin reintentos. Nunca tira: cualquier fallo vuelve como
// `ok: false` con el motivo (el timeout lo pone el gateway).
export class MetaSparkExplainer implements Explainer {
  readonly id = 'meta-muse-spark-1.3';
  readonly #opts: MetaSparkExplainerOptions;

  constructor(opts: MetaSparkExplainerOptions) {
    this.#opts = opts;
  }

  async explain({ frame, samStatus, plcState, overlay, signal }: ExplainInput): Promise<Advice> {
    const { apiKey, guard } = this.#opts;
    const prompt = buildSparkPrompt(overlay, plcState);
    const base = { model: SPARK_MODEL, samStatus, text: null, technicianAlert: null, personInZoneVisible: null, raw: null, request: null, prompt };

    let slot;
    try {
      slot = await guard.reserve(SPARK_MODEL, frame.frameId);
    } catch (err) {
      return { ...base, ok: false, reason: `spark ledger: ${errorMessage(err)}` };
    }
    if (!slot.ok) {
      const reason = slot.reason === 'budget' ? `spark budget ${slot.used}/${slot.max}` : 'spark request already in flight';
      return { ...base, ok: false, reason };
    }
    const request = `${slot.used}/${slot.max}`;
    let raw: string | null = null;
    try {
      const res = await this.#opts.fetch(META_RESPONSES_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(buildSparkRequest(frame.bytes.toString('base64'), prompt)),
        signal,
      });
      // Sólo el código: el cuerpo de error no se copia a logs ni a la UI.
      if (!res.ok) throw new Error(`meta http ${res.status}`);
      raw = extractOutputText(await res.json());
      const out = parseSparkOutput(raw);
      return { ...base, ok: true, reason: null, raw, request, text: out.explanation, technicianAlert: out.technicianAlert, personInZoneVisible: out.personInZoneVisible };
    } catch (err) {
      return { ...base, ok: false, reason: errorMessage(err), raw, request };
    } finally {
      guard.release();
    }
  }
}
