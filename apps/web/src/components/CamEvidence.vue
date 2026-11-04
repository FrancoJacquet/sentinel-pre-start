<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { PerceptionView } from '../net/sentinel.ts';
import { EXPLANATION_LABEL, evidenceExplanationLine, liveExplanation, overlayDrawable, personsSummary, shortFrameId } from '../labels.ts';

// Frame EVALUADO de CAM-01 con la salida real de SAM 3.1 encima. Todo va en
// un solo SVG con viewBox width×height: imagen y overlay comparten
// coordenadas, y preserveAspectRatio=meet hace el letterbox (frame completo,
// nunca un recorte).
const props = defineProps<{ perception: PerceptionView | null; imageUrl: string | null }>();

const frame = computed(() => props.perception?.frame ?? null);
const drawable = computed(() => overlayDrawable(props.perception));
const live = computed(() => (drawable.value ? (props.perception!.overlay ?? null) : null));
// Texto real de Muse Spark sobre este frame; misma regla de frescura que el overlay.
const liveText = computed(() => liveExplanation(props.perception));
// Evidencia de la última decisión: cuando la observación vence, el overlay deja
// de ser actual, pero sigue siendo la base de la decisión que tomó el PLC. Se
// sigue dibujando sólo sobre ESE frame, apagado y rotulado "expired — not live";
// un frame nuevo o perder la percepción lo descarta.
type Overlay = NonNullable<typeof live.value>;
// La explicación de Spark, si la hubo, se conserva junto con esa evidencia.
const decision = ref<{ frameId: string; overlay: Overlay; explanation: string | null; at: string } | null>(null);
watch(
  () => [live.value, frame.value?.frameId ?? null, liveText.value] as const,
  ([o, frameId, text]) => {
    if (o && frameId) {
      decision.value = { frameId, overlay: o, explanation: text, at: new Date().toLocaleTimeString('en-GB', { hour12: false }) };
    } else if (!frameId || decision.value?.frameId !== frameId) {
      decision.value = null;
    }
  },
  { immediate: true },
);
const past = computed(() => (!live.value && decision.value ? decision.value : null));
const overlay = computed(() => live.value ?? past.value?.overlay ?? null);
const explanation = computed(() => (live.value ? liveText.value : (past.value?.explanation ?? null)));
// Spark como evidencia de la decisión: suele llegar con la observación ya
// vencida, así que va atada al frame evaluado (no a la frescura). Sólo junto a
// la evidencia de la decisión (vencida: con la vigente ya está la explicación
// en vivo) y sólo si es de ESE frame; si ya se ve la explicación, no se repite.
const evidenceLine = computed(() =>
  explanation.value ? null : evidenceExplanationLine(props.perception?.evidenceExplanation, past.value ? frame.value?.frameId : null),
);
// Hubo overlay pero ya no es actual (vencido o sin observación válida).
const expired = computed(() => !drawable.value && props.perception?.overlay != null && !past.value);
const box = computed(() => {
  const o = overlay.value ?? frame.value;
  return { w: o?.width ?? 1280, h: o?.height ?? 720 };
});
const shortId = computed(() => (frame.value ? shortFrameId(frame.value.frameId) : null));
const polygonPoints = computed(() => overlay.value?.polygon.map((p) => p.join(',')).join(' ') ?? '');
// Trazo en unidades del frame, para que se vea igual a cualquier tamaño.
const stroke = computed(() => Math.max(2, Math.round(box.value.w / 320)));
</script>

<template>
  <section class="cam" data-testid="camera-evaluated" :data-overlay="live ? 'model' : past ? 'decision' : 'none'">
    <header class="head">
      <h3>CAM-01 · evaluated frame</h3>
      <span v-if="live" class="src" data-testid="overlay-label">SAM 3.1 output · frame {{ shortId }}</span>
      <span v-else-if="past" class="src past-label" data-testid="overlay-label">
        Decision evidence · {{ past.at }} · expired — not live
      </span>
    </header>

    <div class="viewport">
      <svg
        :viewBox="`0 0 ${box.w} ${box.h}`"
        preserveAspectRatio="xMidYMid meet"
        role="img"
        :aria-label="
          overlay
            ? `CAM-01 frame ${shortId} with SAM 3.1 output: ${personsSummary(overlay.persons)}`
            : 'CAM-01 evaluated frame, no model data'
        "
      >
        <rect :width="box.w" :height="box.h" fill="#121619" />
        <image v-if="frame && imageUrl" :href="imageUrl" :width="box.w" :height="box.h" preserveAspectRatio="none" />
        <text v-else-if="frame" :x="box.w / 2" :y="box.h / 2" class="missing" text-anchor="middle">
          Frame {{ shortId }} is not held by this browser
        </text>
        <text v-else :x="box.w / 2" :y="box.h / 2" class="missing" text-anchor="middle">No frame evaluated yet</text>

        <g v-if="overlay" class="overlay" :class="{ past }" :stroke-width="stroke">
          <polygon :points="polygonPoints" class="zone" :stroke-dasharray="`${stroke * 6} ${stroke * 4}`" />
          <g
            v-for="(p, i) in overlay.persons"
            :key="i"
            class="person"
            :data-in-zone="p.inZone"
            data-testid="overlay-person"
          >
            <rect :x="p.x1" :y="p.y1" :width="p.x2 - p.x1" :height="p.y2 - p.y1" />
            <circle :cx="p.foot[0]" :cy="p.foot[1]" :r="stroke * 4" class="foot" />
            <text :x="p.x1" :y="Math.max(p.y1 - stroke * 3, stroke * 10)" class="tag" :font-size="stroke * 10">
              person{{ p.c == null ? '' : ` ${p.c.toFixed(2)}` }}{{ p.inZone ? ' · IN ZONE' : '' }}
            </text>
          </g>
        </g>
      </svg>
      <span v-if="!overlay" class="no-data" data-testid="camera-no-data">No model data</span>
    </div>

    <!-- El rótulo va adentro de la misma caja: en ?video=1 el .meta se oculta. -->
    <p v-if="evidenceLine" class="evidence-explain" data-past="true" data-testid="evidence-explanation" :title="evidenceLine">
      <span class="past-label" data-testid="evidence-explanation-expired">decision evidence — not live ·</span>
      {{ evidenceLine }}
    </p>
    <p class="meta" v-if="past" data-testid="overlay-summary">
      {{ personsSummary(past.overlay.persons) }} when the PLC decided. Expired: shown as the evidence of that decision, not as the current view.
    </p>
    <p class="meta" v-else-if="overlay" data-testid="overlay-summary">
      {{ personsSummary(overlay.persons) }}. Box, foot point and zone polygon are the model's real output on this frame.
    </p>
    <p class="meta" v-else-if="expired">Model output expired: it is no longer drawn as current.</p>
    <p class="meta" v-else>Nothing is drawn unless the model evaluated this frame. No simulated detections.</p>
    <p v-if="explanation" class="explain" :class="{ past }" data-testid="spark-explanation">
      <span class="src">{{ EXPLANATION_LABEL }}</span>
      <span v-if="past" class="past-label" data-testid="spark-explanation-expired">expired — not live ·</span>
      {{ explanation }}
    </p>
  </section>
</template>

<style scoped>
.head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 2px 10px;
  margin-bottom: 6px;
}
.head h3 {
  margin: 0;
  font: 600 17px var(--font);
}
.src {
  font: 600 13px var(--font-display);
  letter-spacing: 0.03em;
  color: var(--ink);
}
.viewport {
  position: relative;
  aspect-ratio: 16 / 9;
  background: #121619;
  border: 2px solid var(--ink);
}
svg {
  display: block;
  width: 100%;
  height: 100%;
}
.missing {
  fill: #9aa5ab;
  font: 600 64px var(--font-display);
}
.zone {
  fill: rgb(227 162 26 / 0.14);
  stroke: var(--amber);
}
.person rect {
  fill: none;
  stroke: #f4f4ef;
}
.person[data-in-zone='true'] rect {
  stroke: #ff3b2a;
}
.foot {
  fill: #f4f4ef;
  stroke: #121619;
}
.person[data-in-zone='true'] .foot {
  fill: #ff3b2a;
}
.tag {
  fill: #f4f4ef;
  stroke: #121619;
  stroke-width: 4px;
  paint-order: stroke;
  font-family: var(--font-display);
  font-weight: 600;
}
.overlay.past {
  opacity: 0.7;
}
.past-label {
  color: var(--muted);
}
.no-data {
  position: absolute;
  right: 6px;
  bottom: 6px;
  padding: 2px 8px;
  background: var(--amber);
  color: var(--hazard-dark);
  font: 600 15px var(--font-display);
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.explain {
  margin: 6px 0 0;
  font-size: 15px;
  color: var(--ink);
}
.explain.past {
  color: var(--muted);
}
/* Pegado al frame evaluado: es parte de esa evidencia (y de su rótulo
   "expired — not live"), no una lectura actual. Dos líneas como máximo. */
.evidence-explain {
  margin: 0;
  padding: 4px 8px;
  border: 2px solid var(--ink);
  border-top: 0;
  background: var(--surface);
  font-size: 15px;
  line-height: 1.3;
  color: var(--ink);
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  overflow: hidden;
}
.meta {
  margin: 6px 0 0;
  color: var(--muted);
  font-size: 14px;
}
</style>
