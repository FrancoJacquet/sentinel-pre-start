import type { AdapterResult, AnalyzeInput, PerceptionAdapter } from '../types.ts';
import { decideZone, zoneOverlay, type ZoneCalibration } from '../zone-rule.ts';
import { parseSamOutput } from './sam-output.ts';
import type { SpendGuard } from './spend-guard.ts';

// Doc oficial (consultada 2026-11-02): https://dev.meta.ai/docs/sam/overview,
// /docs/sam/segmenting, /docs/sam/reading-segmentation, /docs/error-handling.
export const META_RESPONSES_URL = 'https://api.meta.ai/v1/responses';
// Standard mode: el contenido no se usa para entrenar. Nunca `-contributor`.
export const SAM_MODEL = 'sam-3.1';
// Un concepto por solicitud: frase nominal corta.
export const SAM_PROMPT = 'person';

export interface MetaSamAdapterOptions {
  // Tiene que venir true explícito; encontrar una key no alcanza.
  enabled: boolean;
  apiKey: string | undefined;
  guard: SpendGuard;
  zone: ZoneCalibration;
  // Inyectable: los tests nunca tocan la red.
  fetch: typeof globalThis.fetch;
}

export function buildSamRequest(jpegBase64: string) {
  return {
    model: SAM_MODEL,
    input: [
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: SAM_PROMPT },
          { type: 'input_image', image_url: `data:image/jpeg;base64,${jpegBase64}` },
        ],
      },
    ],
    stream: false,
    // Sin copia del lado de Meta (default true) y sin 413 por base64 grande.
    store: false,
    metadata: { include_confidence: 'true', mask_encoding: 'one_bit' },
  };
}

// Respuesta no streaming de la Responses API: el texto vive en
// output[].content[] con type output_text. Algunos clientes agregan
// `output_text` ya concatenado; se aceptan las dos formas.
export function extractOutputText(body: unknown): string {
  if (typeof body !== 'object' || body === null) throw new Error('response is not an object');
  const r = body as { output_text?: unknown; output?: unknown; status?: unknown };
  if (r.status !== undefined && r.status !== 'completed') throw new Error(`response status ${String(r.status).slice(0, 40)}`);
  if (typeof r.output_text === 'string') return r.output_text;
  if (!Array.isArray(r.output)) throw new Error('response without output');
  let text = '';
  for (const item of r.output) {
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const p = part as { type?: unknown; text?: unknown };
      if (p.type === 'output_text' && typeof p.text === 'string') text += p.text;
    }
  }
  return text;
}

// SAM 3.1 segmenta personas en el frame de CAM-01; la regla de zona decide.
// Sin reintentos: un fallo es MODEL_ERROR (que el gateway trata como UNKNOWN).
export class MetaSamAdapter implements PerceptionAdapter {
  readonly id = 'meta-sam-3.1';
  readonly #opts: MetaSamAdapterOptions;

  constructor(opts: MetaSamAdapterOptions) {
    this.#opts = opts;
  }

  async analyze({ cameraId, frame, signal }: AnalyzeInput): Promise<AdapterResult> {
    const { enabled, apiKey, guard, zone } = this.#opts;
    if (!enabled) return { status: 'INFERENCE_DISABLED', source: 'none', detail: 'META_API_ENABLED=false' };
    if (!apiKey) return { status: 'INFERENCE_DISABLED', source: 'none', detail: 'MODEL_API_KEY missing' };
    if (cameraId !== zone.cameraId || frame.sceneRevision !== zone.sceneRevision) {
      return { status: 'UNVERIFIED', source: 'none', detail: `no zone calibration for ${cameraId}@${frame.sceneRevision}` };
    }
    if (frame.width !== zone.width || frame.height !== zone.height) {
      return { status: 'UNVERIFIED', source: 'none', detail: `frame ${frame.width}x${frame.height} != calibration` };
    }

    const slot = await guard.reserve(SAM_MODEL, frame.frameId);
    if (!slot.ok) {
      if (slot.reason === 'budget') return { status: 'BUDGET_EXHAUSTED', source: 'none', detail: `meta budget ${slot.used}/${slot.max}` };
      return { status: 'UNVERIFIED', source: 'none', detail: 'meta request already in flight' };
    }
    try {
      const res = await this.#opts.fetch(META_RESPONSES_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(buildSamRequest(frame.bytes.toString('base64'))),
        signal,
      });
      // Sólo el código: el cuerpo de error no se copia a logs ni a la UI.
      if (!res.ok) throw new Error(`meta http ${res.status}`);
      const boxes = parseSamOutput(extractOutputText(await res.json()));
      const decision = decideZone(boxes, zone);
      const detail = `${SAM_MODEL}: ${decision.detail} (request ${slot.used}/${slot.max})`;
      if (decision.status === 'UNVERIFIED') return { status: 'UNVERIFIED', source: 'none', detail, overlay: null };
      return { status: decision.status, source: 'model', detail, overlay: zoneOverlay(decision, zone) };
    } finally {
      guard.release();
    }
  }
}
