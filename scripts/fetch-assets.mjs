// Baja los assets 3D de terceros (CC0) listados en apps/web/assets.manifest.json
// a apps/web/public/assets/. Verifica SHA-256 contra el manifiesto.
//   node scripts/fetch-assets.mjs         baja lo que falte y verifica
//   node scripts/fetch-assets.mjs --pin   además anota el SHA-256 de lo nuevo
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const manifestPath = join(root, 'apps/web/assets.manifest.json');
const outDir = join(root, 'apps/web/public/assets');
const ALLOWED_HOSTS = new Set(['dl.polyhaven.org', 'static.poly.pizza']);
const pin = process.argv.includes('--pin');

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
let fetched = 0;
let failed = 0;

for (const asset of manifest.assets) {
  for (const file of asset.files) {
    const url = new URL(file.url);
    if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(url.host)) throw new Error(`host no permitido: ${file.url}`);
    const dest = resolve(outDir, file.dest);
    if (!dest.startsWith(outDir + sep)) throw new Error(`destino fuera de assets: ${file.dest}`);

    let data = await readFile(dest).catch(() => null);
    if (!data) {
      const res = await fetch(url, { headers: { 'user-agent': 'sentinelhack2026-fetch-assets/1.0' } });
      if (!res.ok) throw new Error(`${res.status} ${file.url}`);
      data = Buffer.from(await res.arrayBuffer());
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, data);
      fetched++;
    }
    const sha = createHash('sha256').update(data).digest('hex');
    if (file.sha256 && file.sha256 !== sha) {
      console.error(`SHA-256 distinto: ${file.dest}`);
      failed++;
    } else if (!file.sha256 && pin) {
      file.sha256 = sha;
    } else if (!file.sha256) {
      console.error(`sin SHA-256 en el manifiesto: ${file.dest} (correr con --pin la primera vez)`);
      failed++;
    }
  }
}

if (pin) await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(`assets: ${fetched} bajados, ${failed} con problemas`);
process.exit(failed ? 1 : 0);
