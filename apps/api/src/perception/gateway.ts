import { SPARK_MODEL_ID } from '@sentinel/contracts';
import { disagreementNote } from './advice-rule.ts';
import type { Advice, Evidence, ExplainPlcState, Explainer, Frame, FrameMeta, FrameSource, ModelFrame, PerceptionAdapter } from './types.ts';

export interface GatewayOptions {
  adapter: PerceptionAdapter;
  frames: FrameSource;
  freshnessTtlMs: number;
  timeoutMs: number;
  frameTimeoutMs: number;
  // Explicador opcional (Muse Spark): no está en el camino de la decisión.
  // Se consulta con explain(), después de que el PLC decidió, y sólo comunica.
  explainer?: Explainer | null;
  // Timeout propio del explicador; por defecto el mismo que el del modelo.
  explainTimeoutMs?: number;
  now?: () => Date;
  // Se llama con cada evaluación (evidence store) y se espera. Si falla, la
  // evaluación queda UNVERIFIED: sin evidencia guardada no se habilita.
  onEvidence?: (evidence: Evidence, frame: Frame | null) => void | Promise<void>;
}

// Estados que vienen de una observación del modelo y por lo tanto vencen.
const OBSERVED = new Set(['RISK_OBSERVED', 'NO_RISK_OBSERVED']);

// Corre `run` con un AbortSignal que se aborta a los `ms`. Primero se rechaza
// con el timeout y después se aborta, así el motivo que gana es el timeout.
async function withTimeout<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`timeout after ${ms}ms`));
      controller.abort();
    }, ms);
  });
  try {
    return await Promise.race([run(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function errorMessage(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 200);
}

export class PerceptionGateway {
  readonly freshnessTtlMs: number;
  readonly #adapter: PerceptionAdapter;
  readonly #frames: FrameSource;
  readonly #timeoutMs: number;
  readonly #frameTimeoutMs: number;
  readonly #explainer: Explainer | null;
  readonly #explainTimeoutMs: number;
  readonly #now: () => Date;
  readonly #onEvidence: NonNullable<GatewayOptions['onEvidence']>;
  readonly #connected = new Set<string>();
  readonly #last = new Map<string, Evidence>();
  // Último frame observado por el modelo, para explicarlo después de decidir.
  readonly #explainable = new Map<string, { frame: ModelFrame; status: Advice['samStatus']; overlay: NonNullable<Evidence['overlay']> }>();
  // Concurrencia 1 en todo el gateway: nunca dos inferencias en vuelo.
  #inFlight = false;
  // Idem para Spark, aparte: una explicación en vuelo no frena una decisión.
  // Sin reintentos ni cola: si llega un pedido nuevo mientras Spark explica
  // otro frame, el nuevo pierde (queda 'spark request already in flight' en su
  // evidencia, sin explicación ni aviso de Spark; el aviso fijo sale igual) y
  // la respuesta vieja sólo va a la evidencia de su frame. Limitación aceptada.
  #explaining = false;

  constructor(opts: GatewayOptions) {
    this.#adapter = opts.adapter;
    this.#frames = opts.frames;
    this.freshnessTtlMs = opts.freshnessTtlMs;
    this.#timeoutMs = opts.timeoutMs;
    this.#frameTimeoutMs = opts.frameTimeoutMs;
    this.#explainer = opts.explainer ?? null;
    this.#explainTimeoutMs = opts.explainTimeoutMs ?? opts.timeoutMs;
    this.#now = opts.now ?? (() => new Date());
    this.#onEvidence = opts.onEvidence ?? (() => {});
  }

  get adapterId(): string {
    return this.#adapter.id;
  }

  setCameraConnected(cameraId: string, connected: boolean): void {
    if (connected) this.#connected.add(cameraId);
    else {
      this.#connected.delete(cameraId);
      // Lo evaluado pertenece a esa conexión; al volver se arranca de cero.
      this.#last.delete(cameraId);
      this.#explainable.delete(cameraId);
    }
  }

  // Evidencia vigente: lo último evaluado, degradado si venció o si la cámara
  // se cayó. Nunca devuelve una observación vieja como actual.
  current(cameraId: string): Evidence {
    if (!this.#connected.has(cameraId)) return this.#none(cameraId, 'NO_CAMERA', 'camera not connected');
    const last = this.#last.get(cameraId);
    if (!last) return this.#none(cameraId, 'UNVERIFIED', 'no evaluation yet');
    if (OBSERVED.has(last.status)) {
      const age = last.observedAt ? this.#now().getTime() - last.observedAt.getTime() : Infinity;
      if (!(age >= 0 && age <= this.freshnessTtlMs)) {
        // Vencida: el overlay se cae con ella; no se dibuja como actual.
        return { ...last, status: 'STALE_RESULT', overlay: null, explanation: null, detail: `observation age ${age}ms > ttl ${this.freshnessTtlMs}ms` };
      }
    }
    return last;
  }

  async evaluate(cameraId: string): Promise<Evidence> {
    if (!this.#connected.has(cameraId)) {
      return await this.#store(this.#none(cameraId, 'NO_CAMERA', 'camera not connected'), null);
    }
    if (this.#inFlight) return this.#none(cameraId, 'UNVERIFIED', 'evaluation already in flight');

    this.#inFlight = true;
    try {
      // Sin píxeles no hay inferencia: primero el frame.
      let frame: Frame;
      try {
        frame = await withTimeout(this.#frameTimeoutMs, (signal) => this.#frames.capture(cameraId, signal));
      } catch (err) {
        return await this.#store(this.#none(cameraId, 'CAPTURE_FAILED', errorMessage(err)), null);
      }
      const meta: FrameMeta = {
        frameId: frame.frameId,
        receivedAt: frame.receivedAt,
        sha256: frame.sha256,
        width: frame.width,
        height: frame.height,
      };
      const { simTruth: _truth, ...modelFrame } = frame;
      let result;
      try {
        result = await withTimeout(this.#timeoutMs, (signal) =>
          this.#adapter.analyze({ cameraId, frame: modelFrame, signal }),
        );
      } catch (err) {
        return await this.#store({ ...this.#none(cameraId, 'MODEL_ERROR', errorMessage(err)), frame: meta }, frame);
      }
      // La decisión es sólo SAM + la regla de zona: no se espera a Spark. La
      // observación tiene la hora de SAM (los píxeles recién evaluados).
      const { status, source, detail } = result;
      const observed = OBSERVED.has(status);
      const observedAt = observed ? this.#now() : null;
      // El overlay sólo acompaña a una observación real del modelo.
      const overlay = observed && source === 'model' ? (result.overlay ?? null) : null;
      this.#explainable.delete(cameraId);
      const stored = await this.#store({ cameraId, status, source, detail, observedAt, frame: meta, overlay, explanation: null, evidenceExplanation: null, advice: null, sparkNote: null }, frame);
      if (overlay && stored.status === status) {
        this.#explainable.set(cameraId, { frame: modelFrame, status: status as Advice['samStatus'], overlay });
      }
      return stored;
    } finally {
      this.#inFlight = false;
    }
  }

  // Muse Spark sobre el frame `frameId`, con la decisión del PLC ya tomada.
  // Sólo comunica: actualiza la explicación (y la nota de desacuerdo) de la
  // evidencia de ese frame, pero NUNCA su estado, su hora ni su overlay; el PLC
  // ya decidió y Spark no lo mueve. null si no hay explicador o si ese frame no
  // es una observación del modelo. Nunca tira.
  async explain(cameraId: string, frameId: string, plcState: ExplainPlcState): Promise<Advice | null> {
    const target = this.#explainable.get(cameraId);
    if (!this.#explainer || !target || target.frame.frameId !== frameId) return null;
    // El contexto que se le da a Spark tiene que ser cierto para ese frame.
    if (target.status !== (plcState === 'BLOCKED' ? 'RISK_OBSERVED' : 'NO_RISK_OBSERVED')) return null;
    if (this.#explaining) return this.#failedAdvice(target.status, 'spark request already in flight');
    this.#explaining = true;
    let advice: Advice;
    try {
      advice = await this.#advise(cameraId, target.frame, target.status, plcState, target.overlay);
    } finally {
      this.#explaining = false;
    }
    const last = this.#last.get(cameraId);
    // Si entre tanto hubo otra evaluación (o se cayó la cámara), la respuesta
    // sólo queda en la evidencia de su frame; no pisa la vigente.
    if (last && last.frame?.frameId === frameId && last.status === target.status) {
      const note = disagreementNote(target.status, advice);
      let detail = last.detail;
      if (note) detail = `${detail ?? ''} · ${note}`.slice(0, 500);
      else if (!advice.ok) detail = `${detail ?? ''} · ${advice.model} not used: ${advice.reason ?? 'unknown'}`.slice(0, 500);
      // En desacuerdo el texto de Spark contradiría lo que el operario ve en
      // el PLC: no se muestra; queda en la evidencia con la nota.
      const explanation =
        !note && advice.ok && advice.text && advice.model === SPARK_MODEL_ID ? { model: SPARK_MODEL_ID, text: advice.text } : null;
      // current() aplica la frescura: si ya venció, la explicación no se emite.
      // La de evidencia sí sigue: va atada a este frame y se cae con él.
      const evidenceExplanation = explanation && last.source === 'model' ? { ...explanation, frameId, at: this.#now().toISOString() } : null;
      this.#last.set(cameraId, { ...last, detail, explanation, evidenceExplanation, advice, sparkNote: note });
    }
    return advice;
  }

  #none(cameraId: string, status: Evidence['status'], detail: string): Evidence {
    return { cameraId, status, source: 'none', observedAt: null, detail, frame: null, overlay: null, explanation: null, evidenceExplanation: null, advice: null, sparkNote: null };
  }

  #failedAdvice(samStatus: Advice['samStatus'], reason: string): Advice {
    return { model: SPARK_MODEL_ID, ok: false, samStatus, text: null, technicianAlert: null, personInZoneVisible: null, reason, prompt: '', raw: null, request: null };
  }

  // Nunca tira: un timeout o un error del explicador vuelve como ok=false.
  async #advise(
    cameraId: string,
    frame: ModelFrame,
    samStatus: Advice['samStatus'],
    plcState: ExplainPlcState,
    overlay: NonNullable<Evidence['overlay']>,
  ): Promise<Advice> {
    const explainer = this.#explainer!;
    try {
      return await withTimeout(this.#explainTimeoutMs, (signal) => explainer.explain({ cameraId, frame, samStatus, plcState, overlay, signal }));
    } catch (err) {
      return this.#failedAdvice(samStatus, errorMessage(err));
    }
  }

  async #store(ev: Evidence, frame: Frame | null): Promise<Evidence> {
    let result = ev;
    try {
      await this.#onEvidence(ev, frame);
    } catch (err) {
      result = { ...ev, status: 'UNVERIFIED', source: 'none', observedAt: null, overlay: null, explanation: null, evidenceExplanation: null, detail: `evidence not stored: ${errorMessage(err)}` };
    }
    this.#last.set(result.cameraId, result);
    return result;
  }
}
