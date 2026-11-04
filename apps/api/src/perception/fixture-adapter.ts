import type { PerceptionStatus } from '@sentinel/contracts';
import type { AdapterResult, PerceptionAdapter } from './types.ts';

// SIMULACIÓN: sólo para tests. Devuelve un estado fijo rotulado `simulation`;
// no es salida de ningún modelo y no se conecta a la UI de demo.
export class FixtureAdapter implements PerceptionAdapter {
  readonly id = 'fixture';
  readonly #status: PerceptionStatus;

  constructor(status: PerceptionStatus) {
    this.#status = status;
  }

  async analyze(): Promise<AdapterResult> {
    return { status: this.#status, source: 'simulation', detail: 'SIMULATION fixture' };
  }
}
