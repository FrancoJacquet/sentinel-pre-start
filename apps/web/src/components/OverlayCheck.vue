<script setup lang="ts">
import { onMounted, ref } from 'vue';
import type { PerceptionView } from '../net/sentinel.ts';
import CamEvidence from './CamEvidence.vue';
// Misma cadena que el adaptador de la API: parser de la salida de SAM, regla
// de zona y overlay. Nada se recalcula a mano acá.
import { parseSamOutput } from '../../../api/src/perception/meta/sam-output.ts';
import { CAM01_ZONE, decideZone, zoneOverlay } from '../../../api/src/perception/zone-rule.ts';

// Vista INTERNA de prueba (?check=overlay), fuera del video: redibuja la
// respuesta REAL de SAM 3.1 de la corrida 1 (docs/meta/RESULTS.md) sobre su
// propio frame, con el componente de la demo, para validar a ojo caja, pie,
// etiqueta, polígono y letterbox. Es una repetición de un resultado guardado,
// no una detección en vivo, y se rotula así.
const perception = ref<PerceptionView | null>(null);
const imageUrl = ref<string | null>(null);
const raw = ref('');
const error = ref('');

onMounted(async () => {
  try {
    const [sam, ev, jpg] = await Promise.all([
      import('../../../../docs/meta/results/f-20261103T165838413-d307c6.sam.json'),
      import('../../../../docs/meta/results/f-20261103T165838413-d307c6.json'),
      import('../../../../docs/meta/results/f-20261103T165838413-d307c6.jpg?url'),
    ]);
    const output = sam.default.response.output as { content: { type: string; text: string }[] }[];
    const text = output.flatMap((o) => o.content).filter((c) => c.type === 'output_text').map((c) => c.text).join('');
    raw.value = /<\|box;[^|]*\|>/.exec(text)?.[0] ?? '(no box)';
    const decision = decideZone(parseSamOutput(text), CAM01_ZONE);
    const f = ev.default.frame;
    perception.value = {
      cameraId: 'cam-01',
      status: decision.status,
      source: 'model',
      observedAt: f.receivedAt,
      freshnessTtlMs: 5000,
      detail: decision.detail,
      frame: { frameId: f.frameId, receivedAt: f.receivedAt, sha256: f.sha256, width: f.width, height: f.height },
      overlay: zoneOverlay(decision, CAM01_ZONE),
      // La corrida 1 fue sólo SAM: no hubo Muse Spark, no se inventa texto.
      explanation: null,
      evidenceExplanation: null,
    };
    imageUrl.value = jpg.default;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
});
</script>

<template>
  <div class="check" data-testid="overlay-check">
    <p class="banner">
      INTERNAL CHECK — replay of a stored SAM 3.1 result (run 1, 2026-11-03, scene crane-v1). Not live, not for the
      video.
    </p>
    <p v-if="error" class="err">Could not load the stored run: {{ error }}</p>
    <div class="grid">
      <!-- Tres anchos: el letterbox y el trazo tienen que verse bien en todos. -->
      <CamEvidence class="card w1" :perception="perception" :image-url="imageUrl" />
      <CamEvidence class="card w2" :perception="perception" :image-url="imageUrl" />
      <CamEvidence class="card w3 tall" :perception="perception" :image-url="imageUrl" />
    </div>
    <p class="meta" v-if="perception">
      Raw model box: <code>{{ raw }}</code> · decision <code>{{ perception.status }}</code> · {{ perception.detail }}
    </p>
  </div>
</template>

<style scoped>
.check {
  padding: 16px;
  min-height: 100vh;
  background: var(--bg, #eceeee);
}
.banner {
  margin: 0 0 12px;
  padding: 10px 14px;
  background: var(--amber);
  color: var(--hazard-dark);
  font: 600 18px var(--font-display);
  letter-spacing: 0.03em;
}
.grid {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  align-items: flex-start;
}
.card {
  padding: 8px 10px;
  background: var(--surface);
  border: 1px solid var(--ink);
}
.w1 {
  width: 760px;
}
.w2 {
  width: 420px;
}
.w3 {
  width: 300px;
}
/* Caja más alta que 16:9: obliga al letterbox (meet) a dejar bandas. */
.tall :deep(.viewport) {
  aspect-ratio: 4 / 5;
}
.err {
  color: var(--red);
}
.meta {
  margin-top: 12px;
  color: var(--muted);
}
code {
  font: 13px ui-monospace, monospace;
}
</style>
