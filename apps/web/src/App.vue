<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { createSentinel } from './net/sentinel.ts';
import { CAMERA_VIEWPORT, SCENE_REVISION, createFactoryScene, type FactoryScene } from './scene/factory.ts';
import { PLC_LABEL, REASON_LABEL, WEARABLE_SOURCE_LABEL, zoneTitle, zoneVerdict } from './labels.ts';
import DisconnectPanel from './components/DisconnectPanel.vue';
import CamEvidence from './components/CamEvidence.vue';

const sentinel = createSentinel();
// ?video=1: para grabar la demo, sin los detalles de depuración.
const videoMode = new URLSearchParams(location.search).get('video') === '1';
const s = sentinel.state;

const canvas = ref<HTMLCanvasElement | null>(null);
const truthInside = ref<boolean | null>(null);
const cameraOn = ref(false);
const sceneStatus = ref<'loading' | 'ready' | 'error'>('loading');
const sceneError = ref('');
let scene: FactoryScene | null = null;

onMounted(() => {
  scene = createFactoryScene(canvas.value!, {
    onTruthChange: (inside) => {
      truthInside.value = inside;
      // Como el reloj de la escena: fuera de la zona el aviso ya no corre.
      if (!inside) s.wearable = null;
    },
    onReady: () => {
      sceneStatus.value = 'ready';
      setCamera(true);
      syncScene(plcState.value);
      syncWatch();
    },
    onError: (msg) => {
      sceneStatus.value = 'error';
      sceneError.value = msg;
    },
  }, new URLSearchParams(location.search).get('quality') === 'low' ? 'low' : 'high');
});
onBeforeUnmount(() => scene?.dispose());

sentinel.setFrameProvider((req) => {
  if (!scene) throw new Error('scene not created');
  const f = scene.captureFrame(req.width, req.height);
  return {
    captureTs: new Date().toISOString(),
    width: f.width,
    height: f.height,
    mime: 'image/jpeg',
    sceneRevision: SCENE_REVISION,
    dataBase64: f.jpegBase64,
    simTruth: { operatorInZone: f.operatorInZone },
  };
});

const frameInfo = computed(() => {
  const f = s.perception?.frame;
  if (!f) return null;
  const at = new Date(f.receivedAt).toLocaleTimeString('en-GB', { hour12: false });
  return { id: f.frameId, sha: f.sha256.slice(0, 12), at, size: `${f.width}×${f.height}` };
});

function setCamera(on: boolean) {
  cameraOn.value = on;
  scene?.setCameraFeed(on);
  sentinel.setCamera(on);
}

const plcState = computed(() => s.plc?.state ?? null);
const verdict = computed(() => zoneVerdict(s.perception?.status));
// JPEG del frame evaluado, si lo mandó esta pestaña.
const evaluatedImage = computed(() => {
  const id = s.perception?.frame?.frameId;
  return (id && s.frameImages[id]) || null;
});
// Seta de emergencia enclavada (local, del tablero virtual): mientras está
// hundida ENERGIZE no responde. RESET sólo desenclava, nunca energiza.
const estopLatched = ref(false);
const canRequest = computed(
  () =>
    !estopLatched.value && s.connection === 'open' && ['IDLE', 'BLOCKED', 'STOPPED'].includes(plcState.value ?? ''),
);
const canStop = computed(() => ['ENABLED', 'RUNNING'].includes(plcState.value ?? ''));

function pressStart() {
  if (!canRequest.value) return;
  // Pedido nuevo: el aviso anterior del reloj ya no es el de este pedido.
  scene?.clearWatch();
  s.wearable = null;
  sentinel.requestStart();
}
function pressEstop() {
  estopLatched.value = true;
  sentinel.requestStop();
  sentinel.log('critical', 'Emergency stop latched on the PG-01 panel.');
}
function pressReset() {
  estopLatched.value = false;
  sentinel.log('info', 'E-stop reset. Nothing is energized: a new ENERGIZE is needed.');
}

// Baliza y movimiento de la grúa: sólo lo que dice el PLC. La escena nunca
// arranca sola.
function syncScene(st: string | null) {
  scene?.setStackLight(
    st === 'BLOCKED' ? 'red' : st === 'START_REQUESTED' ? 'amber' : st === 'RUNNING' || st === 'ENABLED' ? 'green' : 'off',
  );
  scene?.setMachineRunning(st === 'RUNNING');
}
watch(plcState, (st) => {
  syncScene(st);
  // Con la seta enclavada no se acepta energizar: si un pedido en curso igual
  // habilitó, se vuelve a mandar parada.
  if (estopLatched.value && (st === 'ENABLED' || st === 'RUNNING')) sentinel.requestStop();
});

// Reloj SIMULADO del técnico: cada wearable.notify va a la muñeca en la escena.
// Mismo notificationId ⇒ el texto de Muse Spark reemplaza al fijo, sin vibrar
// de nuevo. Es sólo un aviso: el PLC no lo lee.
const wearableAt = computed(() =>
  s.wearable ? new Date(s.wearable.at).toLocaleTimeString('en-GB', { hour12: false }) : '',
);
function syncWatch() {
  const n = s.wearable;
  if (n) scene?.notifyWatch({ id: n.notificationId, text: n.text, sourceLabel: WEARABLE_SOURCE_LABEL[n.source] });
}
watch(() => s.wearable, syncWatch);

// Último aviso (rechazo, bloqueo, error de protocolo) arriba del escenario:
// un ENERGIZE rechazado no puede quedar sólo en el registro, debajo del pliegue.
const TOAST_MS = 8000;
const toast = ref<{ level: string; text: string; at: string } | null>(null);
let toastTimer: ReturnType<typeof setTimeout> | undefined;
watch(
  () => s.log[0],
  (e) => {
    if (!e || e.level === 'info') return;
    toast.value = { level: e.level, text: e.text, at: e.at };
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast.value = null), TOAST_MS);
  },
);
onBeforeUnmount(() => clearTimeout(toastTimer));

const camStyle = {
  left: `${CAMERA_VIEWPORT.x * 100}%`,
  bottom: `${CAMERA_VIEWPORT.y * 100}%`,
  width: `${CAMERA_VIEWPORT.w * 100}%`,
  height: `${CAMERA_VIEWPORT.h * 100}%`,
};
</script>

<template>
  <div class="shell" :class="{ video: videoMode }">
    <header class="bar">
      <h1>Sentinel <span>Pre-energization check · overhead crane PG-01</span></h1>
      <p class="sim-tag">Simulation — not a safety system</p>
      <p class="conn" :data-conn="s.connection" data-testid="connection">
        {{ s.connection === 'open' ? 'Virtual PLC connected' : s.connection === 'connecting' ? 'Connecting…' : 'No connection to the virtual PLC' }}
      </p>
    </header>

    <main class="stage">
      <canvas ref="canvas" class="scene" aria-label="Simulated plant with the overhead crane, the work zone and the worker. Drag the worker to move them."></canvas>
      <p v-if="sceneStatus !== 'ready'" class="scene-status" :data-status="sceneStatus" data-testid="scene-status">
        {{ sceneStatus === 'loading' ? 'Loading the plant…' : sceneError }}
      </p>
      <div class="cam-frame" :style="camStyle" data-testid="camera-view">
        <span class="cam-name">CAM-01 · live</span>
        <span v-if="!cameraOn" class="no-signal">No signal</span>
      </div>
      <p v-if="toast" class="toast" role="alert" :data-level="toast.level" data-testid="event-toast">
        <time>{{ toast.at }}</time> {{ toast.text }}
      </p>
      <!-- Frame evaluado con la salida de SAM, debajo de la vista en vivo. -->
      <CamEvidence class="evidence-card" :perception="s.perception" :image-url="evaluatedImage" />
      <div class="stage-tools">
        <button type="button" @click="scene?.moveOperator('zone')" data-testid="op-to-zone">Move worker into work zone</button>
        <button type="button" @click="scene?.moveOperator('outside')" data-testid="op-out">Move worker out</button>
        <button type="button" @click="setCamera(!cameraOn)" data-testid="camera-toggle" :data-camera="cameraOn ? 'on' : 'off'">
          {{ cameraOn ? 'Disconnect camera' : 'Connect camera' }}
        </button>
      </div>
    </main>

    <aside class="panel">
      <p class="mission" data-testid="mission">
        Before power is restored, CAM-01 checks the work zone. Person or unknown ⇒ no energize.
        <small>Adds to lockout/tagout. It never replaces a personal padlock.</small>
      </p>

      <section class="verdict" :data-plc="plcState ?? 'NONE'" data-testid="plc-state" :data-state="plcState ?? ''">
        <h2>{{ plcState ? PLC_LABEL[plcState] : 'No PLC state' }}</h2>
        <p v-if="s.plc?.reason" class="reason" data-testid="plc-reason" :data-reason="s.plc.reason">
          {{ REASON_LABEL[s.plc.reason] }} <code>{{ s.plc.reason }}</code>
        </p>
        <p v-else-if="!plcState" class="reason">No connection, no state: the circuit cannot be energized.</p>
      </section>

      <section class="zone" :data-verdict="verdict" data-testid="perception" :data-status="s.perception?.status ?? ''">
        <h3>{{ zoneTitle(s.perception?.status) }}</h3>
        <p>
          <template v-if="s.perception">
            {{ REASON_LABEL[s.perception.status] }} <code>{{ s.perception.status }}</code>
          </template>
          <template v-else>No perception data.</template>
        </p>
        <p class="meta" v-if="s.perception">
          Evidence: {{ s.perception.source === 'none' ? 'none' : s.perception.source === 'model' ? 'model' : 'simulation' }},
          expires after {{ s.perception.freshnessTtlMs / 1000 }} s<template v-if="frameInfo">
            · frame {{ frameInfo.size }} at {{ frameInfo.at }} stored</template>
        </p>
        <p class="meta frame" v-if="frameInfo" data-testid="frame-info" :data-frame-id="frameInfo.id">
          <code>{{ frameInfo.id }} · {{ frameInfo.size }} · sha256 {{ frameInfo.sha }}…</code>
        </p>
      </section>

      <section class="wearable" data-testid="wearable" :data-source="s.wearable?.source ?? ''">
        <h3>Technician's watch <span>— simulated wearable</span></h3>
        <template v-if="s.wearable">
          <p class="watch-text">{{ s.wearable.text }}</p>
          <p class="meta">{{ WEARABLE_SOURCE_LABEL[s.wearable.source] }} · <time>{{ wearableAt }}</time></p>
        </template>
        <p v-else class="meta">No warning sent. It buzzes only when ENERGIZE is blocked with a person in the zone.</p>
      </section>

      <section class="truth" data-testid="sim-truth" :data-inside="truthInside === null ? '' : String(truthInside)">
        <h3>Simulator truth</h3>
        <p>
          Worker <strong>{{ truthInside === null ? '…' : truthInside ? 'inside' : 'outside' }}</strong> the work zone
        </p>
        <p class="meta">3D engine ground truth, only to measure. The PLC ignores it.</p>
      </section>

      <DisconnectPanel
        :plc-state="plcState"
        :can-start="canRequest"
        :can-stop="canStop"
        :latched="estopLatched"
        @start="pressStart"
        @stop="sentinel.requestStop()"
        @estop="pressEstop"
        @reset="pressReset"
      />

      <section class="log">
        <h3>Event log</h3>
        <ol data-testid="log">
          <li v-for="(e, i) in s.log" :key="i" :data-level="e.level">
            <time>{{ e.at }}</time> {{ e.text }}
          </li>
          <li v-if="!s.log.length" class="meta">Nothing has happened yet.</li>
        </ol>
      </section>
    </aside>
  </div>
</template>

<style scoped>
.shell {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 380px;
  grid-template-rows: auto minmax(0, 1fr);
  height: 100vh;
}
.bar {
  grid-column: 1 / -1;
  display: flex;
  align-items: baseline;
  gap: 24px;
  padding: 10px 20px;
  border-bottom: 1px solid var(--line);
  background: var(--surface);
}
h1 {
  margin: 0;
  font: 600 22px/1.1 var(--font-display);
}
h1 span {
  font: 400 16px var(--font);
  color: var(--muted);
  margin-left: 8px;
}
.sim-tag {
  margin: 0;
  color: var(--muted);
}
.conn {
  margin: 0 0 0 auto;
  padding-left: 14px;
  position: relative;
}
.conn::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0.45em;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--muted);
}
.conn[data-conn='closed']::before {
  background: var(--red);
}

.stage {
  position: relative;
  min-height: 0;
}
.scene {
  width: 100%;
  height: 100%;
  display: block;
  touch-action: none;
  outline: none;
}
.scene-status {
  position: absolute;
  inset: 0;
  margin: 0;
  display: grid;
  place-items: center;
  padding: 24px;
  text-align: center;
  color: var(--surface);
  font-size: 20px;
  background: rgb(28 38 44 / 0.7);
}
.scene-status[data-status='error'] {
  background: var(--hazard-dark);
}
.cam-frame {
  position: absolute;
  pointer-events: none;
  border: 2px solid var(--ink);
}
.cam-name {
  position: absolute;
  top: 0;
  left: 0;
  padding: 2px 8px;
  background: var(--ink);
  color: var(--surface);
  font-size: 14px;
}
.cam-frame:has(.no-signal) {
  background: var(--hazard-dark);
}
.no-signal {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: var(--surface);
  font: 600 22px var(--font-display);
}
.evidence-card {
  position: absolute;
  right: 1.5%;
  bottom: 16px;
  width: 33%;
  min-width: 300px;
  padding: 8px 10px 8px;
  background: var(--surface);
  border: 1px solid var(--ink);
  box-shadow: 0 8px 18px -8px rgb(28 38 44 / 0.6);
}
.stage-tools {
  position: absolute;
  left: 16px;
  bottom: 16px;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.stage-tools button {
  padding: 8px 14px;
  border: 1px solid var(--ink);
  background: var(--surface);
  color: var(--ink);
  border-radius: 3px;
  cursor: pointer;
}

.panel {
  border-left: 1px solid var(--line);
  background: var(--surface);
  overflow-y: auto;
  padding: 0 0 16px;
}
.panel section {
  padding: 14px 20px;
  border-bottom: 1px solid var(--line);
}
h2,
h3 {
  margin: 0 0 6px;
}
h3 {
  font: 600 17px var(--font);
}
p {
  margin: 0 0 6px;
}
code {
  font: 400 13px ui-monospace, monospace;
  color: var(--muted);
}
.meta {
  color: var(--muted);
  font-size: 14px;
}

.mission {
  margin: 0;
  padding: 10px 20px;
  background: var(--ink);
  color: var(--surface);
  font: 600 17px/1.3 var(--font);
}

.mission small {
  display: block;
  margin-top: 4px;
  font: 400 14px var(--font);
  opacity: 0.85;
}
.panel section {
  padding: 10px 20px;
}
.verdict h2 {
  font: 600 34px/1 var(--font-display);
}
.verdict[data-plc='BLOCKED'] {
  border-left: 8px solid var(--red);
}
.verdict[data-plc='RUNNING'],
.verdict[data-plc='ENABLED'] {
  border-left: 8px solid var(--green);
}
.reason {
  font-size: 17px;
}

/* Zona desconocida: franja de peligro. Es el estado por defecto, y se ve. */
.zone[data-verdict='unknown'] {
  background: repeating-linear-gradient(-45deg, var(--amber) 0 14px, var(--hazard-dark) 14px 28px) left / 10px 100% no-repeat,
    var(--surface);
  padding-left: 30px;
}
.zone[data-verdict='risk'] {
  border-left: 10px solid var(--red);
}
.zone[data-verdict='clear'] {
  border-left: 10px solid var(--green);
}

.truth {
  background: #dfe2e4;
}
.wearable h3 span {
  font-weight: 400;
  color: var(--muted);
}
/* Aviso al reloj: ámbar, como la pantalla en la muñeca. */
.wearable[data-source]:not([data-source='']) {
  border-left: 8px solid var(--amber);
}
.watch-text {
  font: 600 16px/1.3 var(--font);
}
/* Una línea fija: al cambiar inside/outside no salta el renglón. */
.truth p:first-of-type {
  white-space: nowrap;
}
.toast {
  position: absolute;
  top: 12px;
  left: 16px;
  max-width: min(560px, 55%);
  margin: 0;
  padding: 8px 12px 8px 14px;
  background: var(--surface);
  border: 1px solid var(--ink);
  border-left: 8px solid var(--amber);
  box-shadow: 0 8px 18px -8px rgb(28 38 44 / 0.6);
  font: 600 17px/1.3 var(--font);
}
.toast[data-level='critical'] {
  border-left-color: var(--red);
}
.toast time {
  font-weight: 400;
  margin-right: 4px;
}

.log ol {
  list-style: none;
  margin: 0;
  padding: 0;
  font-size: 14px;
}
.log li {
  padding: 3px 0;
}
.log li[data-level='warning'] {
  border-left: 3px solid var(--amber);
  padding-left: 6px;
}
.log li[data-level='critical'] {
  border-left: 3px solid var(--red);
  padding-left: 6px;
}
time {
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}

@media (max-width: 860px) {
  .shell {
    grid-template-columns: 1fr;
    grid-template-rows: auto 60vh auto;
    height: auto;
  }
  .panel {
    border-left: 0;
  }
  .evidence-card {
    width: 46%;
    min-width: 0;
    bottom: 64px;
  }
  .bar {
    flex-wrap: wrap;
    gap: 4px 16px;
    padding: 10px 16px;
  }
}

/* Modo video: fuera códigos, hashes, el registro y los botones de prueba. */
.shell.video .reason code,
.shell.video .zone p code,
.shell.video .zone .meta,
.shell.video .truth .meta,
.shell.video .mission small,
.shell.video .log,
.shell.video .stage-tools,
.shell.video :deep(.cam .meta),
.shell.video .toast,
.shell.video .zone p,
.shell.video :deep(.notes .meta) {
  display: none;
}
</style>
