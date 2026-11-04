// UNA solicitud a SAM 3.1 sobre un frame de evidencia ya guardado. Es la
// prueba real del hito 4 y sale sólo con consentimiento explícito.
//
//   META_API_ENABLED=true node --env-file=../../.env src/tools/sam-once.ts \
//     --frame <evidence>/<frameId>.jpg --confirm <frameId>
//
// Tope propio: META_SAM_ONCE_LEDGER (default <evidence>/meta-spend-once.json),
// máximo 1 solicitud. Una vez usada no hay segunda: hay que borrar el ledger a mano.
import { readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { MetaSamAdapter, SAM_MODEL } from '../perception/meta/sam-adapter.ts';
import { SpendGuard } from '../perception/meta/spend-guard.ts';
import { CAM01_ZONE } from '../perception/zone-rule.ts';

const { values } = parseArgs({ options: { frame: { type: 'string' }, confirm: { type: 'string' } } });
if (!values.frame) throw new Error('--frame <path.jpg> is required');
const frameId = basename(values.frame, '.jpg');
// Confirmar el frameId a mano evita mandar un archivo que no se miró.
if (values.confirm !== frameId) throw new Error(`--confirm must repeat the frameId (${frameId})`);
if (process.env.META_API_ENABLED !== 'true') throw new Error('META_API_ENABLED must be "true" for this one call');

const bytes = await readFile(values.frame);
const meta = JSON.parse(await readFile(values.frame.replace(/\.jpg$/, '.json'), 'utf8'));
const sha256 = createHash('sha256').update(bytes).digest('hex');
if (sha256 !== meta.frame.sha256) throw new Error('frame bytes do not match the stored sha256');

const ledger = process.env.META_SAM_ONCE_LEDGER || join(dirname(values.frame), 'meta-spend-once.json');
const guard = new SpendGuard({ file: ledger, maxRequests: 1 });

// Se guarda la respuesta cruda para revisarla (la key nunca se escribe).
let raw: unknown = null;
const recordingFetch: typeof fetch = async (url, init) => {
  const res = await fetch(url, init);
  raw = await res.clone().json().catch(() => ({ unreadable: true }));
  return res;
};

const adapter = new MetaSamAdapter({ enabled: true, apiKey: process.env.MODEL_API_KEY, guard, zone: CAM01_ZONE, fetch: recordingFetch });
const started = Date.now();
let result: unknown;
try {
  result = await adapter.analyze({
    cameraId: meta.frame.cameraId,
    frame: { ...meta.frame, receivedAt: new Date(meta.frame.receivedAt), bytes, sha256 },
    signal: AbortSignal.timeout(30_000),
  });
} catch (err) {
  result = { status: 'MODEL_ERROR', detail: (err as Error).message };
}
const out = {
  model: SAM_MODEL,
  frameId,
  latencyMs: Date.now() - started,
  result,
  simulation: { label: 'SIMULATION', truth: meta.simulation?.truth ?? null },
  requestsUsed: await guard.used(),
  response: raw,
};
await writeFile(values.frame.replace(/\.jpg$/, '.sam.json'), JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify({ ...out, response: raw ? '(guardada en .sam.json)' : null }, null, 2));
