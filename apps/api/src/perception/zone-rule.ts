import type { PerceptionOverlay, PerceptionStatus } from '@sentinel/contracts';
import type { SamBox } from './meta/sam-output.ts';

export type Point = readonly [x: number, y: number];

// Zona dibujada sobre la imagen de una cámara fija, como se calibra una cámara
// real: vale para un tamaño de frame y una revisión de escena.
export interface ZoneCalibration {
  cameraId: string;
  sceneRevision: string;
  width: number;
  height: number;
  polygon: readonly Point[];
}

// CAM-01 en loto-v1 (antes crane-v1: la cámara y la ZONE no cambiaron, así
// que el polígono es el mismo y sólo cambia la revisión): las esquinas del piso de la zona (ZONE de la escena:
// x -2.0..2.6, z -0.5..2.5) proyectadas con la cámara fija (pos -4.7,5.8,-5.05
// → 0.45,1.35,0.9; fov vertical 0.76; 1280×720).
// Se recalcula si cambia la escena o la cámara (cambia sceneRevision).
export const CAM01_ZONE: ZoneCalibration = {
  cameraId: 'cam-01',
  sceneRevision: 'loto-v1',
  width: 1280,
  height: 720,
  polygon: [
    [526, 663],
    [869, 450],
    [684, 352],
    [361, 492],
  ],
};

export function pointInPolygon([x, y]: Point, polygon: readonly Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]!;
    const [xj, yj] = polygon[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export interface ZoneDecision {
  status: PerceptionStatus;
  detail: string;
  // Personas detectadas y cuáles pisan la zona (para la evidencia y la UI).
  people: { objectId: number; x1: number; y1: number; x2: number; y2: number; foot: Point; inZone: boolean; c: number | null }[];
}

// Tope de personas del contrato (perception.state.overlay).
export const OVERLAY_MAX_PERSONS = 32;

// Overlay para la UI con lo que el modelo vio, en píxeles del frame evaluado.
// Si hay más personas que el tope, primero van las que pisan la zona: nunca se
// recorta la que bloquea.
export function zoneOverlay(decision: ZoneDecision, zone: ZoneCalibration): PerceptionOverlay {
  const ordered = [...decision.people.filter((p) => p.inZone), ...decision.people.filter((p) => !p.inZone)];
  const kept = decision.people.length > OVERLAY_MAX_PERSONS ? ordered.slice(0, OVERLAY_MAX_PERSONS) : decision.people;
  return {
    width: zone.width,
    height: zone.height,
    polygon: zone.polygon.map(([x, y]) => [x, y] as [number, number]),
    persons: kept.map((p) => ({ x1: p.x1, y1: p.y1, x2: p.x2, y2: p.y2, c: p.c, foot: [p.foot[0], p.foot[1]], inZone: p.inZone })),
  };
}

// Regla determinista sobre lo que segmentó el modelo: una persona está en la
// zona si su punto de apoyo (centro del borde inferior de la caja) cae dentro
// del polígono. El modelo segmenta; esta regla decide. Sin personas detectadas
// es NO_RISK_OBSERVED: lo que el modelo vio, no una garantía de seguridad.
export function decideZone(boxes: SamBox[], zone: ZoneCalibration): ZoneDecision {
  for (const b of boxes) {
    if (b.w !== zone.width || b.h !== zone.height) {
      return { status: 'UNVERIFIED', detail: `box frame ${b.w}x${b.h} != calibration ${zone.width}x${zone.height}`, people: [] };
    }
  }
  const people = boxes.map((b) => {
    const foot: Point = [Math.round((b.x1 + b.x2) / 2), b.y2];
    return { objectId: b.objectId, x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2, foot, inZone: pointInPolygon(foot, zone.polygon), c: b.c };
  });
  const inZone = people.filter((p) => p.inZone);
  if (inZone.length > 0) {
    return { status: 'RISK_OBSERVED', detail: `${inZone.length} person(s) in zone of ${people.length} detected`, people };
  }
  return { status: 'NO_RISK_OBSERVED', detail: `no person in zone (${people.length} detected outside)`, people };
}
