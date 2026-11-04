import { createAdapter, createExplainer } from './adapter.ts';
import { loadConfig } from './config.ts';
import { startServer } from './server.ts';

const config = loadConfig(process.env);
// Apagado por defecto (DisabledAdapter). SAM 3.1 sólo con META_API_ENABLED=true,
// key y tope: ver docs/meta/COST-AND-CONSENT-GATE.md (consentimiento explícito por cada gasto).
const adapter = createAdapter(config, globalThis.fetch);
// Muse Spark (comunica después de decidir, nunca decide): apagado salvo META_SPARK_ENABLED=true.
const explainer = createExplainer(config, globalThis.fetch);
const server = await startServer(config, { adapter, explainer });
// Nunca se imprime la key: sólo el estado y el tope.
const budget =
  (config.metaApiEnabled ? ` · meta_max_requests=${config.metaMaxRequests}` : '') +
  (explainer ? ` · spark=${explainer.id} · spark_max_requests=${config.metaSparkMaxRequests}` : ' · spark=off');
console.log(
  `sentinel api: ws://{${config.hosts.join(',')}}:${server.ports[0]}/ws · meta=${config.metaApiEnabled} · adapter=${adapter.id}${budget}`,
);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, () => void server.close().then(() => process.exit(0)));
}
