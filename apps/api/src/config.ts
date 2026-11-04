import { fileURLToPath } from 'node:url';

export interface Config {
  hosts: string[];
  port: number;
  // Meta prendida sólo con key y tope explícitos (ver loadConfig).
  metaApiEnabled: boolean;
  // Sólo con Meta prendida; si no, null. Nunca se imprime.
  metaApiKey: string | null;
  // Tope de solicitudes pagas del ledger persistente; null con Meta apagada.
  metaMaxRequests: number | null;
  // Muse Spark (explicación advisory): apagado por defecto; sólo con Meta
  // prendida y su propio tope.
  metaSparkEnabled: boolean;
  metaSparkMaxRequests: number | null;
  freshnessTtlMs: number;
  inferenceTimeoutMs: number;
  // Spark corre después de la decisión: su demora no frena al PLC.
  sparkTimeoutMs: number;
  frameTimeoutMs: number;
  evidenceDir: string;
  evidenceMaxFrames: number;
}

// <repo>/evidence (gitignoreado).
const DEFAULT_EVIDENCE_DIR = fileURLToPath(new URL('../../../evidence', import.meta.url));

const ALL_INTERFACES = new Set(['0.0.0.0', '::', '[::]', '']);

function positiveInt(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer, got "${raw}"`);
  return n;
}

// Tope duro del contador de la demo: 200 solicitudes ≈ US$0,50 a US$0,0025 cada una.
export const META_MAX_REQUESTS_LIMIT = 200;

// Prender Meta exige las tres cosas juntas; si falta una, no se arranca. Los
// mensajes nombran la variable, nunca su valor (la key no se imprime).
function metaSettings(env: NodeJS.ProcessEnv): Pick<Config, 'metaApiEnabled' | 'metaApiKey' | 'metaMaxRequests'> {
  const meta = env.META_API_ENABLED ?? 'false';
  if (meta === 'false') return { metaApiEnabled: false, metaApiKey: null, metaMaxRequests: null };
  if (meta !== 'true') throw new Error(`META_API_ENABLED must be "false" or "true", got "${meta.slice(0, 20)}"`);

  const key = (env.MODEL_API_KEY ?? '').trim();
  if (key === '') throw new Error('META_API_ENABLED=true requires MODEL_API_KEY (missing or empty); refusing to start');

  const raw = env.META_MAX_REQUESTS;
  const max = raw !== undefined && /^[0-9]+$/.test(raw) ? Number(raw) : NaN;
  if (!(Number.isInteger(max) && max >= 1 && max <= META_MAX_REQUESTS_LIMIT)) {
    throw new Error(
      `META_API_ENABLED=true requires META_MAX_REQUESTS as an integer between 1 and ${META_MAX_REQUESTS_LIMIT}; refusing to start`,
    );
  }
  return { metaApiEnabled: true, metaApiKey: key, metaMaxRequests: max };
}

// Tope duro del ledger de Muse Spark: 200 solicitudes a menos de US$0,01 cada
// una (estimado: la doc no publica cuántos tokens cuenta una imagen).
export const META_SPARK_MAX_REQUESTS_LIMIT = 200;

// Spark es un segundo modelo pago, con su propio interruptor y su propio tope.
// Prenderlo exige Meta prendida (key incluida) y META_SPARK_MAX_REQUESTS.
function sparkSettings(
  env: NodeJS.ProcessEnv,
  metaApiEnabled: boolean,
): Pick<Config, 'metaSparkEnabled' | 'metaSparkMaxRequests'> {
  const spark = env.META_SPARK_ENABLED ?? 'false';
  if (spark === 'false') return { metaSparkEnabled: false, metaSparkMaxRequests: null };
  if (spark !== 'true') throw new Error(`META_SPARK_ENABLED must be "false" or "true", got "${spark.slice(0, 20)}"`);
  if (!metaApiEnabled) throw new Error('META_SPARK_ENABLED=true requires META_API_ENABLED=true; refusing to start');

  const raw = env.META_SPARK_MAX_REQUESTS;
  const max = raw !== undefined && /^[0-9]+$/.test(raw) ? Number(raw) : NaN;
  if (!(Number.isInteger(max) && max >= 1 && max <= META_SPARK_MAX_REQUESTS_LIMIT)) {
    throw new Error(
      `META_SPARK_ENABLED=true requires META_SPARK_MAX_REQUESTS as an integer between 1 and ${META_SPARK_MAX_REQUESTS_LIMIT}; refusing to start`,
    );
  }
  return { metaSparkEnabled: true, metaSparkMaxRequests: max };
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const hosts = (env.HUB_HOST ?? '127.0.0.1').split(',').map((h) => h.trim());
  for (const h of hosts) {
    if (ALL_INTERFACES.has(h)) throw new Error(`refusing to bind "${h}": use HUB_HOST=127.0.0.1,<tailnet ip>`);
  }

  const meta = metaSettings(env);
  const spark = sparkSettings(env, meta.metaApiEnabled);

  return {
    hosts,
    port: positiveInt('SENTINEL_API_PORT', env.SENTINEL_API_PORT, 4710),
    ...meta,
    ...spark,
    freshnessTtlMs: positiveInt('FRESHNESS_TTL_MS', env.FRESHNESS_TTL_MS, 2000),
    inferenceTimeoutMs: positiveInt('INFERENCE_TIMEOUT_MS', env.INFERENCE_TIMEOUT_MS, 5000),
    sparkTimeoutMs: positiveInt('SPARK_TIMEOUT_MS', env.SPARK_TIMEOUT_MS, 20000),
    frameTimeoutMs: positiveInt('FRAME_TIMEOUT_MS', env.FRAME_TIMEOUT_MS, 8000),
    evidenceDir: env.EVIDENCE_DIR || DEFAULT_EVIDENCE_DIR,
    evidenceMaxFrames: positiveInt('EVIDENCE_MAX_FRAMES', env.EVIDENCE_MAX_FRAMES, 500),
  };
}
