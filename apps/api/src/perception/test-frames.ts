import { createHash } from 'node:crypto';
import type { Frame, FrameSource } from './types.ts';

// Bytes sintéticos para tests: marcadores SOI/EOI de JPEG, no una imagen real.
export const FAKE_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);

let n = 0;
export function fakeFrame(cameraId = 'cam-01', receivedAt = new Date()): Frame {
  n++;
  return {
    frameId: `f-test-${n}`,
    cameraId,
    receivedAt,
    captureTs: receivedAt.toISOString(),
    width: 1280,
    height: 720,
    mime: 'image/jpeg',
    sceneRevision: 'hall-v1',
    sha256: createHash('sha256').update(FAKE_JPEG).digest('hex'),
    bytes: FAKE_JPEG,
    simTruth: { operatorInZone: false },
  };
}

export const fakeFrames = (now?: () => Date): FrameSource => ({
  capture: async (cameraId) => fakeFrame(cameraId, now?.() ?? new Date()),
});
