<script setup lang="ts">
import { computed } from 'vue';
import type { PlcState } from '@sentinel/contracts';

// Seccionador VIRTUAL del tablero del puente grúa PG-01. Sólo manda pedidos
// al PLC virtual: no comanda hardware. El enclavamiento de la seta es sólo de
// esta pantalla (el PLC virtual no lo conoce): recargar la página lo pierde.
const props = defineProps<{
  plcState: PlcState | null;
  canStart: boolean;
  canStop: boolean;
  latched: boolean;
}>();
const emit = defineEmits<{ start: []; stop: []; estop: []; reset: [] }>();

// Piloto del tablero: lo que dice el PLC, no lo que suponemos.
const lamp = computed<'red' | 'amber' | 'green' | 'off'>(() => {
  if (props.latched) return 'red';
  const st = props.plcState;
  if (st === 'BLOCKED') return 'red';
  if (st === 'START_REQUESTED') return 'amber';
  if (st === 'ENABLED' || st === 'RUNNING') return 'green';
  return 'off';
});
// Energizado = el PLC habilitó. Sólo entonces se ilumina ENERGIZE y la manija
// pasa a I: verde prendido nunca convive con "Blocked".
const energized = computed(() => props.plcState === 'ENABLED' || props.plcState === 'RUNNING');
const lampText = computed(() => {
  if (props.latched) return 'E-stop latched';
  return {
    red: 'Blocked',
    amber: 'Checking zone',
    green: 'Energized',
    off: props.plcState ? 'De-energized' : 'No PLC',
  }[lamp.value];
});
</script>

<template>
  <div class="bay" role="group" aria-labelledby="disconnect-title" data-testid="pendant" :data-latched="latched">
    <div class="enclosure">
      <span class="screw tl" aria-hidden="true"></span>
      <span class="screw tr" aria-hidden="true"></span>
      <span class="screw bl" aria-hidden="true"></span>
      <span class="screw br" aria-hidden="true"></span>

      <header class="nameplate">
        <span class="np-main">PG-01</span>
        <span class="np-sub">MAIN DISCONNECT</span>
      </header>

      <div class="upper">
        <!-- Manija rotativa: muestra la posición que reporta el PLC. Decorativa. -->
        <div class="rotary" :data-pos="energized ? 'on' : 'off'" aria-hidden="true">
          <span class="mark mark-off">0 OFF</span>
          <span class="mark mark-on">I ON</span>
          <span class="escutcheon">
            <span class="handle"><span class="grip"></span></span>
          </span>
          <span class="hasp">No padlock applied</span>
        </div>

        <div class="signal">
          <span class="lamp-bezel">
            <span class="lamp" :data-lamp="lamp" data-testid="pendant-lamp" :data-state="lamp"></span>
          </span>
          <span class="lamp-text" role="status">{{ lampText }}</span>
          <span class="hazard" aria-hidden="true">
            <svg viewBox="0 0 40 36" width="34" height="31">
              <path d="M20 2 38 34H2Z" fill="#f2c200" stroke="#1d1d1b" stroke-width="2.4" stroke-linejoin="round" />
              <path d="M22.5 11 14.5 22h6l-3 9 8.5-12h-6l2.5-8z" fill="#1d1d1b" />
            </svg>
            <span class="volt">400 V</span>
          </span>
        </div>
      </div>

      <div class="controls">
        <button
          type="button"
          class="push energize"
          :data-lit="energized"
          :disabled="!canStart"
          @click="emit('start')"
          data-testid="request-start"
        >
          <span class="bezel" aria-hidden="true"><span class="cap">I</span></span>
          <span class="legend">ENERGIZE</span>
        </button>
        <button type="button" class="push deenergize" :disabled="!canStop" @click="emit('stop')" data-testid="request-stop">
          <span class="bezel" aria-hidden="true"><span class="cap">O</span></span>
          <span class="legend">DE-ENERGIZE</span>
        </button>
      </div>

      <div class="controls emergency">
        <div class="estop-plate">
          <button
            type="button"
            class="estop"
            :data-latched="latched"
            :disabled="latched"
            @click="emit('estop')"
            data-testid="estop"
          >
            <span class="mushroom" aria-hidden="true"></span>
            <span class="sr">{{ latched ? 'Emergency stop latched' : 'Emergency stop' }}</span>
          </button>
          <span class="estop-legend" aria-hidden="true">E-STOP</span>
        </div>
        <button type="button" class="push reset" :disabled="!latched" @click="emit('reset')" data-testid="estop-reset">
          <span class="bezel" aria-hidden="true"><span class="cap"></span></span>
          <span class="legend">RESET</span>
        </button>
      </div>

      <p class="rating" aria-hidden="true">400 V 3~ 50 Hz · 63 A · IP65</p>
    </div>

    <div class="notes">
      <h3 id="disconnect-title">PG-01 main disconnect</h3>
      <p class="meta">
        Virtual panel, drives no hardware. Each ENERGIZE is a new human authorization; it closes only if the model
        observed the work zone clear.
      </p>
      <p v-if="latched" class="latch-note" data-testid="estop-note">
        E-stop latched: ENERGIZE does not respond. RESET energizes nothing; a new ENERGIZE is needed afterwards.
      </p>
    </div>
  </div>
</template>

<style scoped>
.bay {
  padding: 14px 20px 16px;
  border-bottom: 1px solid var(--line);
}
/* Pantallas bajas (1440×860, 1920×1080 con barra del navegador): el tablero
   se achica entero para que veredicto, zona y botones entren sin scroll. */
@media (max-height: 1000px) {
  .bay {
    padding: 10px 20px 10px;
  }
  .enclosure {
    zoom: 0.78;
  }
}
@media (min-height: 1001px) and (max-height: 1150px) {
  .enclosure {
    zoom: 0.9;
  }
}

/* Gabinete de chapa RAL 7035 (gris claro), pintura texturada. */
.enclosure {
  position: relative;
  display: grid;
  gap: 12px;
  padding: 16px 18px 12px;
  border-radius: 5px;
  background:
    radial-gradient(rgb(0 0 0 / 0.035) 1px, transparent 1.2px) 0 0 / 4px 4px,
    linear-gradient(180deg, #d6dad6 0%, #cbd0cc 45%, #bdc2be 100%);
  box-shadow:
    inset 0 0 0 1px rgb(255 255 255 / 0.5),
    inset 0 0 0 5px #c4c9c5,
    inset 0 0 0 6px rgb(0 0 0 / 0.18),
    0 10px 16px -8px rgb(28 38 44 / 0.55),
    0 0 0 1px #9da29e;
}
.screw {
  position: absolute;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background:
    linear-gradient(45deg, transparent 42%, #4b4e4b 42% 58%, transparent 58%),
    radial-gradient(circle at 40% 35%, #f0f1ee, #8d918d);
  box-shadow: 0 0 0 1px rgb(0 0 0 / 0.3);
}
.tl {
  top: 9px;
  left: 9px;
}
.tr {
  top: 9px;
  right: 9px;
}
.bl {
  bottom: 9px;
  left: 9px;
}
.br {
  bottom: 9px;
  right: 9px;
}

/* Placa grabada (traffolyte): letras blancas sobre negro. */
.nameplate {
  justify-self: center;
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 4px 12px;
  border-radius: 2px;
  background: linear-gradient(180deg, #2b2e2d, #161817);
  box-shadow: 0 1px 0 rgb(255 255 255 / 0.6), inset 0 0 0 1px #000;
  color: #f1f1ec;
  font-family: var(--font-display);
  letter-spacing: 0.06em;
}
.np-main {
  font-size: 18px;
  font-weight: 600;
}
.np-sub {
  font-size: 13px;
  font-weight: 600;
}

.upper {
  display: grid;
  grid-template-columns: 132px minmax(0, 1fr);
  gap: 10px;
  align-items: center;
}

/* Seccionador rotativo: manija negra sobre escudo cuadrado, 0 horizontal, I vertical. */
.rotary {
  position: relative;
  display: grid;
  justify-items: center;
  padding-top: 16px;
}
.mark {
  position: absolute;
  top: 0;
  font: 600 11px/1 var(--font-display);
  color: #2a2d2b;
  letter-spacing: 0.04em;
}
.mark-off {
  left: 2px;
}
.mark-on {
  right: 6px;
}
.rotary[data-pos='off'] .mark-off,
.rotary[data-pos='on'] .mark-on {
  color: #000;
  text-decoration: underline 2px;
  text-underline-offset: 2px;
}
.escutcheon {
  display: grid;
  place-items: center;
  width: 96px;
  height: 96px;
  border-radius: 8px;
  background: linear-gradient(160deg, #e4e6e2, #b7bbb7);
  box-shadow:
    inset 0 0 0 1px rgb(0 0 0 / 0.3),
    inset 0 -3px 4px rgb(0 0 0 / 0.15),
    0 2px 3px rgb(0 0 0 / 0.25);
}
.handle {
  position: relative;
  display: grid;
  place-items: center;
  width: 84px;
  height: 26px;
  border-radius: 13px 13px 13px 13px / 13px 13px 13px 13px;
  background: linear-gradient(180deg, #3d4140, #121413 60%, #050606);
  box-shadow:
    0 4px 0 #000,
    0 7px 8px rgb(0 0 0 / 0.45);
  transform: rotate(0deg);
  transition: transform 260ms cubic-bezier(0.3, 1.4, 0.5, 1);
}
.rotary[data-pos='on'] .handle {
  transform: rotate(90deg);
}
.grip {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  background: radial-gradient(circle at 40% 35%, #4a4f4d, #141615 70%);
  box-shadow: inset 0 0 0 1px #000, 0 2px 2px rgb(0 0 0 / 0.5);
}
/* Orejeta para candados: el punto de bloqueo (LOTO) de cada técnico. */
.hasp {
  margin-top: 6px;
  padding: 2px 10px 3px;
  border-radius: 3px 3px 8px 8px;
  background: #b3261e;
  box-shadow: inset 0 0 0 1px rgb(0 0 0 / 0.35);
  color: #f4f5f2;
  font: 600 10px/1 var(--font-display);
  letter-spacing: 0.04em;
}

.signal {
  display: grid;
  justify-items: center;
  gap: 6px;
  text-align: center;
}
.lamp-bezel {
  display: grid;
  place-items: center;
  width: 46px;
  height: 46px;
  border-radius: 50%;
  background: radial-gradient(circle at 40% 35%, #e7e9e6, #8e928e 75%);
  box-shadow: inset 0 0 0 1px rgb(0 0 0 / 0.35), 0 2px 2px rgb(0 0 0 / 0.25);
}
.lamp {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: radial-gradient(circle at 35% 35%, #7a7e7b, #343735);
  box-shadow: inset 0 0 0 1px #000;
}
.lamp[data-lamp='red'] {
  background: radial-gradient(circle at 35% 35%, #ff9a8a, #e0261b 60%);
  box-shadow: 0 0 14px #ff3b2a;
}
.lamp[data-lamp='amber'] {
  background: radial-gradient(circle at 35% 35%, #ffe7a6, #f0a400 60%);
  box-shadow: 0 0 14px #ffb400;
  animation: blink 0.9s steps(2, jump-none) infinite;
}
.lamp[data-lamp='green'] {
  background: radial-gradient(circle at 35% 35%, #c6f9b8, #2fbf4a 60%);
  box-shadow: 0 0 14px #39d35a;
}
@keyframes blink {
  50% {
    opacity: 0.35;
  }
}
.lamp-text {
  min-width: 112px;
  padding: 2px 8px;
  border-radius: 2px;
  background: #161817;
  color: #f1f1ec;
  font: 600 14px/1.25 var(--font-display);
  letter-spacing: 0.03em;
}
.hazard {
  display: flex;
  align-items: center;
  gap: 4px;
}
.volt {
  font: 600 18px/1 var(--font-display);
  color: #1d1d1b;
}

.controls {
  display: grid;
  grid-template-columns: 1fr 1fr;
  justify-items: center;
  align-items: end;
  padding-top: 10px;
  border-top: 1px solid rgb(0 0 0 / 0.12);
}
.push {
  display: grid;
  justify-items: center;
  gap: 6px;
  padding: 0;
  border: 0;
  background: none;
  cursor: pointer;
}
.bezel {
  display: grid;
  place-items: center;
  width: 62px;
  height: 62px;
  border-radius: 50%;
  background: radial-gradient(circle at 40% 35%, #f2f3f0, #9a9e9a 72%);
  box-shadow: inset 0 0 0 1px rgb(0 0 0 / 0.4), 0 2px 3px rgb(0 0 0 / 0.3);
}
.cap {
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  color: rgb(255 255 255 / 0.85);
  font: 600 20px/1 var(--font-display);
  box-shadow:
    inset 0 -4px 6px rgb(0 0 0 / 0.35),
    inset 0 3px 4px rgb(255 255 255 / 0.25);
  transition: transform 80ms ease-out, filter 120ms;
}
/* Presionable: la tapa sobresale del bisel. La luz es estado, no invitación:
   ENERGIZE se ilumina sólo con el circuito habilitado. */
.push:not(:disabled) .cap {
  box-shadow:
    inset 0 -4px 6px rgb(0 0 0 / 0.35),
    inset 0 3px 4px rgb(255 255 255 / 0.3),
    0 3px 0 rgb(0 0 0 / 0.55),
    0 5px 5px rgb(0 0 0 / 0.35);
  transform: translateY(-2px);
}
.push:active:not(:disabled) .cap {
  transform: translateY(0) scale(0.96);
}
.energize .cap {
  background: radial-gradient(circle at 40% 35%, #5fae68, #22762f 55%, #154d1d);
}
.energize[data-lit='true'] .cap {
  background: radial-gradient(circle at 40% 35%, #c4ffc0, #3fdc5c 50%, #1f8a33);
  color: #0f3d17;
}
.energize[data-lit='true'] .bezel {
  box-shadow: inset 0 0 0 1px rgb(0 0 0 / 0.4), 0 0 0 3px #2fbf4a, 0 0 16px #2fbf4a;
}
.deenergize .cap {
  background: radial-gradient(circle at 40% 35%, #555a58, #1b1d1c 55%, #050606);
}
.reset .bezel {
  width: 50px;
  height: 50px;
}
.reset .cap {
  width: 34px;
  height: 34px;
  background: radial-gradient(circle at 40% 35%, #7fb0e8, #22609f 55%, #143c66);
}
.reset:not(:disabled) .bezel {
  box-shadow: inset 0 0 0 1px rgb(0 0 0 / 0.4), 0 0 0 3px #4d9be8, 0 0 12px #4d9be8;
}
/* No disponible: la tapa queda a ras y opaca (sigue siendo un objeto). */
.push:disabled {
  cursor: not-allowed;
}
.push:disabled .cap {
  filter: saturate(0.35) brightness(0.68);
}
/* Rótulos: placas blancas grabadas en negro, como en un tablero real. */
.legend {
  min-width: 92px;
  padding: 2px 6px;
  border-radius: 2px;
  background: #f6f6f1;
  color: #161817;
  font: 600 13px/1.15 var(--font-display);
  letter-spacing: 0.05em;
  box-shadow: inset 0 0 0 1px rgb(0 0 0 / 0.4);
}
.push:disabled .legend {
  color: #747874;
}

/* Seta de emergencia: roja sobre placa amarilla, como pide la norma. */
.estop-plate {
  position: relative;
  display: grid;
  place-items: center;
  width: 112px;
  height: 112px;
  border-radius: 50%;
  background: #f6c52a;
  box-shadow:
    inset 0 0 0 2px var(--hazard-dark),
    inset 0 0 0 5px #f6c52a,
    inset 0 0 0 6px rgb(34 34 31 / 0.35);
}
.estop-legend {
  position: absolute;
  bottom: 7px;
  font: 600 11px/1 var(--font-display);
  letter-spacing: 0.08em;
  color: var(--hazard-dark);
}
.estop {
  width: 80px;
  height: 80px;
  margin-bottom: 8px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: #1b1d1c;
  cursor: pointer;
  display: grid;
  place-items: center;
}
.mushroom {
  width: 70px;
  height: 70px;
  border-radius: 50%;
  background: radial-gradient(circle at 38% 30%, #ff7a68 0, #d8281d 38%, #9c1510 78%, #6e0d09 100%);
  box-shadow:
    0 6px 0 #5a0b07,
    0 9px 8px rgb(0 0 0 / 0.45);
  transform: translateY(-5px);
  transition: transform 90ms ease-out, box-shadow 90ms ease-out;
}
/* Enclavada: la seta queda hundida. */
.estop[data-latched='true'] .mushroom {
  transform: translateY(0);
  box-shadow:
    0 1px 0 #5a0b07,
    0 2px 3px rgb(0 0 0 / 0.5);
  filter: saturate(0.85);
}
.estop:active .mushroom {
  transform: translateY(0);
}
.estop:disabled {
  cursor: not-allowed;
}
.push:focus-visible,
.estop:focus-visible {
  outline: 3px solid var(--hazard-dark);
  outline-offset: 3px;
  border-radius: 8px;
}
.estop:focus-visible {
  border-radius: 50%;
}

.rating {
  justify-self: end;
  margin: 0;
  padding: 1px 6px;
  border-radius: 2px;
  background: #e9eae4;
  box-shadow: inset 0 0 0 1px rgb(0 0 0 / 0.25);
  color: #3c3f3d;
  font: 600 10px/1.4 ui-monospace, monospace;
}

.notes {
  padding-top: 12px;
}
.notes h3 {
  margin: 0 0 6px;
  font: 600 17px/1.2 var(--font);
}
.notes p {
  margin: 0 0 8px;
  font-size: 15px;
}
.notes .meta {
  color: var(--muted);
  font-size: 14px;
}
.latch-note {
  padding: 6px 8px;
  border-left: 4px solid var(--red);
  background: rgb(184 35 27 / 0.08);
}
.sr {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
</style>
