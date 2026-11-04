import { appendFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Evidence, Frame } from '../perception/types.ts';

export interface EvidenceStoreOptions {
  dir: string;
  // Retención: cuántos frames (JPEG + JSON) se conservan; los más viejos se borran.
  maxFrames: number;
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

// Evidence store local: por frame, el JPEG tal como llegó y un JSON con hash,
// metadatos, la evaluación y (aparte, rotulada) la verdad del simulador. Cada
// evaluación, con o sin frame, se agrega a evaluations.jsonl. Lo que llega
// después de la decisión (Muse Spark, avisos del wearable) se agrega con amend().
export class EvidenceStore {
  readonly #dir: string;
  readonly #maxFrames: number;
  #ready: Promise<unknown> | null = null;
  // record() y amend() van en la misma fila: un amend no se cruza con la poda
  // de un record() (volvería a escribir un JSON ya podado, sin su JPEG).
  #queue: Promise<unknown> = Promise.resolve();

  constructor(opts: EvidenceStoreOptions) {
    this.#dir = opts.dir;
    this.#maxFrames = opts.maxFrames;
  }

  record(evidence: Evidence, frame: Frame | null, adapterId: string): Promise<void> {
    return this.#enqueue(() => this.#record(evidence, frame, adapterId));
  }

  async #record(evidence: Evidence, frame: Frame | null, adapterId: string): Promise<void> {
    this.#ready ??= mkdir(this.#dir, { recursive: true });
    await this.#ready;

    const evaluation = {
      status: evidence.status,
      source: evidence.source,
      adapter: adapterId,
      observedAt: evidence.observedAt?.toISOString() ?? null,
      detail: evidence.detail,
      // Lo que el modelo vio (cajas, pie, zona); null si no hubo modelo.
      overlay: evidence.overlay,
      // Explicación de Muse Spark y, aparte, la consulta completa (prompt,
      // salida cruda, motivo si falló). Al decidir todavía son null: Spark
      // llega después y se agrega con amend().
      explanation: evidence.explanation ?? null,
      spark: evidence.advice ?? null,
      // Desacuerdo Spark/SAM: sólo nota, la decisión no cambió.
      sparkNote: evidence.sparkNote ?? null,
    };

    if (frame) {
      if (!SAFE_ID.test(frame.frameId)) throw new Error(`unsafe frameId: ${frame.frameId}`);
      const meta = {
        frame: {
          frameId: frame.frameId,
          cameraId: frame.cameraId,
          receivedAt: frame.receivedAt.toISOString(),
          captureTs: frame.captureTs,
          width: frame.width,
          height: frame.height,
          mime: frame.mime,
          sceneRevision: frame.sceneRevision,
          sha256: frame.sha256,
          bytes: frame.bytes.length,
        },
        evaluation,
        simulation: { label: 'SIMULATION', truth: frame.simTruth },
      };
      await writeFile(join(this.#dir, `${frame.frameId}.jpg`), frame.bytes);
      await writeFile(join(this.#dir, `${frame.frameId}.json`), JSON.stringify(meta, null, 2) + '\n');
    }

    const line = { at: new Date().toISOString(), cameraId: evidence.cameraId, frameId: frame?.frameId ?? null, ...evaluation };
    await appendFile(join(this.#dir, 'evaluations.jsonl'), JSON.stringify(line) + '\n');
    if (frame) await this.#prune();
  }

  // Agrega campos a `evaluation` del JSON de un frame ya guardado (p. ej. la
  // respuesta de Spark o los avisos del wearable) y lo anota en el log. Si el
  // frame ya se podó por retención, sólo queda la línea del log.
  amend(frameId: string, patch: Record<string, unknown>): Promise<void> {
    return this.#enqueue(() => this.#amend(frameId, patch));
  }

  #enqueue(job: () => Promise<void>): Promise<void> {
    const run = this.#queue.then(job);
    this.#queue = run.catch(() => {});
    return run;
  }

  async #amend(frameId: string, patch: Record<string, unknown>): Promise<void> {
    if (!SAFE_ID.test(frameId)) throw new Error(`unsafe frameId: ${frameId}`);
    this.#ready ??= mkdir(this.#dir, { recursive: true });
    await this.#ready;
    const file = join(this.#dir, `${frameId}.json`);
    let meta: { evaluation: Record<string, unknown> } | null = null;
    try {
      meta = JSON.parse(await readFile(file, 'utf8'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    if (meta) {
      meta.evaluation = { ...meta.evaluation, ...patch };
      await writeFile(file, JSON.stringify(meta, null, 2) + '\n');
    }
    const line = { at: new Date().toISOString(), frameId, amend: patch };
    await appendFile(join(this.#dir, 'evaluations.jsonl'), JSON.stringify(line) + '\n');
  }

  // Los frameId del servidor empiezan con un timestamp ordenable, así que el
  // orden alfabético es el orden de llegada.
  async #prune(): Promise<void> {
    const jpgs = (await readdir(this.#dir)).filter((f) => f.endsWith('.jpg')).sort();
    const excess = jpgs.length - this.#maxFrames;
    for (const f of jpgs.slice(0, Math.max(0, excess))) {
      const id = f.slice(0, -4);
      await rm(join(this.#dir, `${id}.jpg`), { force: true });
      await rm(join(this.#dir, `${id}.json`), { force: true });
    }
  }
}
