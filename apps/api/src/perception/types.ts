import type { EvidenceExplanation, EvidenceSource, PerceptionExplanation, PerceptionOverlay, PerceptionStatus } from '@sentinel/contracts';

// Píxeles renderizados por la cámara virtual, tal como llegaron al servidor.
export interface Frame {
  frameId: string;
  cameraId: string;
  // Hora del servidor al recibirlo: es la que cuenta para la frescura (el
  // reloj del navegador puede estar corrido).
  receivedAt: Date;
  // Hora informada por el navegador; sólo metadato.
  captureTs: string;
  width: number;
  height: number;
  mime: 'image/jpeg';
  sceneRevision: string;
  sha256: string;
  bytes: Buffer;
  // Verdad del simulador. SIMULACIÓN: se guarda para medir, nunca va al modelo.
  simTruth: { operatorInZone: boolean };
}

export type FrameMeta = Pick<Frame, 'frameId' | 'receivedAt' | 'sha256' | 'width' | 'height'>;

// Lo que ve un adaptador: el frame sin la verdad del simulador.
export type ModelFrame = Omit<Frame, 'simTruth'>;

export interface FrameSource {
  capture(cameraId: string, signal: AbortSignal): Promise<Frame>;
}

export interface Evidence {
  cameraId: string;
  status: PerceptionStatus;
  source: EvidenceSource;
  // Momento de la observación del modelo; null si no hubo observación.
  observedAt: Date | null;
  detail: string | null;
  frame: FrameMeta | null;
  // Detecciones reales del modelo sobre `frame`; null si no hubo modelo o si
  // la evidencia no es una observación vigente.
  overlay: PerceptionOverlay | null;
  // Explicación de Muse Spark para la UI. Misma regla que el overlay: sólo con
  // una observación vigente del modelo; null si no hubo o venció. Llega
  // después de la decisión (Spark comunica, no decide).
  explanation?: PerceptionExplanation | null;
  // La misma explicación como evidencia de ESTE frame (no vence con la
  // observación). Se pierde con una evaluación nueva o al caerse la cámara;
  // null si no hubo o si los modelos no coinciden.
  evidenceExplanation?: EvidenceExplanation | null;
  // Registro completo de la consulta a Spark (salida cruda incluida) para el
  // evidence store; null si no se consultó.
  advice?: Advice | null;
  // Nota de desacuerdo entre Spark y SAM (ver advice-rule.ts). Sólo se
  // registra: no cambia el estado ni la decisión del PLC.
  sparkNote?: string | null;
}

// Resultado de consultar a un modelo explicador (Muse Spark). Sólo comunica:
// se consulta con la decisión ya tomada y, si falla, `ok` es false con el motivo.
export interface Advice {
  model: string;
  ok: boolean;
  // Estado de SAM sobre el que se consultó.
  samStatus: 'RISK_OBSERVED' | 'NO_RISK_OBSERVED';
  text: string | null;
  // Aviso corto para el reloj del técnico; null si no hubo o no correspondía.
  technicianAlert: string | null;
  personInZoneVisible: boolean | null;
  // Motivo del fallo; null si ok.
  reason: string | null;
  // Texto que se le mandó junto al JPEG (sólo el polígono de la zona).
  prompt: string;
  // Texto tal cual lo devolvió el modelo (null si no hubo respuesta).
  raw: string | null;
  // Solicitudes usadas del ledger de Spark (p. ej. "3/10"); null si no se reservó.
  request: string | null;
}

export type ExplainPlcState = 'BLOCKED' | 'ENABLED';

export interface ExplainInput {
  cameraId: string;
  frame: ModelFrame;
  samStatus: Advice['samStatus'];
  // Decisión del PLC ya tomada con ese frame (contexto para el texto).
  plcState: ExplainPlcState;
  // Lo que SAM vio en ese frame: cajas, pie, zona y el polígono calibrado.
  overlay: PerceptionOverlay;
  signal: AbortSignal;
}

export interface Explainer {
  readonly id: string;
  explain(input: ExplainInput): Promise<Advice>;
}

export interface AnalyzeInput {
  cameraId: string;
  frame: ModelFrame;
  signal: AbortSignal;
}

export interface AdapterResult {
  status: PerceptionStatus;
  source: EvidenceSource;
  detail: string | null;
  // Sólo un adaptador de modelo real lo llena, con lo que el modelo devolvió.
  overlay?: PerceptionOverlay | null;
}

export interface PerceptionAdapter {
  readonly id: string;
  analyze(input: AnalyzeInput): Promise<AdapterResult>;
}
