import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface SpendGuardOptions {
  // Archivo del contador (JSON). Sobrevive reinicios: el tope no se resetea
  // reiniciando la API.
  file: string;
  // Tope interno de solicitudes pagas. 0 = ninguna.
  maxRequests: number;
  now?: () => Date;
}

interface Ledger {
  requests: number;
  last: { at: string; model: string; frameId: string } | null;
}

export type Reservation = { ok: true; used: number; max: number } | { ok: false; reason: 'budget' | 'in_flight'; used: number; max: number };

// Contador persistente + concurrencia 1. La solicitud se cuenta ANTES de
// mandarla y no se devuelve si falla: ante la duda, se gastó.
export class SpendGuard {
  readonly #file: string;
  readonly #max: number;
  readonly #now: () => Date;
  #inFlight = false;

  constructor(opts: SpendGuardOptions) {
    if (!Number.isInteger(opts.maxRequests) || opts.maxRequests < 0) throw new Error('maxRequests must be an integer >= 0');
    this.#file = opts.file;
    this.#max = opts.maxRequests;
    this.#now = opts.now ?? (() => new Date());
  }

  async used(): Promise<number> {
    return (await this.#read()).requests;
  }

  // Si devuelve ok, el llamador DEBE llamar a release() al terminar.
  async reserve(model: string, frameId: string): Promise<Reservation> {
    if (this.#inFlight) return { ok: false, reason: 'in_flight', used: await this.used(), max: this.#max };
    this.#inFlight = true;
    try {
      const ledger = await this.#read();
      if (ledger.requests >= this.#max) {
        this.#inFlight = false;
        return { ok: false, reason: 'budget', used: ledger.requests, max: this.#max };
      }
      const next: Ledger = { requests: ledger.requests + 1, last: { at: this.#now().toISOString(), model, frameId } };
      await this.#write(next);
      return { ok: true, used: next.requests, max: this.#max };
    } catch (err) {
      this.#inFlight = false;
      throw err;
    }
  }

  release(): void {
    this.#inFlight = false;
  }

  async #read(): Promise<Ledger> {
    let raw: string;
    try {
      raw = await readFile(this.#file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { requests: 0, last: null };
      throw err;
    }
    const parsed = JSON.parse(raw) as Partial<Ledger>;
    // Un contador ilegible no es cero: se corta.
    if (!Number.isInteger(parsed.requests) || (parsed.requests as number) < 0) throw new Error('spend ledger is corrupt');
    return { requests: parsed.requests as number, last: parsed.last ?? null };
  }

  async #write(ledger: Ledger): Promise<void> {
    await mkdir(dirname(this.#file), { recursive: true });
    const tmp = `${this.#file}.tmp`;
    await writeFile(tmp, JSON.stringify(ledger, null, 2) + '\n');
    await rename(tmp, this.#file);
  }
}
