import { createHash, randomBytes } from 'node:crypto';
import type { ClientPayload } from '@sentinel/contracts';
import type { Frame, FrameSource } from './types.ts';

export const FRAME_WIDTH = 1280;
export const FRAME_HEIGHT = 720;
const MAX_FRAME_BYTES = 3_000_000;

export interface FrameRequest {
  cameraId: string;
  frameRequestId: string;
  frameId: string;
  width: number;
  height: number;
}

interface Pending {
  request: FrameRequest;
  owner: unknown;
  resolve(frame: Frame): void;
  reject(err: Error): void;
}

// frameId ordenable por fecha de pedido (el evidence store poda por orden).
function newFrameId(now: Date): string {
  const ts = now.toISOString().replace(/[-:.]/g, '').slice(0, 18);
  return `f-${ts}-${randomBytes(3).toString('hex')}`;
}

function isJpeg(bytes: Buffer): boolean {
  return (
    bytes.length > 4 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff &&
    bytes[bytes.length - 2] === 0xff &&
    bytes[bytes.length - 1] === 0xd9
  );
}

// La cámara virtual vive en el navegador que la reportó. El servidor le pide
// un frame por WebSocket y espera los píxeles; nada se inventa acá.
export class RemoteCameraFrameSource implements FrameSource {
  readonly #send: (owner: unknown, request: FrameRequest) => void;
  readonly #ownerOf: (cameraId: string) => unknown;
  readonly #now: () => Date;
  readonly #pending = new Map<string, Pending>();

  constructor(opts: {
    send: (owner: unknown, request: FrameRequest) => void;
    ownerOf: (cameraId: string) => unknown;
    now?: () => Date;
  }) {
    this.#send = opts.send;
    this.#ownerOf = opts.ownerOf;
    this.#now = opts.now ?? (() => new Date());
  }

  capture(cameraId: string, signal: AbortSignal): Promise<Frame> {
    const owner = this.#ownerOf(cameraId);
    if (!owner) return Promise.reject(new Error('camera has no connected client'));
    const now = this.#now();
    const request: FrameRequest = {
      cameraId,
      frameRequestId: `fr-${randomBytes(6).toString('hex')}`,
      frameId: newFrameId(now),
      width: FRAME_WIDTH,
      height: FRAME_HEIGHT,
    };
    return new Promise<Frame>((resolve, reject) => {
      const done = () => this.#pending.delete(request.frameRequestId);
      this.#pending.set(request.frameRequestId, {
        request,
        owner,
        resolve: (f) => (done(), resolve(f)),
        reject: (e) => (done(), reject(e)),
      });
      signal.addEventListener('abort', () => this.#pending.get(request.frameRequestId)?.reject(new Error('aborted')));
      this.#send(owner, request);
    });
  }

  // Devuelve false si el frame no corresponde a ningún pedido de ese cliente.
  receive(owner: unknown, p: ClientPayload<'frame.capture'>): boolean {
    const pending = this.#pending.get(p.frameRequestId);
    if (!pending || pending.owner !== owner) return false;
    const { request } = pending;
    if (p.frameId !== request.frameId || p.cameraId !== request.cameraId) {
      pending.reject(new Error('frame does not match the request'));
      return true;
    }
    if (p.width !== request.width || p.height !== request.height) {
      pending.reject(new Error(`frame is ${p.width}x${p.height}, expected ${request.width}x${request.height}`));
      return true;
    }
    const bytes = Buffer.from(p.dataBase64, 'base64');
    if (bytes.length > MAX_FRAME_BYTES) {
      pending.reject(new Error(`frame too large: ${bytes.length} bytes`));
      return true;
    }
    if (!isJpeg(bytes)) {
      pending.reject(new Error('frame is not a JPEG'));
      return true;
    }
    pending.resolve({
      frameId: p.frameId,
      cameraId: p.cameraId,
      receivedAt: this.#now(),
      captureTs: p.captureTs,
      width: p.width,
      height: p.height,
      mime: p.mime,
      sceneRevision: p.sceneRevision,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes,
      simTruth: p.simTruth,
    });
    return true;
  }

  fail(owner: unknown, frameRequestId: string, message: string): boolean {
    const pending = this.#pending.get(frameRequestId);
    if (!pending || pending.owner !== owner) return false;
    pending.reject(new Error(`camera error: ${message}`));
    return true;
  }

  // Si se cae el cliente, sus pedidos fallan ya (no esperan el timeout).
  dropOwner(owner: unknown): void {
    for (const p of [...this.#pending.values()]) if (p.owner === owner) p.reject(new Error('camera client disconnected'));
  }
}
