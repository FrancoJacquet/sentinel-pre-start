import { isStartAllowedStatus, type PerceptionStatus, type PlcBlockReason, type PlcState } from '@sentinel/contracts';
import type { PerceptionGateway } from '../perception/gateway.ts';
import type { Evidence } from '../perception/types.ts';

export interface PlcSnapshot {
  machineId: string;
  state: PlcState;
  reason: PerceptionStatus | PlcBlockReason | null;
  authorizationId: string | null;
}

export interface PlcOptions {
  machineId: string;
  cameraId: string;
  gateway: PerceptionGateway;
  onChange?: (snapshot: PlcSnapshot) => void;
}

export interface StartResult {
  accepted: boolean;
  snapshot: PlcSnapshot;
  // Evidencia con la que se decidió este pedido; null si no se llegó a decidir
  // con evidencia (rechazado, autorización reusada o stop durante la evaluación).
  evidence: Evidence | null;
}

// Desde estos estados se puede pedir un arranque nuevo.
const CAN_REQUEST = new Set<PlcState>(['IDLE', 'BLOCKED', 'STOPPED']);

// PLC VIRTUAL (simulación). Determinista: sólo cambia de estado por un pedido
// humano, por el arranque de la máquina simulada o por un stop. Nunca arranca
// solo y nunca habilita sin NO_RISK_OBSERVED fresco.
export class VirtualPLC {
  readonly #machineId: string;
  readonly #cameraId: string;
  readonly #gateway: PerceptionGateway;
  readonly #onChange: (snapshot: PlcSnapshot) => void;
  readonly #usedAuthorizations = new Set<string>();
  #state: PlcState = 'IDLE';
  #reason: PlcSnapshot['reason'] = null;
  #authorizationId: string | null = null;

  constructor(opts: PlcOptions) {
    this.#machineId = opts.machineId;
    this.#cameraId = opts.cameraId;
    this.#gateway = opts.gateway;
    this.#onChange = opts.onChange ?? (() => {});
  }

  snapshot(): PlcSnapshot {
    return {
      machineId: this.#machineId,
      state: this.#state,
      reason: this.#reason,
      authorizationId: this.#authorizationId,
    };
  }

  async requestStart(authorizationId: string): Promise<StartResult> {
    if (!CAN_REQUEST.has(this.#state)) return { accepted: false, snapshot: this.snapshot(), evidence: null };

    if (this.#usedAuthorizations.has(authorizationId)) {
      this.#set('BLOCKED', 'AUTHORIZATION_REUSED', authorizationId);
      return { accepted: true, snapshot: this.snapshot(), evidence: null };
    }
    this.#usedAuthorizations.add(authorizationId);
    this.#set('START_REQUESTED', null, authorizationId);

    await this.#gateway.evaluate(this.#cameraId);
    // Un stop (o hongo) que llegó mientras se evaluaba gana: el resultado no
    // lo pisa, porque eso sería arrancar después de una parada humana.
    if (this.#state !== 'START_REQUESTED' || this.#authorizationId !== authorizationId) {
      return { accepted: true, snapshot: this.snapshot(), evidence: null };
    }
    const evidence = this.#gateway.current(this.#cameraId);
    if (isStartAllowedStatus(evidence.status)) this.#set('ENABLED', null, authorizationId);
    else this.#set('BLOCKED', evidence.status, authorizationId);
    return { accepted: true, snapshot: this.snapshot(), evidence };
  }

  // La máquina simulada confirma el arranque. Se revalida la evidencia: si
  // venció o cambió entre ENABLED y el arranque, se bloquea.
  machineStarted(): void {
    if (this.#state !== 'ENABLED') return;
    const evidence = this.#gateway.current(this.#cameraId);
    if (isStartAllowedStatus(evidence.status)) this.#set('RUNNING', null, this.#authorizationId);
    else this.#set('BLOCKED', evidence.status, this.#authorizationId);
  }

  stop(): void {
    if (this.#state === 'IDLE' || this.#state === 'STOPPED') return;
    this.#set('STOPPED', null, this.#authorizationId);
  }

  #set(state: PlcState, reason: PlcSnapshot['reason'], authorizationId: string | null): void {
    this.#state = state;
    this.#reason = reason;
    this.#authorizationId = authorizationId;
    this.#onChange(this.snapshot());
  }
}
