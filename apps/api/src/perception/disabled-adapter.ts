import type { AdapterResult, PerceptionAdapter } from './types.ts';

// Único adaptador real del vertical slice: la inferencia está apagada y lo dice.
export class DisabledAdapter implements PerceptionAdapter {
  readonly id = 'disabled';

  async analyze(): Promise<AdapterResult> {
    return { status: 'INFERENCE_DISABLED', source: 'none', detail: 'META_API_ENABLED=false' };
  }
}
