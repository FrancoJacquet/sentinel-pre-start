import { join } from 'node:path';
import type { Config } from './config.ts';
import { DisabledAdapter } from './perception/disabled-adapter.ts';
import { MetaSamAdapter } from './perception/meta/sam-adapter.ts';
import { MetaSparkExplainer } from './perception/meta/spark-explainer.ts';
import { SpendGuard } from './perception/meta/spend-guard.ts';
import type { Explainer, PerceptionAdapter } from './perception/types.ts';
import { CAM01_ZONE } from './perception/zone-rule.ts';

// Contador de la demo, aparte del de la prueba única (meta-spend-once.json).
export const META_SPEND_LEDGER = 'meta-spend.json';
// Contador de Muse Spark, aparte del de SAM: cada modelo tiene su tope.
export const META_SPARK_SPEND_LEDGER = 'meta-spark-spend.json';

// Elige el adaptador según la config. Apagado por defecto: sólo con
// META_API_ENABLED=true + MODEL_API_KEY + META_MAX_REQUESTS (validado en
// loadConfig) se conecta SAM 3.1, con tope persistente, concurrencia 1 y sin
// reintentos. `fetch` inyectable: los tests nunca tocan la red.
export function createAdapter(config: Config, fetchImpl: typeof globalThis.fetch): PerceptionAdapter {
  if (!config.metaApiEnabled) return new DisabledAdapter();
  if (!config.metaApiKey || !config.metaMaxRequests) throw new Error('meta enabled without key or budget');
  const guard = new SpendGuard({ file: join(config.evidenceDir, META_SPEND_LEDGER), maxRequests: config.metaMaxRequests });
  return new MetaSamAdapter({ enabled: true, apiKey: config.metaApiKey, guard, zone: CAM01_ZONE, fetch: fetchImpl });
}

// Explicador opcional (Muse Spark). Apagado por defecto: sólo con
// META_SPARK_ENABLED=true, que loadConfig acepta únicamente con Meta prendida,
// key y META_SPARK_MAX_REQUESTS. Ledger propio, concurrencia 1, sin reintentos.
export function createExplainer(config: Config, fetchImpl: typeof globalThis.fetch): Explainer | null {
  if (!config.metaSparkEnabled) return null;
  if (!config.metaApiEnabled || !config.metaApiKey || !config.metaSparkMaxRequests) throw new Error('spark enabled without meta, key or budget');
  const guard = new SpendGuard({ file: join(config.evidenceDir, META_SPARK_SPEND_LEDGER), maxRequests: config.metaSparkMaxRequests });
  return new MetaSparkExplainer({ apiKey: config.metaApiKey, guard, fetch: fetchImpl });
}
