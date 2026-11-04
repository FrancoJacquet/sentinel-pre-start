import { z } from 'zod';
import { EVIDENCE_SOURCES, PERCEPTION_STATUSES } from './perception.ts';
import { PLC_BLOCK_REASONS, PLC_STATES } from './plc.ts';

export const PROTOCOL_VERSION = 1;

const envelope = {
  v: z.literal(PROTOCOL_VERSION),
  seq: z.number().int().nonnegative(),
  ts: z.iso.datetime(),
  correlationId: z.string().min(1),
};

const id = z.string().min(1).max(128);

// ── cliente → servidor ─────────────────────────────────────────────

export const StartRequest = z.object({
  ...envelope,
  type: z.literal('start.request'),
  requestId: id,
  payload: z.object({ machineId: id, authorizationId: id }),
});

export const StopRequest = z.object({
  ...envelope,
  type: z.literal('stop.request'),
  requestId: id,
  payload: z.object({ machineId: id }),
});

export const CameraStatus = z.object({
  ...envelope,
  type: z.literal('camera.status'),
  requestId: id,
  payload: z.object({ cameraId: id, connected: z.boolean() }),
});

// Tope del frame en base64 (~3 MB de JPEG). El servidor también lo limita.
export const MAX_FRAME_BASE64 = 4_000_000;

// La cámara virtual responde a un frame.request con píxeles renderizados.
// `simTruth` es la verdad del simulador para medir después: se guarda aparte
// y nunca llega al modelo.
export const FrameCapture = z.object({
  ...envelope,
  type: z.literal('frame.capture'),
  requestId: id,
  payload: z.object({
    cameraId: id,
    frameRequestId: id,
    frameId: id,
    captureTs: z.iso.datetime(),
    width: z.number().int().positive().max(4096),
    height: z.number().int().positive().max(4096),
    mime: z.literal('image/jpeg'),
    sceneRevision: id,
    dataBase64: z.string().min(4).max(MAX_FRAME_BASE64),
    simTruth: z.object({ operatorInZone: z.boolean() }),
  }),
});

export const FrameError = z.object({
  ...envelope,
  type: z.literal('frame.error'),
  requestId: id,
  payload: z.object({ cameraId: id, frameRequestId: id, message: z.string().max(500) }),
});

export const ClientMessage = z.discriminatedUnion('type', [
  StartRequest,
  StopRequest,
  CameraStatus,
  FrameCapture,
  FrameError,
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

// ── servidor → cliente ─────────────────────────────────────────────

// Lo que el modelo vio en el frame evaluado, en píxeles de ese frame: el
// polígono de la zona calibrada y cada persona con su caja, el punto de apoyo
// (centro del borde inferior) y si pisa la zona. Es salida REAL del modelo:
// null si no hubo modelo. Nunca se rellena con la verdad del simulador.
const pixel = z.number().int();
export const PerceptionOverlay = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  polygon: z.array(z.tuple([pixel, pixel])).max(16),
  persons: z
    .array(
      z.object({
        x1: z.number(),
        y1: z.number(),
        x2: z.number(),
        y2: z.number(),
        c: z.number().nullable(),
        foot: z.tuple([z.number(), z.number()]),
        inZone: z.boolean(),
      }),
    )
    .max(32),
});
export type PerceptionOverlay = z.infer<typeof PerceptionOverlay>;

// Explicación en lenguaje natural de Muse Spark sobre el mismo frame. Es
// texto REAL del modelo (nunca de la UI ni del simulador) y sólo comunica: la
// decisión es de SAM + la regla de zona, y Spark llega después de decidida.
// null si no hubo explicación o si la observación ya no es vigente (misma
// regla de frescura que el overlay).
export const SPARK_MODEL_ID = 'muse-spark-1.3' as const;
export const EXPLANATION_MAX_CHARS = 200;
export const PerceptionExplanation = z.object({
  model: z.literal(SPARK_MODEL_ID),
  text: z.string().min(1).max(EXPLANATION_MAX_CHARS),
});
export type PerceptionExplanation = z.infer<typeof PerceptionExplanation>;

// La explicación de Spark como EVIDENCIA de una decisión pasada, no como lectura
// en vivo: Spark llega después de decidido (y en la práctica con la observación
// ya vencida), así que se ata al frame evaluado y sigue después de vencer. Es
// null si ese frame no fue una observación del modelo, si Spark no explicó o
// los modelos no coinciden, apenas hay una evaluación nueva (aunque Spark
// todavía no haya contestado) y si se cae la cámara. Sólo vale junto al frame
// con ese mismo frameId; nunca se dibuja sobre otro.
export const EvidenceExplanation = PerceptionExplanation.extend({
  frameId: id,
  // Hora del servidor al llegar la respuesta de Spark.
  at: z.iso.datetime(),
});
export type EvidenceExplanation = z.infer<typeof EvidenceExplanation>;

const PlcReason = z.union([z.enum(PERCEPTION_STATUSES), z.enum(PLC_BLOCK_REASONS)]);

export const PlcStateMessage = z.object({
  ...envelope,
  type: z.literal('plc.state'),
  payload: z.object({
    machineId: id,
    state: z.enum(PLC_STATES),
    reason: PlcReason.nullable(),
    authorizationId: id.nullable(),
  }),
});

export const PerceptionStateMessage = z.object({
  ...envelope,
  type: z.literal('perception.state'),
  payload: z.object({
    cameraId: id,
    status: z.enum(PERCEPTION_STATUSES),
    source: z.enum(EVIDENCE_SOURCES),
    observedAt: z.iso.datetime().nullable(),
    freshnessTtlMs: z.number().int().positive(),
    detail: z.string().max(500).nullable(),
    // Frame sobre el que se evaluó; null si no hubo captura.
    frame: z
      .object({
        frameId: id,
        receivedAt: z.iso.datetime(),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
        width: z.number().int().positive(),
        height: z.number().int().positive(),
      })
      .nullable()
      .default(null),
    // Detecciones del modelo sobre ese frame; null si no hubo modelo o si la
    // evaluación ya no es vigente (no se dibuja una detección vieja).
    overlay: PerceptionOverlay.nullable().default(null),
    explanation: PerceptionExplanation.nullable().default(null),
    evidenceExplanation: EvidenceExplanation.nullable().default(null),
  }),
});

// El servidor le pide un frame a la cámara. El frameId lo pone el servidor.
export const FrameRequestMessage = z.object({
  ...envelope,
  type: z.literal('frame.request'),
  payload: z.object({
    cameraId: id,
    frameRequestId: id,
    frameId: id,
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
});

export const AlertMessage = z.object({
  ...envelope,
  type: z.literal('alert'),
  payload: z.object({
    level: z.enum(['info', 'warning', 'critical']),
    code: z.string().min(1),
    message: z.string().min(1).max(500),
  }),
});

// Wearable SIMULADO del técnico en la zona (reloj en la muñeca). Es un
// evento, no estado: sale una vez cuando un arranque termina BLOCKED con
// RISK_OBSERVED. Primero con texto fijo (`template`), así el aviso nunca espera
// a una IA; si Muse Spark después devuelve un aviso para el mismo frame, sale
// otra vez con el MISMO notificationId y el texto del modelo (la UI lo
// reemplaza). Sólo advertencias: nunca dice que es seguro ni que puede seguir.
export const WEARABLE_TEXT_MAX_CHARS = 140;
export const WEARABLE_SOURCES = ['template', SPARK_MODEL_ID] as const;
export type WearableSource = (typeof WEARABLE_SOURCES)[number];
export const WearableNotifyMessage = z.object({
  ...envelope,
  type: z.literal('wearable.notify'),
  payload: z.object({
    notificationId: id,
    at: z.iso.datetime(),
    recipient: z.literal('technician'),
    frameId: id.nullable(),
    severity: z.literal('warning'),
    text: z.string().min(1).max(WEARABLE_TEXT_MAX_CHARS),
    source: z.enum(WEARABLE_SOURCES),
    simulated: z.literal(true),
  }),
});

export const ProtocolError = z.object({
  ...envelope,
  type: z.literal('protocol.error'),
  payload: z.object({ message: z.string().max(500) }),
});

export const ServerMessage = z.discriminatedUnion('type', [
  PlcStateMessage,
  PerceptionStateMessage,
  AlertMessage,
  ProtocolError,
  FrameRequestMessage,
  WearableNotifyMessage,
]);
export type ServerMessage = z.infer<typeof ServerMessage>;

export type ServerPayload<T extends ServerMessage['type']> = Extract<ServerMessage, { type: T }>['payload'];
export type ClientPayload<T extends ClientMessage['type']> = Extract<ClientMessage, { type: T }>['payload'];

export function parseClientMessage(raw: unknown): ClientMessage {
  return ClientMessage.parse(raw);
}

export function parseServerMessage(raw: unknown): ServerMessage {
  return ServerMessage.parse(raw);
}
