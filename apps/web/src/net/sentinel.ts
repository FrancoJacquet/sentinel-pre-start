import { reactive } from 'vue';
import { alertText } from '../labels.ts';
import {
  PROTOCOL_VERSION,
  parseServerMessage,
  type ClientMessage,
  type ClientPayload,
  type ServerPayload,
} from '@sentinel/contracts';

export const MACHINE_ID = 'pg-01';
export const CAMERA_ID = 'cam-01';

export interface LogEntry {
  at: string;
  level: 'info' | 'warning' | 'critical';
  text: string;
}

// Id aleatorio sin crypto.randomUUID: la página se sirve por http en la
// tailnet y randomUUID sólo existe en contextos seguros.
export function newId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `${prefix}-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

// Salida REAL del modelo sobre el frame evaluado (contrato compartido
// perception.state.payload.overlay); null si no hubo modelo.
export type { PerceptionOverlay } from '@sentinel/contracts';
export type PerceptionView = ServerPayload<'perception.state'>;
// Aviso del reloj SIMULADO del técnico (evento del servidor, no estado).
export type WearableNotice = ServerPayload<'wearable.notify'>;

// Cuántos frames propios se guardan en memoria para mostrar el evaluado.
const KEPT_FRAMES = 4;

export type FrameRequest = ServerPayload<'frame.request'>;
export type FrameReply = Omit<ClientPayload<'frame.capture'>, keyof FrameRequest> & { width: number; height: number };

export function createSentinel(url = `ws://${location.hostname}:${__API_PORT__}/ws`) {
  const state = reactive({
    connection: 'connecting' as 'connecting' | 'open' | 'closed',
    plc: null as ServerPayload<'plc.state'> | null,
    perception: null as PerceptionView | null,
    log: [] as LogEntry[],
    // frameId → blob URL del JPEG que mandó esta pestaña. Así el panel muestra
    // los píxeles exactos que evaluó el servidor, sin pedírselos de vuelta.
    frameImages: {} as Record<string, string>,
    // Último aviso al reloj del técnico. Mismo notificationId ⇒ el texto de
    // Muse Spark reemplaza al fijo; no es estado de la zona, es lo último que
    // vibró en la muñeca (con su hora).
    wearable: null as WearableNotice | null,
  });

  let ws: WebSocket | null = null;
  // notificationId del reloj ya recibidos.
  const seenWearable = new Set<string>();
  let seq = 0;
  let retry = 0;
  let cameraConnected = false;
  // Quién saca la foto: lo conecta la escena 3D.
  let frameProvider: ((req: FrameRequest) => FrameReply) | null = null;
  // correlationId de los frames enviados: si el servidor rechaza uno porque
  // llegó tarde (pedido ya cerrado), no es un error del pedido del operario.
  const sentFrames: string[] = [];

  function log(level: LogEntry['level'], text: string) {
    state.log.unshift({ at: new Date().toLocaleTimeString('en-GB', { hour12: false }), level, text });
    state.log.length = Math.min(state.log.length, 50);
  }

  function send<T extends ClientMessage['type']>(type: T, payload: ClientPayload<T>): string | null {
    if (!ws || ws.readyState !== WebSocket.OPEN) return null;
    const correlationId = newId('c');
    ws.send(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        seq: seq++,
        ts: new Date().toISOString(),
        correlationId,
        requestId: newId('r'),
        type,
        payload,
      }),
    );
    return correlationId;
  }

  function rememberFrame(corr: string | null) {
    if (!corr) return;
    sentFrames.push(corr);
    if (sentFrames.length > 8) sentFrames.shift();
  }

  const keptOrder: string[] = [];
  function keepFrame(frameId: string, base64: string) {
    try {
      const bin = atob(base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      state.frameImages[frameId] = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
      keptOrder.push(frameId);
      while (keptOrder.length > KEPT_FRAMES) {
        const old = keptOrder.shift()!;
        URL.revokeObjectURL(state.frameImages[old]!);
        delete state.frameImages[old];
      }
    } catch {
      // Sin imagen local el panel lo dice; no rompe el pedido.
    }
  }

  function answerFrame(req: FrameRequest) {
    const ids = { cameraId: req.cameraId, frameRequestId: req.frameRequestId };
    try {
      if (!frameProvider) throw new Error('no frame provider');
      const reply = frameProvider(req);
      const corr = send('frame.capture', { ...ids, frameId: req.frameId, ...reply });
      rememberFrame(corr);
      if (corr) keepFrame(req.frameId, reply.dataBase64);
    } catch (err) {
      rememberFrame(send('frame.error', { ...ids, message: err instanceof Error ? err.message : String(err) }));
    }
  }

  function connect() {
    state.connection = 'connecting';
    ws = new WebSocket(url);
    ws.onopen = () => {
      retry = 0;
      state.connection = 'open';
      log('info', 'Connected to the virtual PLC.');
      if (cameraConnected) send('camera.status', { cameraId: CAMERA_ID, connected: true });
    };
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = parseServerMessage(JSON.parse(String(ev.data)));
      } catch {
        log('warning', 'Server message outside the contract; dropped.');
        return;
      }
      switch (msg.type) {
        case 'plc.state':
          state.plc = msg.payload;
          break;
        case 'perception.state':
          state.perception = msg.payload;
          break;
        case 'alert':
          log(msg.payload.level, alertText(msg.payload.code, msg.payload.message));
          break;
        case 'protocol.error':
          // Frame tardío: la captura terminó después del tiempo límite y el
          // pedido ya cerró (CAPTURE_FAILED). Se anota como dato, no como rechazo.
          if (sentFrames.includes(msg.correlationId)) {
            log('info', 'Late frame dropped: capture took longer than the time limit.');
          } else {
            log('warning', `Request rejected: ${msg.payload.message}`);
          }
          break;
        case 'frame.request':
          answerFrame(msg.payload);
          break;
        case 'wearable.notify': {
          const id = msg.payload.notificationId;
          const replaces = seenWearable.has(id);
          // Un id ya visto sólo reemplaza el texto del aviso vigente: uno viejo
          // que llega tarde no pisa al nuevo ni revive uno ya apagado.
          if (replaces && state.wearable?.notificationId !== id) break;
          seenWearable.add(id);
          state.wearable = msg.payload;
          // Como info: el aviso de bloqueo sigue siendo el que va arriba del escenario.
          log(
            'info',
            replaces
              ? "Technician's watch (simulated): Muse Spark rewrote the warning."
              : "Technician's watch (simulated): warning sent to the technician in the zone.",
          );
          break;
        }
      }
    };
    ws.onclose = () => {
      // Sin conexión no hay estado del PLC ni de percepción: se borra, no se
      // sigue mostrando el último como actual.
      state.connection = 'closed';
      state.plc = null;
      state.perception = null;
      const delay = Math.min(5000, 500 * 2 ** retry++);
      setTimeout(connect, delay);
    };
  }

  connect();

  return {
    state,
    requestStart() {
      // Cada ENERGIZE es una autorización humana nueva.
      const authorizationId = newId('auth');
      if (send('start.request', { machineId: MACHINE_ID, authorizationId })) {
        log('info', 'ENERGIZE request sent (new authorization).');
      } else {
        // Sin conexión el pedido no sale: se dice, no se traga en silencio.
        log('warning', 'ENERGIZE not sent: no connection to the virtual PLC.');
      }
    },
    requestStop() {
      send('stop.request', { machineId: MACHINE_ID });
    },
    // Eventos locales de la UI (botonera) al mismo registro.
    log,
    setFrameProvider(provider: (req: FrameRequest) => FrameReply) {
      frameProvider = provider;
    },
    setCamera(connected: boolean) {
      cameraConnected = connected;
      send('camera.status', { cameraId: CAMERA_ID, connected });
    },
  };
}

export type Sentinel = ReturnType<typeof createSentinel>;
