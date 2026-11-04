import { AsyncLocalStorage } from 'node:async_hooks';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  PROTOCOL_VERSION,
  parseClientMessage,
  type ClientMessage,
  type ServerMessage,
  type ServerPayload,
} from '@sentinel/contracts';
import type { Config } from './config.ts';
import { disagreementNote } from './perception/advice-rule.ts';
import { PerceptionGateway } from './perception/gateway.ts';
import type { Explainer, PerceptionAdapter } from './perception/types.ts';
import { RemoteCameraFrameSource } from './perception/remote-camera.ts';
import { EvidenceStore } from './evidence/store.ts';
import { VirtualPLC, type PlcSnapshot, type StartResult } from './plc/virtual-plc.ts';
import { sparkAlertText, WEARABLE_TEMPLATE_TEXT, type WearableNotification } from './wearable.ts';

// El slice tiene una sola máquina y una sola cámara.
export const MACHINE_ID = 'pg-01';
export const CAMERA_ID = 'cam-01';

const STALE_POLL_MS = 250;

export interface RunningServer {
  ports: number[];
  close(): Promise<void>;
}

const BLOCK_MESSAGES: Record<string, string> = {
  NO_CAMERA: 'Arranque no habilitado: la cámara no está conectada.',
  CAPTURE_FAILED: 'Arranque no habilitado: la cámara no entregó un frame válido.',
  INFERENCE_DISABLED: 'Arranque no habilitado: la inferencia está apagada, no hay evidencia de zona libre.',
  BUDGET_EXHAUSTED: 'Arranque no habilitado: se alcanzó el tope de gasto.',
  MODEL_ERROR: 'Arranque no habilitado: error del modelo.',
  STALE_RESULT: 'Arranque no habilitado: la evidencia está vencida.',
  UNVERIFIED: 'Arranque no habilitado: zona sin verificar.',
  RISK_OBSERVED: 'Arranque no habilitado: riesgo observado en la zona.',
  AUTHORIZATION_REUSED: 'Arranque no habilitado: la autorización ya se usó; cada arranque pide una nueva.',
};

export async function startServer(
  config: Config,
  deps: { adapter: PerceptionAdapter; explainer?: Explainer | null; now?: () => Date },
): Promise<RunningServer> {
  const now = deps.now ?? (() => new Date());
  const clients = new Set<WebSocket>();
  const cameraOwners = new Map<WebSocket, Set<string>>();

  const store = new EvidenceStore({ dir: config.evidenceDir, maxFrames: config.evidenceMaxFrames });
  const frames = new RemoteCameraFrameSource({
    now,
    ownerOf: (cameraId) => [...cameraOwners].find(([, cams]) => cams.has(cameraId))?.[0],
    send: (owner, request) => (owner as WebSocket).send(message('frame.request', request)),
  });
  const gateway = new PerceptionGateway({
    adapter: deps.adapter,
    frames,
    freshnessTtlMs: config.freshnessTtlMs,
    timeoutMs: config.inferenceTimeoutMs,
    frameTimeoutMs: config.frameTimeoutMs,
    explainer: deps.explainer ?? null,
    // Spark corre después de la decisión: su demora no frena al PLC ni vence
    // la observación, así que tiene más margen que SAM.
    explainTimeoutMs: config.sparkTimeoutMs,
    now,
    onEvidence: (ev, frame) => store.record(ev, frame, deps.adapter.id),
  });
  let seq = 0;
  // correlationId del pedido que se está atendiendo; sigue al pedido a través
  // de los await (p. ej. mientras espera el frame). Lo espontáneo va con 'server'.
  const requestContext = new AsyncLocalStorage<string>();

  function message<T extends ServerMessage['type']>(
    type: T,
    payload: ServerPayload<T>,
    corr = requestContext.getStore() ?? 'server',
  ) {
    return JSON.stringify({ v: PROTOCOL_VERSION, seq: seq++, ts: now().toISOString(), correlationId: corr, type, payload });
  }

  function broadcast<T extends ServerMessage['type']>(type: T, payload: ServerPayload<T>) {
    const data = message(type, payload);
    for (const ws of clients) ws.send(data);
  }

  function perceptionPayload(): ServerPayload<'perception.state'> {
    const ev = gateway.current(CAMERA_ID);
    return {
      cameraId: ev.cameraId,
      status: ev.status,
      source: ev.source,
      observedAt: ev.observedAt?.toISOString() ?? null,
      freshnessTtlMs: gateway.freshnessTtlMs,
      detail: ev.detail,
      frame: ev.frame && { ...ev.frame, receivedAt: ev.frame.receivedAt.toISOString() },
      // current() ya lo pone en null si la observación venció o no es del modelo.
      overlay: ev.overlay,
      // Idem: sólo con observación vigente del modelo (Muse Spark, llega
      // después de la decisión y sólo comunica).
      explanation: ev.explanation ?? null,
      // La misma explicación como evidencia del frame evaluado: sigue después
      // de vencer (la UI la muestra junto a ese frame, rotulada como pasada) y
      // se cae con una evaluación nueva o al desconectarse la cámara.
      evidenceExplanation: ev.evidenceExplanation ?? null,
    };
  }

  let lastPerception = '';
  function publishPerception(force = false) {
    const payload = perceptionPayload();
    const key = `${payload.status}|${payload.observedAt}`;
    if (!force && key === lastPerception) return;
    lastPerception = key;
    broadcast('perception.state', payload);
  }

  function onPlcChange(s: PlcSnapshot) {
    broadcast('plc.state', s);
    if (s.state === 'BLOCKED' && s.reason) {
      const critical = s.reason === 'RISK_OBSERVED';
      broadcast('alert', {
        level: critical ? 'critical' : 'warning',
        code: s.reason,
        message: BLOCK_MESSAGES[s.reason] ?? `Arranque no habilitado: ${s.reason}.`,
      });
    }
    if (s.state === 'ENABLED') {
      // La máquina simulada arranca apenas el PLC habilita; el PLC revalida.
      setImmediate(() => plc.machineStarted());
    }
  }

  const plc = new VirtualPLC({ machineId: MACHINE_ID, cameraId: CAMERA_ID, gateway, onChange: onPlcChange });

  let notificationSeq = 0;
  // Último aviso fijo emitido: sólo ése puede recibir la reescritura de Spark.
  let lastNotificationId: string | null = null;
  // Reloj SIMULADO del técnico. Es un evento: se emite a los conectados y no
  // se repite a los que se conectan después. Cada envío queda en la evidencia
  // del frame (evaluation.wearable).
  function notifyWearable(n: WearableNotification, sent: WearableNotification[]) {
    broadcast('wearable.notify', n);
    sent.push(n);
    if (n.frameId) {
      // El aviso ya salió: si no se pudo anotar, no se des-envía.
      void store.amend(n.frameId, { wearable: sent.map(({ at, text, source, notificationId }) => ({ notificationId, at, text, source })) }).catch(() => {});
    }
  }

  // Después de decidido el pedido. Nada de esto toca al PLC: la decisión ya
  // la tomaron SAM + la regla de zona. Primero el aviso fijo al reloj del
  // técnico (si se lo vio en la zona); después, en segundo plano, Muse Spark
  // redacta la explicación para el operario y, si corresponde, el aviso.
  function afterDecision({ snapshot, evidence }: StartResult) {
    if (!evidence) return;
    const sent: WearableNotification[] = [];
    let notification: WearableNotification | null = null;
    // Sólo con una persona observada en la zona. Nunca en NO_RISK ni en
    // UNKNOWN (cámara caída, captura fallida, inferencia apagada…).
    if (snapshot.state === 'BLOCKED' && snapshot.reason === 'RISK_OBSERVED' && evidence.status === 'RISK_OBSERVED') {
      notification = {
        notificationId: `wn-${now().getTime()}-${notificationSeq++}`,
        at: now().toISOString(),
        recipient: 'technician',
        frameId: evidence.frame?.frameId ?? null,
        severity: 'warning',
        text: WEARABLE_TEMPLATE_TEXT,
        source: 'template',
        simulated: true,
      };
      lastNotificationId = notification.notificationId;
      notifyWearable(notification, sent);
    }
    const frameId = evidence.frame?.frameId;
    // Spark sólo cuando la decisión y lo que vio SAM coinciden: un bloqueo por
    // otro motivo (p. ej. STALE_RESULT sobre un frame NO_RISK) le haría decir
    // a Spark que se detectó una persona que SAM no vio. Ahí no se lo llama.
    const plcState =
      snapshot.state === 'BLOCKED' && snapshot.reason === 'RISK_OBSERVED' && evidence.status === 'RISK_OBSERVED'
        ? 'BLOCKED'
        : (snapshot.state === 'ENABLED' || snapshot.state === 'RUNNING') && evidence.status === 'NO_RISK_OBSERVED'
          ? 'ENABLED'
          : null;
    if (!deps.explainer || !frameId || !plcState) return;
    void (async () => {
      const advice = await gateway.explain(CAMERA_ID, frameId, plcState);
      if (!advice) return;
      // En la evidencia queda todo, aunque en vivo ya haya vencido o se oculte
      // por desacuerdo (la nota lo dice).
      const explanation = advice.ok && advice.text ? { model: advice.model, text: advice.text } : null;
      await store.amend(frameId, { spark: advice, sparkNote: disagreementNote(advice.samStatus, advice), explanation }).catch(() => {});
      // La explicación en vivo sigue la regla de frescura (si ya venció, sale
      // null); la de evidencia sale atada a su frame si sigue siendo el vigente.
      publishPerception(true);
      const alert = notification && sparkAlertText(advice);
      if (notification && alert) {
        const rewrite: WearableNotification = { ...notification, at: now().toISOString(), text: alert, source: 'muse-spark-1.3' };
        // Spark llega tarde: sólo reescribe si sigue siendo la misma situación
        // (último aviso, mismo frame vigente con la cámara conectada, PLC
        // todavía BLOCKED por esa autorización). Si no, queda sólo en la
        // evidencia como no enviado; no se presenta un aviso viejo como actual.
        const live = plc.snapshot();
        const current =
          notification.notificationId === lastNotificationId &&
          gateway.current(CAMERA_ID).frame?.frameId === frameId &&
          live.state === 'BLOCKED' &&
          live.authorizationId === snapshot.authorizationId;
        if (current) notifyWearable(rewrite, sent);
        else {
          const { notificationId, at, text, source } = rewrite;
          await store.amend(frameId, { wearableSuppressed: { notificationId, at, text, source, reason: 'situation changed before Muse Spark answered' } }).catch(() => {});
        }
      }
    })();
  }

  function protocolError(ws: WebSocket, msg: string, corr = 'server') {
    ws.send(message('protocol.error', { message: msg.slice(0, 500) }, corr));
  }

  async function handle(ws: WebSocket, raw: string) {
    let msg: ClientMessage;
    try {
      msg = parseClientMessage(JSON.parse(raw));
    } catch (err) {
      protocolError(ws, `invalid message: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    await requestContext.run(msg.correlationId, () => dispatch(ws, msg));
  }

  async function dispatch(ws: WebSocket, msg: ClientMessage) {
    switch (msg.type) {
      case 'camera.status': {
        if (msg.payload.cameraId !== CAMERA_ID) return protocolError(ws, 'unknown camera', msg.correlationId);
        gateway.setCameraConnected(CAMERA_ID, msg.payload.connected);
        const owned = cameraOwners.get(ws) ?? new Set();
        if (msg.payload.connected) owned.add(CAMERA_ID);
        else owned.delete(CAMERA_ID);
        cameraOwners.set(ws, owned);
        publishPerception(true);
        return;
      }
      case 'start.request': {
        if (msg.payload.machineId !== MACHINE_ID) return protocolError(ws, 'unknown machine', msg.correlationId);
        const result = await plc.requestStart(msg.payload.authorizationId);
        if (!result.accepted) {
          protocolError(ws, `start request rejected in state ${result.snapshot.state}`, msg.correlationId);
        }
        publishPerception(true);
        afterDecision(result);
        return;
      }
      case 'frame.capture': {
        if (!frames.receive(ws, msg.payload)) protocolError(ws, 'unexpected frame', msg.correlationId);
        return;
      }
      case 'frame.error': {
        if (!frames.fail(ws, msg.payload.frameRequestId, msg.payload.message)) {
          protocolError(ws, 'unexpected frame error', msg.correlationId);
        }
        return;
      }
      case 'stop.request': {
        if (msg.payload.machineId !== MACHINE_ID) return protocolError(ws, 'unknown machine', msg.correlationId);
        plc.stop();
        return;
      }
    }
  }

  // Entra un frame JPEG en base64 por mensaje.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 5 * 1024 * 1024 });
  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.send(message('plc.state', plc.snapshot(), 'server'));
    ws.send(message('perception.state', perceptionPayload(), 'server'));
    ws.on('message', (data) => void handle(ws, String(data)));
    ws.on('close', () => {
      clients.delete(ws);
      const owned = cameraOwners.get(ws);
      cameraOwners.delete(ws);
      frames.dropOwner(ws);
      if (owned?.size) {
        for (const cam of owned) gateway.setCameraConnected(cam, false);
        publishPerception(true);
      }
    });
  });

  const stalePoll = setInterval(() => publishPerception(), STALE_POLL_MS);
  stalePoll.unref();

  const servers: Server[] = config.hosts.map(() =>
    createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, metaApiEnabled: config.metaApiEnabled, adapter: gateway.adapterId }));
        return;
      }
      res.writeHead(404).end();
    }),
  );
  for (const srv of servers) {
    srv.on('upgrade', (req, socket, head) => {
      if (req.url !== '/ws') return socket.destroy();
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    });
  }

  const ports = await Promise.all(
    servers.map(
      (srv, i) =>
        new Promise<number>((resolve, reject) => {
          srv.once('error', reject);
          srv.listen(config.port, config.hosts[i], () => resolve((srv.address() as AddressInfo).port));
        }),
    ),
  );

  return {
    ports,
    async close() {
      clearInterval(stalePoll);
      for (const ws of clients) ws.terminate();
      wss.close();
      await Promise.all(servers.map((srv) => new Promise((r) => srv.close(r))));
    },
  };
}
