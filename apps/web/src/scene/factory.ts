import '@babylonjs/loaders/glTF';
import {
  type AbstractMesh,
  StandardMaterial,
  type AnimationGroup,
  ArcRotateCamera,
  Color3,
  Color4,
  DefaultRenderingPipeline,
  DirectionalLight,
  DynamicTexture,
  Engine,
  GlowLayer,
  HDRCubeTexture,
  HemisphericLight,
  ImageProcessingConfiguration,
  LoadAssetContainerAsync,
  Mesh,
  MeshBuilder,
  PBRMaterial,
  Plane,
  PointLight,
  PointerDragBehavior,
  Scene,
  ShadowGenerator,
  Texture,
  TransformNode,
  UniversalCamera,
  Vector3,
  VertexData,
  Viewport,
} from '@babylonjs/core';

// Assets CC0 de terceros (ver docs/LICENCIAS-ASSETS.md). Se bajan con
// scripts/fetch-assets.mjs; si faltan, la escena falla a la vista.
const A = '/assets';

// Zona de trabajo bajo el puente grúa (metros, plano XZ): ahí está el técnico
// de mantenimiento con el gancho bajado. La cruza el paso peatonal.
export const ZONE = { minX: -2.0, maxX: 2.6, minZ: -0.5, maxZ: 2.5 } as const;
const HALL = { w: 20, d: 14, h: 8.6 };
// Puente grúa (Poly Haven, CC0) a escala 0,8: luz ≈ 9,8 m, riel a 6,9 m.
const CRANE_SCALE = 0.8;
const RUNWAY_TOP = 6.9;
const BRIDGE_Z = 1.0;
const RAIL_X = 6.122 * CRANE_SCALE;
const COLUMN_X = RAIL_X + 0.45;
const COLUMN_Z = [-5.6, -1.6, 2.4, 6.6];
// Mantenimiento (loto-v1): sin carga. En reposo el gancho está bajado cerca
// del piso, al lado del técnico; con RUNNING sube y el carro se traslada.
const HOOK_REST_X = 0.05;
// Altura del punto del gancho cuando está bajado para trabajar (m).
// A la cintura: más arriba, el motón quedaba a la altura de la cabeza del
// técnico en CAM-01 y le tapaba la silueta al modelo.
const HOOK_WORK_Y = 0.6;
// Recorrido del carro en marcha (dentro de la luz del puente).
const TROLLEY_FAR_X = 2.4;
const TROLLEY_NEAR_X = -2.2;
// La bobina, apoyada en su cuna dentro de la zona (no hay carga suspendida).
const COIL_DOWN_X = -1.15;
const WALKWAY = { minX: 0.1, maxX: 1.1 };
const RACK = { x0: 3.15, x1: 4.15, z0: -0.45, z1: 2.45 };
const CRADLE_TOP = 0.16;
const OPERATOR_OUTSIDE = new Vector3(HOOK_REST_X, 0, -2.9);
// El técnico, al lado del gancho bajado en el centro de la zona (lejos de la
// cinta en CAM-01). Corrido de costado y hacia la cámara para que en CAM-01 su
// silueta no se pise con el motón. Pies proyectados (pinhole, 1280×720):
// ≈ (680, 463), dentro de CAM01_ZONE.
const OPERATOR_IN_ZONE = new Vector3(0.85, 0, 0.7);
// Botonera colgante del puente (sin nadie: la grúa está en mantenimiento).
const PENDANT_POS = new Vector3(4.33, 1.12, 1.0);
// Seccionador general de PG-01: en la cara frontal de la columna derecha del
// medio, detrás de la estantería (desde ahí no se ve la zona).
const PANEL = { x: 5.35, y: 1.35, z: 2.4 - 0.17 - 0.13, w: 0.62, h: 0.82, d: 0.26 };
// El que va a devolver la energía, parado frente al tablero.
const PANEL_OPERATOR = new Vector3(4.98, 0, 1.45);
const OPERATOR_HEIGHT = 1.76;
// Reloj del técnico: diámetro de la correa (m) y giro alrededor del antebrazo
// para que la pantalla quede del lado del dorso de la muñeca.
const WATCH_BAND_D = 0.07;
const WATCH_TURN = 0;
const WALK_SPEED = 1.3;

// Bobina de acero (eje en X).
const COIL = { ro: 0.625, ri: 0.25, w: 0.9 };
// Cuánto se hunde la bobina entre los dos tirantes de la cuna (separados 0,6 m).
const COIL_SAG = COIL.ro - Math.sqrt(COIL.ro ** 2 - 0.3 ** 2);

// Vista de la cámara virtual dentro del canvas (coordenadas de viewport de
// Babylon: origen abajo a la izquierda). El overlay HTML usa los mismos números.
// Más chica que en crane-v1: no tapa la columna del seccionador en la vista general.
export const CAMERA_VIEWPORT = { x: 0.725, y: 0.69, w: 0.26, h: 0.28 } as const;

export function isInsideZone(x: number, z: number): boolean {
  return x >= ZONE.minX && x <= ZONE.maxX && z >= ZONE.minZ && z <= ZONE.maxZ;
}

export type StackLight = 'red' | 'amber' | 'green' | 'off';

// Identifica la versión de la escena (layout y assets), no su contenido: no
// dice dónde está el operario.
export const SCENE_REVISION = 'loto-v1';

export interface CapturedFrame {
  jpegBase64: string;
  width: number;
  height: number;
  operatorInZone: boolean;
}

export interface FactoryScene {
  moveOperator(where: 'zone' | 'outside'): void;
  setStackLight(light: StackLight): void;
  // Estado simulado de la máquina que comanda el PLC virtual (RUNNING ⇒ se mueve).
  setMachineRunning(running: boolean): void;
  // Toma de la cámara principal (para el video). No toca CAM-01.
  setView(view: ViewPreset): void;
  // Sin cámara no hay imagen: la vista de CAM-01 deja de renderizarse.
  setCameraFeed(on: boolean): void;
  // Píxeles de CAM-01 tal como los renderiza el motor (sin overlays HTML).
  captureFrame(width: number, height: number): CapturedFrame;
  // Reloj SIMULADO en la muñeca izquierda del técnico: id nuevo ⇒ vibra y se
  // prende ámbar; mismo id ⇒ sólo cambia el texto del rótulo.
  notifyWatch(notice: WatchNotice): void;
  // Pantalla en reposo (nuevo ENERGIZE o el técnico salió de la zona).
  clearWatch(): void;
  dispose(): void;
}

export interface WatchNotice {
  id: string;
  text: string;
  // Rótulo legible de la fuente ("fixed warning", "Muse Spark 1.3").
  sourceLabel: string;
}

// `low` existe para el e2e en navegador sin GPU (SwiftShader): mismo
// comportamiento, sin glow ni MSAA. La demo y las capturas van en `high`.
export type Quality = 'high' | 'low';

export interface FactoryHooks {
  onTruthChange(insideZone: boolean): void;
  onReady(): void;
  onError(message: string): void;
}

function pbrSurface(scene: Scene, name: string, base: string, res: '1k' | '2k', repeat: [number, number]) {
  const m = new PBRMaterial(name, scene);
  const tex = (suffix: string) => {
    const t = new Texture(`${A}/textures/${base}_${suffix}_${res}.jpg`, scene);
    t.uScale = repeat[0];
    t.vScale = repeat[1];
    return t;
  };
  m.albedoTexture = tex('diff');
  m.bumpTexture = tex('nor_gl');
  // ARM: R = oclusión, G = rugosidad, B = metal.
  m.metallicTexture = tex('arm');
  m.useAmbientOcclusionFromMetallicTextureRed = true;
  m.useRoughnessFromMetallicTextureGreen = true;
  m.useMetallnessFromMetallicTextureBlue = true;
  m.metallic = 1;
  m.roughness = 1;
  return m;
}

function paint(scene: Scene, name: string, hex: string, roughness: number, metallic = 0.2) {
  const m = new PBRMaterial(name, scene);
  m.albedoColor = Color3.FromHexString(hex).toLinearSpace();
  m.roughness = roughness;
  m.metallic = metallic;
  return m;
}

// Cinta de demarcación amarilla y negra, como la que se pega en el piso.
// Una textura por tramo: el clone() de un DynamicTexture nunca queda listo y
// deja la escena entera sin declararse lista.
function hazardTape(scene: Scene, name: string, repeat: number) {
  const tex = new DynamicTexture(name, { width: 256, height: 32 }, scene, true);
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  ctx.fillStyle = '#e8b40c';
  ctx.fillRect(0, 0, 256, 32);
  ctx.fillStyle = '#151515';
  for (let x = -32; x < 288; x += 32) {
    ctx.beginPath();
    ctx.moveTo(x, 32);
    ctx.lineTo(x + 16, 32);
    ctx.lineTo(x + 32, 0);
    ctx.lineTo(x + 16, 0);
    ctx.fill();
  }
  tex.update();
  tex.wrapU = Texture.WRAP_ADDRESSMODE;
  tex.uScale = repeat;
  const m = new PBRMaterial(`${name}-m`, scene);
  m.albedoTexture = tex;
  m.roughness = 0.55;
  m.metallic = 0;
  return m;
}

// Textura dibujada en runtime (carteles, pintura de piso, caras de la bobina).
function drawn(scene: Scene, name: string, w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void, alpha = false) {
  const tex = new DynamicTexture(name, { width: w, height: h }, scene, true);
  tex.hasAlpha = alpha;
  draw(tex.getContext() as CanvasRenderingContext2D);
  tex.update();
  return tex;
}

// Cartel de seguridad: triángulo amarillo (carga suspendida o alta tensión) y leyenda.
function signMaterial(scene: Scene, name: string, lines: string[], icon: 'load' | 'bolt' = 'load') {
  const tex = drawn(scene, name, 512, 640, (ctx) => {
    ctx.fillStyle = '#f2f0ea';
    ctx.fillRect(0, 0, 512, 640);
    ctx.fillStyle = '#f2c200';
    ctx.strokeStyle = '#111';
    ctx.lineWidth = 22;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(256, 40);
    ctx.lineTo(470, 400);
    ctx.lineTo(42, 400);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#111';
    if (icon === 'load') {
      // Pictograma: gancho, eslingas y bulto colgando.
      ctx.fillRect(250, 150, 12, 70);
      ctx.lineWidth = 9;
      ctx.beginPath();
      ctx.moveTo(256, 220);
      ctx.lineTo(205, 270);
      ctx.moveTo(256, 220);
      ctx.lineTo(307, 270);
      ctx.stroke();
      ctx.fillRect(190, 270, 132, 90);
    } else {
      // Pictograma: rayo.
      ctx.beginPath();
      ctx.moveTo(282, 130);
      ctx.lineTo(206, 272);
      ctx.lineTo(254, 272);
      ctx.lineTo(226, 375);
      ctx.lineTo(310, 236);
      ctx.lineTo(262, 236);
      ctx.closePath();
      ctx.fill();
    }
    ctx.textAlign = 'center';
    ctx.font = 'bold 64px Arial, sans-serif';
    ctx.fillText(lines[0]!, 256, 490);
    ctx.font = 'bold 40px Arial, sans-serif';
    lines.slice(1).forEach((l, i) => ctx.fillText(l, 256, 545 + i * 46));
  });
  const m = new PBRMaterial(`${name}-m`, scene);
  m.albedoTexture = tex;
  m.roughness = 0.6;
  m.metallic = 0;
  return m;
}

// Anillo plano (cara de la bobina) en el plano XY, mirando a -Z.
function annulus(scene: Scene, name: string, ri: number, ro: number, n: number) {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    const c = Math.cos(a);
    const s = Math.sin(a);
    for (const r of [ri, ro]) {
      positions.push(r * c, r * s, 0);
      normals.push(0, 0, -1);
      uvs.push(0.5 + (r * c) / (2 * ro), 0.5 + (r * s) / (2 * ro));
    }
    if (i < n) {
      const k = i * 2;
      indices.push(k, k + 1, k + 3, k, k + 3, k + 2);
    }
  }
  const mesh = new Mesh(name, scene);
  const vd = new VertexData();
  vd.positions = positions;
  vd.normals = normals;
  vd.uvs = uvs;
  vd.indices = indices;
  vd.applyToMesh(mesh);
  return mesh;
}

async function loadModel(scene: Scene, path: string, name: string) {
  const container = await LoadAssetContainerAsync(`${A}/models/${path}`, scene);
  container.addAllToScene();
  const holder = new TransformNode(name, scene);
  const root = container.meshes[0]!;
  root.parent = holder;
  return {
    holder,
    meshes: container.meshes,
    animations: container.animationGroups,
    materials: container.materials,
    nodes: container.transformNodes,
  };
}

// Antebrazo y muñeca izquierdos del rig, sin distinguir mayúsculas
// (Quaternius: LowerArm.L → Wrist.L; Mixamo: mixamorig:LeftForeArm →
// mixamorig:LeftHand). En glTF cada hueso lo mueve su TransformNode (las
// animaciones apuntan a esos nodos), así que colgarse del nodo sigue al hueso.
function leftWristNodes(nodes: TransformNode[]) {
  const left = (n: string) => /left|[._ -]l([._ -]|$)/i.test(n);
  const find = (re: RegExp) => nodes.find((t) => re.test(t.name) && left(t.name)) ?? null;
  return { forearm: find(/lower_?arm|fore_?arm/i), wrist: find(/wrist|hand/i) };
}

// Corta un texto en renglones de hasta `max` caracteres, por palabras.
function wrapText(text: string, max: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const w of text.split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + w.length > max) {
      lines.push(line);
      line = w;
    } else {
      line = line ? `${line} ${w}` : w;
    }
  }
  if (line) lines.push(line);
  return lines;
}

const smooth = (u: number) => u * u * (3 - 2 * u);

// Capas de render: la nave la ven las dos cámaras; los rótulos del relato,
// sólo la principal (meshes y cámaras nacen con 0x0FFFFFFF).
const SCENE_LAYER = 0x0fffffff;
const NARRATIVE_LAYER = 0x10000000;

// Tomas de la cámara principal para el video (teclas 1/2/3 o ?view=).
export type ViewPreset = 'overview' | 'disconnect' | 'technician';
const VIEWS: Record<ViewPreset, { alpha: number; beta: number; radius: number; target: Vector3 }> = {
  overview: { alpha: -1.5, beta: 1.12, radius: 16.5, target: new Vector3(0.8, 1.5, 0.8) },
  // Primer plano del seccionador y del que va a energizar, desde el pasillo
  // entre la estantería y la columna.
  disconnect: { alpha: -1.74, beta: 1.22, radius: 4.2, target: new Vector3(5.1, 1.35, 1.85) },
  technician: { alpha: -1.95, beta: 1.2, radius: 6, target: new Vector3(0.5, 1.0, 0.9) },
};

export function createFactoryScene(
  canvas: HTMLCanvasElement,
  hooks: FactoryHooks,
  quality: Quality = 'high',
): FactoryScene {
  const high = quality === 'high';
  const engine = new Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true });
  // Nitidez en pantallas @2x sin pasarse de 2 (costo de GPU).
  engine.setHardwareScalingLevel(1 / Math.min(window.devicePixelRatio || 1, 2));
  const scene = new Scene(engine);
  scene.clearColor = Color4.FromHexString('#2b2f33ff');

  const ip = scene.imageProcessingConfiguration;
  ip.toneMappingEnabled = true;
  ip.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
  ip.exposure = 1.05;
  ip.contrast = 1.15;

  // Iluminación basada en imagen: HDRI de un taller real (Poly Haven, CC0).
  const env = new HDRCubeTexture(`${A}/hdri/machine_shop_02_1k.hdr`, scene, 256, false, true, false, true);
  scene.environmentTexture = env;
  scene.environmentIntensity = 0.7;

  // Cámaras: la principal (orbitable) y la cámara virtual fija CAM-01.
  const main = new ArcRotateCamera('main', -1.5, 1.12, 16.5, new Vector3(0.8, 1.5, 0.8), scene);
  main.lowerRadiusLimit = 2.5;
  main.upperRadiusLimit = 26;
  main.upperBetaLimit = Math.PI / 2.1;
  main.minZ = 0.1;
  main.maxZ = 120;
  main.wheelDeltaPercentage = 0.01;
  main.attachControl(canvas, true);
  main.viewport = new Viewport(0, 0, 1, 1);
  main.layerMask = SCENE_LAYER | NARRATIVE_LAYER;

  // CAM-01: cámara de seguridad alta en la columna delantera izquierda, del
  // lado opuesto a la botonera: ve la zona de caída que el gruista no ve.
  const cam01Pos = new Vector3(-4.7, 5.8, -5.05);
  const cam01Target = new Vector3(0.45, 1.35, 0.9);
  const cam01 = new UniversalCamera('cam-01', cam01Pos, scene);
  cam01.setTarget(cam01Target);
  cam01.fov = 0.76;
  cam01.minZ = 0.1;
  cam01.maxZ = 120;
  cam01.viewport = new Viewport(CAMERA_VIEWPORT.x, CAMERA_VIEWPORT.y, CAMERA_VIEWPORT.w, CAMERA_VIEWPORT.h);
  // CAM-01 no ve la capa de rótulos (NARRATIVE_LAYER): el modelo recibe sólo
  // la nave, sin textos ni líneas que lo ayuden o lo confundan.
  cam01.layerMask = SCENE_LAYER;
  scene.activeCameras = [main, cam01];

  // Luz: cenital por lucernarios + relleno suave + lámparas colgantes.
  const hemi = new HemisphericLight('fill', new Vector3(0, 1, 0), scene);
  hemi.intensity = 0.15;
  hemi.groundColor = Color3.FromHexString('#3a3f44');
  const sun = new DirectionalLight('skylight', new Vector3(-0.15, -1, 0.2), scene);
  sun.position = new Vector3(6, 16, -8);
  sun.intensity = 2.6;
  sun.diffuse = Color3.FromHexString('#fff3e2');
  const shadows = new ShadowGenerator(high ? 2048 : 1024, sun);
  shadows.usePercentageCloserFiltering = true;
  shadows.filteringQuality = ShadowGenerator.QUALITY_MEDIUM;
  shadows.bias = 0.0008;
  shadows.normalBias = 0.02;
  const cast = (meshes: AbstractMesh[]) => meshes.forEach((m) => shadows.addShadowCaster(m, false));
  const solid = (meshes: Mesh[], mat: PBRMaterial) => {
    for (const m of meshes) {
      m.material = mat;
      m.receiveShadows = true;
    }
    cast(meshes);
  };
  const box = (name: string, w: number, h: number, d: number, pos: Vector3) => {
    const b = MeshBuilder.CreateBox(name, { width: w, height: h, depth: d }, scene);
    b.position.copyFrom(pos);
    return b;
  };

  // ── Nave ────────────────────────────────────────────────────────
  const floor = MeshBuilder.CreateGround('floor', { width: HALL.w, height: HALL.d }, scene);
  floor.material = pbrSurface(scene, 'm-floor', 'concrete_floor_worn_001', '2k', [HALL.w / 3, HALL.d / 3]);
  floor.receiveShadows = true;

  const plinthMat = pbrSurface(scene, 'm-plinth', 'factory_wall', '1k', [HALL.w / 4, 0.4]);
  const sheetMat = pbrSurface(scene, 'm-sheet', 'corrugated_iron', '1k', [HALL.w / 2.5, 2.6]);
  const plinthSideMat = pbrSurface(scene, 'm-plinth-side', 'factory_wall', '1k', [HALL.d / 4, 0.4]);
  const sheetSideMat = pbrSurface(scene, 'm-sheet-side', 'corrugated_iron', '1k', [HALL.d / 2.5, 2.6]);
  const plinthH = 1.4;
  const wall = (name: string, w: number, pos: Vector3, rotY: number, side: boolean) => {
    const low = MeshBuilder.CreatePlane(`${name}-low`, { width: w, height: plinthH }, scene);
    low.position = pos.add(new Vector3(0, plinthH / 2, 0));
    low.rotation.y = rotY;
    low.material = side ? plinthSideMat : plinthMat;
    low.receiveShadows = true;
    const high = MeshBuilder.CreatePlane(`${name}-high`, { width: w, height: HALL.h - plinthH }, scene);
    high.position = pos.add(new Vector3(0, plinthH + (HALL.h - plinthH) / 2, 0));
    high.rotation.y = rotY;
    high.material = side ? sheetSideMat : sheetMat;
    high.receiveShadows = true;
  };
  wall('wall-back', HALL.w, new Vector3(0, 0, HALL.d / 2), 0, false);
  wall('wall-left', HALL.d, new Vector3(-HALL.w / 2, 0, 0), -Math.PI / 2, true);
  wall('wall-right', HALL.d, new Vector3(HALL.w / 2, 0, 0), Math.PI / 2, true);

  // Estructura: columnas con ménsula y viga carril del puente grúa a cada lado.
  const steelPaint = paint(scene, 'm-structure', '#5d6b73', 0.55, 0.6);
  const runwayPaint = paint(scene, 'm-runway', '#c9a227', 0.5, 0.5);
  const railSteel = paint(scene, 'm-rail', '#6f7378', 0.35, 0.9);
  const beamH = 0.58;
  for (const side of [-1, 1]) {
    for (const z of COLUMN_Z) {
      const col = box(`col-${side}-${z}`, 0.34, HALL.h, 0.34, new Vector3(side * COLUMN_X, HALL.h / 2, z));
      const corbel = box(`corbel-${side}-${z}`, 0.62, 0.32, 0.3, new Vector3(side * (RAIL_X + 0.12), RUNWAY_TOP - beamH - 0.16, z));
      solid([col, corbel], steelPaint);
    }
    // Viga carril en I (alas + alma) y riel encima, todo el largo de la nave.
    const x = side * RAIL_X;
    const len = HALL.d;
    const web = box(`runway-web-${side}`, 0.03, beamH - 0.06, len, new Vector3(x, RUNWAY_TOP - beamH / 2, 0));
    const fTop = box(`runway-top-${side}`, 0.3, 0.03, len, new Vector3(x, RUNWAY_TOP - 0.065, 0));
    const fBot = box(`runway-bot-${side}`, 0.3, 0.03, len, new Vector3(x, RUNWAY_TOP - beamH + 0.015, 0));
    solid([web, fTop, fBot], runwayPaint);
    const rail = box(`rail-${side}`, 0.07, 0.05, len, new Vector3(x, RUNWAY_TOP - 0.025, 0));
    solid([rail], railSteel);
    // Viga de techo entre columnas.
    const eave = box(`eave-${side}`, 0.22, 0.4, len, new Vector3(side * COLUMN_X, HALL.h - 0.2, 0));
    solid([eave], steelPaint);
  }
  for (const z of COLUMN_Z) {
    const truss = box(`truss-${z}`, 2 * COLUMN_X, 0.36, 0.18, new Vector3(0, HALL.h - 0.18, z));
    solid([truss], steelPaint);
  }

  // ── Demarcación de piso ─────────────────────────────────────────
  const strip = (name: string, from: Vector3, to: Vector3, width: number) => {
    const len = Vector3.Distance(from, to);
    const s = MeshBuilder.CreateGround(name, { width: len, height: width }, scene);
    s.position = Vector3.Center(from, to).add(new Vector3(0, 0.006, 0));
    s.rotation.y = -Math.atan2(to.z - from.z, to.x - from.x);
    s.material = hazardTape(scene, name, len / 0.5);
    s.receiveShadows = true;
    return s;
  };
  const z0 = new Vector3(ZONE.minX, 0, ZONE.minZ);
  const z1 = new Vector3(ZONE.maxX, 0, ZONE.minZ);
  const z2 = new Vector3(ZONE.maxX, 0, ZONE.maxZ);
  const z3 = new Vector3(ZONE.minX, 0, ZONE.maxZ);
  [
    [z0, z1],
    [z1, z2],
    [z2, z3],
    [z3, z0],
  ].forEach(([a, b], i) => strip(`zone-${i}`, a!, b!, 0.12));

  // Pasillo de autoelevadores (líneas amarillas) a lo ancho de la nave.
  const aisleMat = paint(scene, 'm-aisle', '#d9a90f', 0.6, 0);
  for (const z of [-1.3, -4.7]) {
    const line = MeshBuilder.CreateGround(`aisle-${z}`, { width: HALL.w - 1, height: 0.1 }, scene);
    line.position.set(0, 0.003, z);
    line.material = aisleMat;
    line.receiveShadows = true;
  }
  // Paso peatonal (verde, bordes blancos) que cruza la zona de izaje hacia la
  // puerta del fondo: por eso el compañero pasa por ahí.
  const walkLen = HALL.d - 0.2;
  const walkCx = (WALKWAY.minX + WALKWAY.maxX) / 2;
  const walk = MeshBuilder.CreateGround('walkway', { width: WALKWAY.maxX - WALKWAY.minX, height: walkLen }, scene);
  walk.position.set(walkCx, 0.002, 0);
  walk.material = paint(scene, 'm-walkway', '#2f7a4c', 0.75, 0);
  walk.receiveShadows = true;
  const whiteLine = paint(scene, 'm-white-line', '#e9e9e4', 0.6, 0);
  for (const x of [WALKWAY.minX, WALKWAY.maxX]) {
    const l = MeshBuilder.CreateGround(`walk-edge-${x}`, { width: 0.09, height: walkLen }, scene);
    l.position.set(x, 0.004, 0);
    l.material = whiteLine;
    l.receiveShadows = true;
  }
  const stencilMat = new PBRMaterial('m-stencil', scene);
  stencilMat.albedoTexture = drawn(
    scene,
    'stencil-peatones',
    256,
    512,
    (ctx) => {
      ctx.clearRect(0, 0, 256, 512);
      ctx.fillStyle = '#efefe9';
      ctx.strokeStyle = '#efefe9';
      // Silueta de peatón y leyenda, pintadas en el piso.
      ctx.beginPath();
      ctx.arc(128, 70, 28, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 26;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(128, 115);
      ctx.lineTo(120, 215);
      ctx.lineTo(80, 300);
      ctx.moveTo(120, 215);
      ctx.lineTo(165, 295);
      ctx.moveTo(126, 140);
      ctx.lineTo(80, 200);
      ctx.moveTo(126, 140);
      ctx.lineTo(178, 190);
      ctx.stroke();
      ctx.font = 'bold 46px Arial, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('WALKWAY', 128, 430);
    },
    true,
  );
  stencilMat.useAlphaFromAlbedoTexture = true;
  stencilMat.transparencyMode = PBRMaterial.MATERIAL_ALPHATEST;
  stencilMat.roughness = 0.6;
  stencilMat.metallic = 0;
  for (const z of [-3.1, 4.6]) {
    const s = MeshBuilder.CreateGround(`walk-stencil-${z}`, { width: 0.7, height: 1.4 }, scene);
    s.position.set(walkCx, 0.005, z);
    s.rotation.y = Math.PI;
    s.material = stencilMat;
    s.receiveShadows = true;
  }

  // ── Bobinas de acero: la que se bajó antes del mantenimiento y dos en acopio ──
  const coilSteel = paint(scene, 'm-coil', '#a3a8ad', 0.3, 0.95);
  const coilFace = new PBRMaterial('m-coil-face', scene);
  coilFace.albedoTexture = drawn(scene, 'coil-face', 512, 512, (ctx) => {
    ctx.fillStyle = '#7d8389';
    ctx.fillRect(0, 0, 512, 512);
    // Vueltas de chapa: anillos concéntricos de tono apenas distinto.
    const ri = (COIL.ri / COIL.ro) * 256;
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let r = ri; r < 256; r += 1.6) {
      const g = 105 + Math.floor(rnd() * 50);
      ctx.strokeStyle = `rgb(${g},${g + 4},${g + 9})`;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.arc(256, 256, r, 0, Math.PI * 2);
      ctx.stroke();
    }
  });
  coilFace.backFaceCulling = false;
  coilFace.twoSidedLighting = true;
  coilFace.metallic = 0.85;
  coilFace.roughness = 0.38;
  const strapPaint = paint(scene, 'm-strap', '#2c4f7c', 0.45, 0.7);
  const woodMat = paint(scene, 'm-wood', '#7a5634', 0.85, 0);
  const coilMeshes: Mesh[] = [];
  function buildCoil(name: string) {
    const node = new TransformNode(name, scene);
    const outer = MeshBuilder.CreateCylinder(`${name}-outer`, { diameter: 2 * COIL.ro, height: COIL.w, tessellation: 48, cap: Mesh.NO_CAP }, scene);
    const inner = MeshBuilder.CreateCylinder(
      `${name}-inner`,
      { diameter: 2 * COIL.ri, height: COIL.w, tessellation: 32, cap: Mesh.NO_CAP, sideOrientation: Mesh.BACKSIDE },
      scene,
    );
    for (const c of [outer, inner]) {
      c.rotation.z = Math.PI / 2;
      c.material = coilSteel;
      c.parent = node;
      coilMeshes.push(c);
    }
    for (const side of [-1, 1]) {
      const face = annulus(scene, `${name}-face-${side}`, COIL.ri, COIL.ro, 48);
      face.rotation.y = -side * (Math.PI / 2);
      face.position.x = (side * COIL.w) / 2;
      face.material = coilFace;
      face.parent = node;
      coilMeshes.push(face);
    }
    // Zunchos: tres pasan por el ojo, dos rodean la bobina.
    for (let k = 0; k < 3; k++) {
      const strap = new TransformNode(`${name}-strap-${k}`, scene);
      strap.rotation.x = 0.5 + (k * 2 * Math.PI) / 3;
      strap.parent = node;
      const mid = (COIL.ro + COIL.ri) / 2;
      const parts = [
        box(`${name}-st-o`, COIL.w + 0.01, 0.006, 0.035, new Vector3(0, COIL.ro + 0.003, 0)),
        box(`${name}-st-i`, COIL.w + 0.01, 0.006, 0.035, new Vector3(0, COIL.ri - 0.003, 0)),
        box(`${name}-st-a`, 0.006, COIL.ro - COIL.ri, 0.035, new Vector3(COIL.w / 2 + 0.004, mid, 0)),
        box(`${name}-st-b`, 0.006, COIL.ro - COIL.ri, 0.035, new Vector3(-COIL.w / 2 - 0.004, mid, 0)),
      ];
      for (const p of parts) {
        p.material = strapPaint;
        p.parent = strap;
      }
      coilMeshes.push(...parts);
    }
    for (const x of [-0.25, 0.25]) {
      const band = MeshBuilder.CreateTorus(`${name}-band`, { diameter: 2 * COIL.ro + 0.004, thickness: 0.01, tessellation: 48 }, scene);
      band.rotation.z = Math.PI / 2;
      band.position.x = x;
      band.material = strapPaint;
      band.parent = node;
      coilMeshes.push(band);
    }
    return node;
  }
  // Cuna: dos tirantes de madera paralelos al eje; la bobina apoya entre ambos.
  function buildCradle(name: string, x: number, z: number) {
    const parts = [-0.3, 0.3].map((dz) => box(`${name}-${dz}`, 1.15, CRADLE_TOP, 0.16, new Vector3(x, CRADLE_TOP / 2, z + dz)));
    solid(parts, woodMat);
  }
  for (const [i, z] of [-0.1, 2.0].entries()) {
    buildCradle(`cradle-store-${i}`, -4.0, z);
    buildCoil(`coil-store-${i}`).position.set(-4.0, CRADLE_TOP - COIL_SAG + COIL.ro, z);
  }

  // En mantenimiento no hay carga suspendida: la bobina quedó apoyada en su
  // cuna, dentro de la zona, y el gancho libre.
  buildCradle('cradle-drop', COIL_DOWN_X, BRIDGE_Z);
  buildCoil('coil-down').position.set(COIL_DOWN_X, CRADLE_TOP - COIL_SAG + COIL.ro, BRIDGE_Z);
  coilMeshes.forEach((m) => (m.receiveShadows = true));
  cast(coilMeshes);

  // Luz de zona roja del polipasto ("halo light"): proyecta en el piso un
  // anillo bajo el gancho y viaja con el carro. Es del polipasto: sólo se
  // prende con energía (RUNNING). Marca el gancho, no al técnico.
  const haloMat = new PBRMaterial('m-halo', scene);
  const haloTex = drawn(
    scene,
    'halo',
    256,
    256,
    (ctx) => {
      ctx.clearRect(0, 0, 256, 256);
      const g = ctx.createRadialGradient(128, 128, 96, 128, 128, 126);
      g.addColorStop(0, 'rgba(255,40,30,0)');
      g.addColorStop(0.35, 'rgba(255,40,30,0.95)');
      g.addColorStop(0.65, 'rgba(255,40,30,0.95)');
      g.addColorStop(1, 'rgba(255,40,30,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(128, 128, 127, 0, Math.PI * 2);
      ctx.fill();
      // Relleno tenue: el área donde caería la carga.
      ctx.fillStyle = 'rgba(255,40,30,0.13)';
      ctx.beginPath();
      ctx.arc(128, 128, 100, 0, Math.PI * 2);
      ctx.fill();
    },
    true,
  );
  haloMat.albedoTexture = haloTex;
  haloMat.emissiveTexture = haloTex;
  haloMat.emissiveColor = new Color3(1, 1, 1);
  haloMat.useAlphaFromAlbedoTexture = true;
  haloMat.transparencyMode = PBRMaterial.MATERIAL_ALPHABLEND;
  haloMat.metallic = 0;
  haloMat.roughness = 1;
  haloMat.disableLighting = true;
  const halo = MeshBuilder.CreateGround('halo', { width: 2.1, height: 2.1 }, scene);
  halo.material = haloMat;
  halo.isPickable = false;
  halo.position.set(HOOK_REST_X, 0.009, BRIDGE_Z);
  halo.setEnabled(false);

  // ── Estantería de pallets: el obstáculo que tapa la vista ───────
  const uprightMat = paint(scene, 'm-upright', '#1f4e8c', 0.5, 0.5);
  const rackBeamMat = paint(scene, 'm-rack-beam', '#e06a1a', 0.5, 0.4);
  const rackH = 3.3;
  const rackLevels = [0, 1.42, 2.75];
  const uprights: Mesh[] = [];
  for (const x of [RACK.x0, RACK.x1]) {
    for (const z of [RACK.z0, RACK.z1]) uprights.push(box('rack-up', 0.09, rackH, 0.08, new Vector3(x, rackH / 2, z)));
  }
  solid(uprights, uprightMat);
  const beams: Mesh[] = [];
  for (const y of rackLevels.slice(1)) {
    for (const x of [RACK.x0, RACK.x1]) beams.push(box('rack-beam', 0.05, 0.12, RACK.z1 - RACK.z0, new Vector3(x, y - 0.06, (RACK.z0 + RACK.z1) / 2)));
  }
  solid(beams, rackBeamMat);
  // Cajas de cartón con cinta y etiqueta.
  const cardboard = new PBRMaterial('m-cardboard', scene);
  cardboard.albedoTexture = drawn(scene, 'cardboard', 256, 256, (ctx) => {
    ctx.fillStyle = '#a67c4e';
    ctx.fillRect(0, 0, 256, 256);
    ctx.fillStyle = 'rgba(70,45,20,0.12)';
    for (let y = 0; y < 256; y += 6) ctx.fillRect(0, y, 256, 2);
    ctx.fillStyle = '#c9a676';
    ctx.fillRect(112, 0, 32, 256);
    ctx.fillStyle = '#f1efe8';
    ctx.fillRect(28, 150, 64, 44);
    ctx.fillStyle = '#333';
    for (let i = 0; i < 4; i++) ctx.fillRect(34, 158 + i * 9, 50 - i * 8, 3);
  });
  cardboard.roughness = 0.9;
  cardboard.metallic = 0;
  const palletParts: Mesh[] = [];
  const boxParts: Mesh[] = [];
  const rackCx = (RACK.x0 + RACK.x1) / 2;
  for (const [li, y] of rackLevels.entries()) {
    for (const [pi, z] of [0.27, 1.73].entries()) {
      // Pallet: tabla superior y tres tacos.
      palletParts.push(box('pallet-deck', 0.8, 0.03, 1.2, new Vector3(rackCx, y + 0.13, z)));
      for (const dx of [-0.34, 0, 0.34]) palletParts.push(box('pallet-block', 0.1, 0.11, 1.2, new Vector3(rackCx + dx, y + 0.06, z)));
      const rows = li === 2 && pi === 1 ? 1 : 2;
      for (let r = 0; r < rows; r++) {
        for (const dx of [-0.2, 0.2]) {
          for (const dz of [-0.3, 0.3]) {
            const b = box('box', 0.38, 0.46, 0.56, new Vector3(rackCx + dx, y + 0.145 + 0.23 + r * 0.47, z + dz));
            b.rotation.y = ((li * 7 + pi * 3 + r) % 3) * 0.015 - 0.015;
            boxParts.push(b);
          }
        }
      }
    }
  }
  const palletMesh = Mesh.MergeMeshes(palletParts, true, true)!;
  palletMesh.name = 'pallets';
  solid([palletMesh], woodMat);
  const boxMesh = Mesh.MergeMeshes(boxParts, true, true)!;
  boxMesh.name = 'boxes';
  solid([boxMesh], cardboard);

  // Carteles de carga suspendida: punta de la estantería y pared del fondo.
  const signMat = signMaterial(scene, 'sign-load', ['DANGER', 'SUSPENDED LOAD', 'DO NOT PASS UNDER']);
  const signA = MeshBuilder.CreatePlane('sign-rack', { width: 0.6, height: 0.75 }, scene);
  signA.position.set(rackCx, 2.05, RACK.z0 - 0.06);
  signA.material = signMat;
  const signB = MeshBuilder.CreatePlane('sign-wall', { width: 0.9, height: 1.12 }, scene);
  signB.position.set(-1.6, 2.4, HALL.d / 2 - 0.02);
  signB.material = signMat;

  // ── Baliza del puente grúa (en la columna de la botonera) ─────────
  const stack = new TransformNode('stack-light', scene);
  stack.position.set(COLUMN_X - 0.17, 2.6, -1.6);
  const poleMat = paint(scene, 'm-pole', '#2a2d30', 0.4, 0.8);
  const bracket = MeshBuilder.CreateBox('stack-bracket', { width: 0.22, height: 0.03, depth: 0.08 }, scene);
  bracket.position.set(-0.11, 0, 0);
  bracket.parent = stack;
  bracket.material = poleMat;
  const pole = MeshBuilder.CreateCylinder('stack-pole', { diameter: 0.03, height: 0.2 }, scene);
  pole.position.set(-0.2, 0.1, 0);
  pole.parent = stack;
  pole.material = poleMat;
  const lamps: Record<Exclude<StackLight, 'off'>, PBRMaterial> = {} as never;
  (['green', 'amber', 'red'] as const).forEach((c, i) => {
    const hex = { green: '#1fa34a', amber: '#f0a018', red: '#d42a1f' }[c];
    const seg = MeshBuilder.CreateCylinder(`stack-${c}`, { diameter: 0.1, height: 0.12 }, scene);
    seg.position.set(-0.2, 0.26 + i * 0.125, 0);
    seg.parent = stack;
    const m = paint(scene, `m-stack-${c}`, hex, 0.3, 0);
    m.alpha = 0.92;
    m.emissiveColor = Color3.Black();
    seg.material = m;
    lamps[c] = m;
  });
  const glow = high ? new GlowLayer('glow', scene, { blurKernelSize: 24 }) : null;
  if (glow) glow.intensity = 0.7;

  // ── Botonera colgante (cable desde la viga del puente), sin nadie ──
  const pendant = new TransformNode('pendant', scene);
  pendant.position.copyFrom(PENDANT_POS);
  const pBox = MeshBuilder.CreateBox('pendant-box', { width: 0.11, height: 0.34, depth: 0.1 }, scene);
  pBox.parent = pendant;
  pBox.material = paint(scene, 'm-pendant', '#f0b90b', 0.45, 0.1);
  const btnMat = paint(scene, 'm-pendant-btn', '#202224', 0.5, 0);
  for (let i = 0; i < 4; i++) {
    const b = MeshBuilder.CreateCylinder('pendant-btn', { diameter: 0.028, height: 0.012 }, scene);
    b.rotation.z = Math.PI / 2;
    b.position.set(0.058, 0.09 - i * 0.055, 0);
    b.parent = pendant;
    b.material = btnMat;
  }
  const estop = MeshBuilder.CreateCylinder('pendant-estop', { diameter: 0.05, height: 0.03 }, scene);
  estop.position.y = 0.185;
  estop.parent = pendant;
  estop.material = paint(scene, 'm-estop', '#c81e1e', 0.4, 0);
  const pendantTop = pendant.position.y + 0.2;
  const pCable = MeshBuilder.CreateCylinder('pendant-cable', { diameter: 0.035, height: RUNWAY_TOP - pendantTop }, scene);
  pCable.position.set(pendant.position.x, (RUNWAY_TOP + pendantTop) / 2, pendant.position.z);
  pCable.material = paint(scene, 'm-cable', '#151618', 0.6, 0.1);
  cast([pBox, pCable]);

  // ── Seccionador general de PG-01 (bloqueo y etiquetado) ──────────
  // Gabinete gris en la columna, manija rotativa roja y la orejeta de bloqueo
  // vacía: el técnico no puso su candado. Con RUNNING la manija pasa a ON.
  const panelMat = paint(scene, 'm-panel', '#a9aeb1', 0.5, 0.45);
  const cabinet = box('panel-cabinet', PANEL.w, PANEL.h, PANEL.d, new Vector3(PANEL.x, PANEL.y, PANEL.z));
  solid([cabinet], panelMat);
  const frontZ = PANEL.z - PANEL.d / 2;
  const door = MeshBuilder.CreatePlane('panel-door', { width: PANEL.w - 0.04, height: PANEL.h - 0.04 }, scene);
  door.position.set(PANEL.x, PANEL.y, frontZ - 0.003);
  const doorMat = new PBRMaterial('m-panel-door', scene);
  doorMat.albedoTexture = drawn(scene, 'panel-door', 384, 512, (ctx) => {
    ctx.fillStyle = '#b4b9bc';
    ctx.fillRect(0, 0, 384, 512);
    ctx.strokeStyle = '#8c9195';
    ctx.lineWidth = 6;
    ctx.strokeRect(6, 6, 372, 500);
    // Placa de identificación.
    ctx.fillStyle = '#f4f2ec';
    ctx.fillRect(34, 26, 316, 92);
    ctx.fillStyle = '#111';
    ctx.textAlign = 'center';
    ctx.font = 'bold 40px Arial, sans-serif';
    ctx.fillText('PG-01', 192, 66);
    ctx.font = 'bold 26px Arial, sans-serif';
    ctx.fillText('MAIN DISCONNECT', 192, 104);
    // Etiqueta de alta tensión: triángulo amarillo con rayo.
    ctx.fillStyle = '#f2c200';
    ctx.strokeStyle = '#111';
    ctx.lineWidth = 9;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(110, 160);
    ctx.lineTo(196, 306);
    ctx.lineTo(24, 306);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#111';
    ctx.beginPath();
    ctx.moveTo(120, 200);
    ctx.lineTo(90, 252);
    ctx.lineTo(112, 252);
    ctx.lineTo(98, 292);
    ctx.lineTo(134, 236);
    ctx.lineTo(112, 236);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#c81e1e';
    ctx.fillRect(24, 330, 172, 44);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 32px Arial, sans-serif';
    ctx.fillText('DANGER', 110, 364);
    ctx.fillStyle = '#111';
    ctx.font = 'bold 21px Arial, sans-serif';
    ctx.fillText('HIGH VOLTAGE', 110, 400);
    // Collar amarillo de la manija con OFF / ON.
    ctx.fillStyle = '#f2c200';
    ctx.beginPath();
    ctx.arc(290, 250, 70, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#111';
    ctx.font = 'bold 24px Arial, sans-serif';
    ctx.fillText('ON', 290, 172);
    ctx.fillText('OFF', 290, 352);
  });
  doorMat.roughness = 0.55;
  doorMat.metallic = 0.2;
  door.material = doorMat;
  door.receiveShadows = true;
  // Manija rotativa: OFF = horizontal, ON = vertical. El collar está a
  // (290, 250) en la textura de la puerta.
  const handleAt = new Vector3(PANEL.x + (290 / 384 - 0.5) * (PANEL.w - 0.04), PANEL.y + (0.5 - 250 / 512) * (PANEL.h - 0.04), frontZ);
  const redMat = paint(scene, 'm-loto-red', '#c8161b', 0.42, 0.05);
  const handle = new TransformNode('panel-handle', scene);
  handle.position.copyFrom(handleAt);
  const hub = MeshBuilder.CreateCylinder('panel-hub', { diameter: 0.07, height: 0.04 }, scene);
  hub.rotation.x = Math.PI / 2;
  hub.position.z = -0.02;
  const lever = box('panel-lever', 0.19, 0.04, 0.035, new Vector3(-0.05, 0, -0.05));
  for (const m of [hub, lever]) m.parent = handle;
  solid([hub, lever], redMat);
  // Orejeta de bloqueo (hasp) colgando de la manija, VACÍA: el caso que
  // justifica Sentinel es el técnico que no puso su candado (o se lo sacaron).
  // No hay candado ni tarjeta en loto-v1, ni aparecen solos al desenergizar.
  const lockout = new TransformNode('lockout', scene);
  lockout.position.set(handleAt.x + 0.07, handleAt.y - 0.04, frontZ - 0.07);
  const haspSteel = paint(scene, 'm-hasp', '#c9ccd0', 0.25, 0.95);
  const haspJaw = MeshBuilder.CreateTorus('hasp-jaw', { diameter: 0.045, thickness: 0.007, tessellation: 24 }, scene);
  haspJaw.rotation.x = Math.PI / 2;
  haspJaw.position.y = -0.012;
  // Placa con seis agujeros para candados personales: todos libres.
  const haspPlate = MeshBuilder.CreatePlane('hasp-plate', { width: 0.07, height: 0.1 }, scene);
  haspPlate.position.set(0, -0.085, -0.004);
  const haspMat = new PBRMaterial('m-hasp-plate', scene);
  haspMat.albedoTexture = drawn(
    scene,
    'hasp-plate',
    128,
    184,
    (ctx) => {
      ctx.clearRect(0, 0, 128, 184);
      ctx.fillStyle = '#c63a2a';
      ctx.beginPath();
      ctx.roundRect(4, 4, 120, 176, 18);
      ctx.fill();
      ctx.globalCompositeOperation = 'destination-out';
      for (const [x, y] of [[36, 50], [92, 50], [36, 98], [92, 98], [36, 146], [92, 146]]) {
        ctx.beginPath();
        ctx.arc(x!, y!, 15, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
    },
    true,
  );
  haspMat.useAlphaFromAlbedoTexture = true;
  haspMat.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHATEST;
  haspMat.roughness = 0.45;
  haspMat.metallic = 0.4;
  haspMat.backFaceCulling = false;
  haspPlate.material = haspMat;
  haspJaw.material = haspSteel;
  for (const m of [haspJaw, haspPlate]) m.parent = lockout;
  cast([haspJaw, haspPlate]);
  // Lámpara de "energía presente" en la puerta (apagada en mantenimiento).
  const powerLamp = MeshBuilder.CreateCylinder('panel-lamp', { diameter: 0.045, height: 0.03 }, scene);
  powerLamp.rotation.x = Math.PI / 2;
  powerLamp.position.set(PANEL.x - 0.124, PANEL.y - PANEL.h / 2 + 0.07, frontZ - 0.015);
  const powerLampMat = paint(scene, 'm-panel-lamp', '#2fbf55', 0.3, 0);
  powerLampMat.emissiveColor = Color3.Black();
  powerLamp.material = powerLampMat;
  // Caño de la alimentación al puente grúa, del gabinete a la viga carril.
  const conduitTop = RUNWAY_TOP - 0.6;
  const conduit = box('panel-conduit', 0.06, conduitTop - (PANEL.y + PANEL.h / 2), 0.06, new Vector3(PANEL.x + 0.18, (conduitTop + PANEL.y + PANEL.h / 2) / 2, PANEL.z + 0.05));
  solid([conduit], poleMat);
  // Cartel de alta tensión en la columna, sobre el tablero.
  const hvSign = MeshBuilder.CreatePlane('sign-hv', { width: 0.5, height: 0.625 }, scene);
  hvSign.position.set(PANEL.x, PANEL.y + PANEL.h / 2 + 0.5, 2.4 - 0.175);
  hvSign.material = signMaterial(scene, 'sign-hv', ['DANGER', 'HIGH VOLTAGE', 'LOCKOUT / TAGOUT'], 'bolt');
  function setPanelPower(on: boolean) {
    // ON: manija vertical; OFF: horizontal (bloqueable).
    handle.rotation.z = on ? Math.PI / 2 : 0;
    powerLampMat.emissiveColor = on ? powerLampMat.albedoColor.scale(2.2) : Color3.Black();
  }
  setPanelPower(false);

  // ── Caja de herramientas del técnico, al lado del gancho ─────────
  // A su derecha en CAM-01 (≈ 749, 434 px): no se pisa con sus piernas.
  const toolbox = new TransformNode('toolbox', scene);
  toolbox.position.set(1.6, 0, 0.4);
  toolbox.rotation.y = 0.35;
  const tbRed = paint(scene, 'm-toolbox', '#b3261e', 0.4, 0.5);
  const tbParts = [
    box('toolbox-body', 0.5, 0.22, 0.24, new Vector3(0, 0.11, 0)),
    box('toolbox-lid', 0.5, 0.04, 0.24, new Vector3(0, 0.24, 0)),
  ];
  const tbHandle = [
    box('toolbox-grip', 0.26, 0.025, 0.03, new Vector3(0, 0.34, 0)),
    box('toolbox-post', 0.02, 0.08, 0.03, new Vector3(-0.12, 0.3, 0)),
    box('toolbox-post', 0.02, 0.08, 0.03, new Vector3(0.12, 0.3, 0)),
  ];
  for (const m of [...tbParts, ...tbHandle]) m.parent = toolbox;
  solid(tbParts, tbRed);
  solid(tbHandle, poleMat);
  // Una llave en el piso, al lado de la caja.
  const wrench = box('wrench', 0.24, 0.015, 0.03, new Vector3(0.78, 0.008, 1.22));
  wrench.rotation.y = -0.6;
  solid([wrench], railSteel);

  // ── Lámparas colgantes (por encima del puente grúa y en las naves laterales) ──
  const lampLights = [
    new Vector3(-2.6, 8.4, -2.4),
    new Vector3(2.6, 8.4, -2.4),
    new Vector3(0, 8.4, 4.2),
    new Vector3(-8, 6.2, 2.5),
    new Vector3(8, 6.2, 2.5),
  ];
  for (const [i, p] of lampLights.entries()) {
    const l = new PointLight(`lamp-light-${i}`, p.add(new Vector3(0, -1.5, 0)), scene);
    l.intensity = 40;
    l.range = 14;
    l.diffuse = Color3.FromHexString('#ffd9a8');
  }

  // ── Operario (holder arrastrable) ───────────────────────────────
  const operator = new Mesh('operator', scene);
  operator.position.copyFrom(OPERATOR_OUTSIDE);
  const pickProxy = MeshBuilder.CreateCapsule('operator-pick', { height: OPERATOR_HEIGHT, radius: 0.3 }, scene);
  pickProxy.position.y = OPERATOR_HEIGHT / 2;
  pickProxy.parent = operator;
  pickProxy.visibility = 0;

  const drag = new PointerDragBehavior({ dragPlaneNormal: new Vector3(0, 1, 0) });
  drag.useObjectOrientationForDragging = false;
  drag.onDragStartObservable.add(() => {
    target = null;
    main.detachControl();
  });
  drag.onDragEndObservable.add(() => {
    main.attachControl(canvas, true);
    settle();
  });
  drag.validateDrag = (p) => Math.abs(p.x) < HALL.w / 2 - 0.6 && Math.abs(p.z) < HALL.d / 2 - 0.6;
  operator.addBehavior(drag);

  // ── Rótulos del relato (sólo cámara principal, nunca en CAM-01) ─────
  // Cartel flotante que siempre mira a la cámara: título y bajada.
  const labels: Mesh[] = [];
  function callout(name: string, title: string, subs: string[], accent: string, width: number) {
    const W = 1280;
    const H = 130 + subs.length * 80;
    const plane = MeshBuilder.CreatePlane(name, { width, height: (width * H) / W }, scene);
    plane.billboardMode = Mesh.BILLBOARDMODE_ALL;
    // Encima de la nave: un rótulo tapado por la estantería no se lee.
    plane.renderingGroupId = 1;
    const mat = new StandardMaterial(`m-${name}`, scene);
    const tex = drawn(
      scene,
      name,
      W,
      H,
      (ctx) => {
        ctx.clearRect(0, 0, W, H);
        ctx.fillStyle = 'rgba(14, 16, 19, 0.9)';
        ctx.beginPath();
        ctx.roundRect(6, 6, W - 12, H - 12, 24);
        ctx.fill();
        ctx.fillStyle = accent;
        ctx.fillRect(6, 24, 20, H - 48);
        ctx.textAlign = 'left';
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 88px Arial, sans-serif';
        ctx.fillText(title, 60, 108, W - 90);
        // Subtítulos en blanco: con el tone mapping un color claro sale oscuro.
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 64px Arial, sans-serif';
        subs.forEach((t, i) => ctx.fillText(t, 60, 190 + i * 80, W - 90));
      },
      true,
    );
    mat.diffuseTexture = tex;
    mat.emissiveTexture = tex;
    mat.useAlphaFromDiffuseTexture = true;
    mat.disableLighting = true;
    mat.backFaceCulling = false;
    plane.material = mat;
    plane.isPickable = false;
    plane.layerMask = NARRATIVE_LAYER;
    glow?.addExcludedMesh(plane);
    labels.push(plane);
    return plane;
  }
  const techInLabel = callout('label-tech-in', 'Technician', ['servicing hoist — in the work zone'], '#ffd36b', 3.2);
  const techOutLabel = callout('label-tech-out', 'Technician', ['outside the work zone'], '#b8c0c8', 3.2);
  for (const l of [techInLabel, techOutLabel]) {
    l.parent = operator;
    l.position.y = OPERATOR_HEIGHT + 0.65;
  }
  techInLabel.setEnabled(false);
  const panelLabel = callout(
    'label-panel-op',
    'Operator at main disconnect',
    ['no line of sight to the hoist', 'lockout hasp empty — no padlock applied'],
    '#ff9a90',
    3.4,
  );
  panelLabel.position.set(PANEL_OPERATOR.x - 0.3, OPERATOR_HEIGHT + 1.05, PANEL_OPERATOR.z);
  // Línea de visión del que energiza hacia el punto de trabajo: roja hasta
  // la estantería, una cruz donde la corta, y punteada (lo que no ve) detrás.
  const losMat = new StandardMaterial('m-los', scene);
  losMat.emissiveColor = Color3.FromHexString('#ff4a3d');
  losMat.disableLighting = true;
  const losHidden = new StandardMaterial('m-los-hidden', scene);
  losHidden.emissiveColor = Color3.FromHexString('#c9ced3');
  losHidden.disableLighting = true;
  losHidden.alpha = 0.7;
  const eye = new Vector3(PANEL_OPERATOR.x - 0.12, 1.62, PANEL_OPERATOR.z - 0.05);
  const workPt = new Vector3(OPERATOR_IN_ZONE.x, 1.45, OPERATOR_IN_ZONE.z);
  const tRack = (eye.x - RACK.x1) / (eye.x - workPt.x);
  const cut = Vector3.Lerp(eye, workPt, tRack);
  const rod = (name: string, a: Vector3, b: Vector3, mat: StandardMaterial, d = 0.025) => {
    const len = Vector3.Distance(a, b);
    const m = MeshBuilder.CreateCylinder(name, { diameter: d, height: len, tessellation: 8 }, scene);
    m.position = Vector3.Center(a, b);
    const dir = b.subtract(a).normalize();
    const axis = Vector3.Cross(Vector3.Up(), dir);
    const ang = Math.acos(Vector3.Dot(Vector3.Up(), dir));
    if (axis.length() > 1e-6) m.rotate(axis.normalize(), ang);
    m.material = mat;
    m.isPickable = false;
    m.layerMask = NARRATIVE_LAYER;
    glow?.addExcludedMesh(m);
    return m;
  };
  rod('los-seen', eye, cut, losMat);
  const toWork = workPt.subtract(cut);
  const dashes = 14;
  for (let i = 0; i < dashes; i++) {
    const a = cut.add(toWork.scale((i + 0.25) / dashes));
    const b = cut.add(toWork.scale((i + 0.7) / dashes));
    rod(`los-hidden-${i}`, a, b, losHidden, 0.02);
  }
  // Cruz sobre la cara de la estantería, en el plano YZ.
  const xr = 0.16;
  rod('los-x1', cut.add(new Vector3(-0.01, xr, xr)), cut.add(new Vector3(-0.01, -xr, -xr)), losMat, 0.045);
  rod('los-x2', cut.add(new Vector3(-0.01, xr, -xr)), cut.add(new Vector3(-0.01, -xr, xr)), losMat, 0.045);

  // ── Reloj del técnico (wearable SIMULADO) ───────────────────────
  // Malla en metros: malla de la correa (cilindro con el eje a lo largo del
  // antebrazo), caja y pantalla. En reposo la pantalla está apagada; con
  // wearable.notify se prende ámbar y vibra ~4 s (pulso de escala y brillo
  // por reloj, sin azar: capture.mjs y record-demo repiten igual), y queda
  // ámbar hasta el próximo ENERGIZE o hasta que el técnico sale de la zona.
  // Es parte de la escena (lo ve CAM-01, como cualquier objeto); el rótulo
  // con el texto es del relato y CAM-01 no lo ve.
  const WATCH_BUZZ_MS = 4000;
  const WATCH_IDLE = Color3.FromHexString('#0b1418');
  const WATCH_AMBER = Color3.FromHexString('#ffb020');
  const watchMount = new TransformNode('tech-watch', scene);
  const watchBody = new TransformNode('tech-watch-body', scene);
  watchBody.parent = watchMount;
  const watchBandMat = paint(scene, 'm-watch-band', '#17191c', 0.75, 0.05);
  const watchScreenMat = new StandardMaterial('m-watch-screen', scene);
  watchScreenMat.diffuseColor = Color3.Black();
  watchScreenMat.specularColor = new Color3(0.25, 0.25, 0.25);
  watchScreenMat.emissiveColor = WATCH_IDLE;
  const watchBand = MeshBuilder.CreateCylinder('tech-watch-band', { diameter: WATCH_BAND_D, height: 0.026, tessellation: 24 }, scene);
  const watchCase = MeshBuilder.CreateBox('tech-watch-case', { width: 0.04, height: 0.036, depth: 0.014 }, scene);
  watchCase.position.z = WATCH_BAND_D / 2 + 0.004;
  const watchScreen = MeshBuilder.CreateBox('tech-watch-screen', { width: 0.032, height: 0.028, depth: 0.003 }, scene);
  watchScreen.position.z = WATCH_BAND_D / 2 + 0.0115;
  for (const m of [watchBand, watchCase, watchScreen]) {
    m.parent = watchBody;
    m.isPickable = false;
    m.material = m === watchScreen ? watchScreenMat : watchBandMat;
  }
  let watchId: string | null = null;
  // Último aviso mostrado y si ya se apagó: el texto de Muse Spark que llega
  // tarde para un aviso apagado no vuelve a prender el reloj.
  let watchLastId: string | null = null;
  let watchDismissed = false;
  // Todos los avisos ya vistos: uno viejo que llega tarde no vuelve a vibrar.
  const watchSeen = new Set<string>();
  let watchBuzzT0 = 0;
  let watchLabel: Mesh | null = null;
  let watchLabelH = 0;
  function dropWatchLabel() {
    if (!watchLabel) return;
    labels.splice(labels.indexOf(watchLabel), 1);
    glow?.removeExcludedMesh(watchLabel);
    watchLabel.dispose(false, true);
    watchLabel = null;
  }
  function notifyWatch(n: WatchNotice) {
    if (watchSeen.has(n.id) && (n.id !== watchLastId || watchDismissed)) return;
    if (!watchSeen.has(n.id)) {
      watchSeen.add(n.id);
      watchLastId = n.id;
      watchDismissed = false;
      watchBuzzT0 = performance.now();
    }
    watchId = n.id;
    dropWatchLabel();
    // Reemplaza al rótulo "Technician" mientras el aviso está activo.
    const width = 3.4;
    const subs = [...wrapText(n.text, 32), `simulated wearable · ${n.sourceLabel}`];
    watchLabel = callout('label-tech-watch', "Technician's watch", subs, '#ffb020', width);
    watchLabel.parent = operator;
    watchLabelH = (width * (130 + subs.length * 80)) / 1280;
    techInLabel.setEnabled(false);
    techOutLabel.setEnabled(false);
  }
  function clearWatch() {
    watchId = null;
    watchDismissed = true;
    dropWatchLabel();
    watchBody.scaling.setAll(1);
    watchScreenMat.emissiveColor = WATCH_IDLE;
    if (inside !== null) {
      techInLabel.setEnabled(inside);
      techOutLabel.setEnabled(!inside);
    }
  }

  // Tomas de cámara para el video: 1 general, 2 seccionador, 3 técnico.
  // Tween por reloj (no por cuadro): sin GPU hay pocos cuadros y igual llega.
  type View = (typeof VIEWS)[ViewPreset];
  let viewGoal: View | null = null;
  let viewFrom: View | null = null;
  let viewT0 = 0;
  const VIEW_MS = 1400;
  function setView(v: ViewPreset) {
    viewFrom = { alpha: main.alpha, beta: main.beta, radius: main.radius, target: main.target.clone() };
    viewGoal = VIEWS[v];
    viewT0 = performance.now();
  }
  const onKey = (e: KeyboardEvent) => {
    const v = ({ '1': 'overview', '2': 'disconnect', '3': 'technician' } as const)[e.key as '1' | '2' | '3'];
    if (v && !(e.target instanceof HTMLInputElement)) setView(v);
  };
  window.addEventListener('keydown', onKey);
  const initialView = new URLSearchParams(window.location.search).get('view');
  if (initialView && initialView in VIEWS) {
    const v = VIEWS[initialView as ViewPreset];
    main.setTarget(v.target.clone(), false, false, true);
    main.alpha = v.alpha;
    main.beta = v.beta;
    main.radius = v.radius;
  }

  let anims: Record<string, AnimationGroup> = {};
  let current: AnimationGroup | null = null;
  // Pose de reposo de cada hueso animado. Las animaciones no mueven todos los
  // huesos (Interact no anima los pies): sin volver a reposo, lo que no anima
  // la nueva queda congelado en la pose de la anterior (pie a mitad de paso).
  let restPose: Array<() => void> = [];
  function play(name: string) {
    const next = anims[name];
    if (!next || next === current) return;
    current?.stop();
    restPose.forEach((restore) => restore());
    // Interact es un gesto corto: en loop a velocidad normal parece un tic.
    next.start(true, name === 'Interact' ? 0.45 : 1);
    current = next;
  }
  function face(dir: Vector3) {
    operator.rotation.y = Math.atan2(dir.x, dir.z);
  }
  // Al quedar quieto: dentro de la zona trabaja en el gancho bajado (de
  // perfil a CAM-01, pies a la vista); afuera espera en el paso peatonal.
  function settle() {
    if (isInsideZone(operator.position.x, operator.position.z)) {
      face(new Vector3(-0.8, 0, 0.3));
      play('Interact');
    } else {
      face(new Vector3(0, 0, 1));
      play('Idle_Neutral');
    }
  }

  // ── Puente grúa: ciclo del carro y del gancho ───────────────────
  // Bajada 1 = gancho bajado para el mantenimiento; 0 = arriba. Con RUNNING el
  // gancho sube una vez y después el carro va y viene por el puente, pasando
  // por encima del punto de trabajo. [segundos, x desde, x hasta].
  const RISE_S = 5;
  const TRAVERSE: Array<[number, number, number]> = [
    [5, HOOK_REST_X, TROLLEY_FAR_X],
    [1.5, TROLLEY_FAR_X, TROLLEY_FAR_X],
    [9, TROLLEY_FAR_X, TROLLEY_NEAR_X],
    [1.5, TROLLEY_NEAR_X, TROLLEY_NEAR_X],
    [5, TROLLEY_NEAR_X, HOOK_REST_X],
  ];
  const traverseLen = TRAVERSE.reduce((s, c) => s + c[0], 0);
  function craneAt(t: number) {
    if (t < RISE_S) return { x: HOOK_REST_X, lower: 1 - smooth(t / RISE_S) };
    let u = (t - RISE_S) % traverseLen;
    for (const [d, x0, x1] of TRAVERSE) {
      if (u <= d) return { x: x0 + (x1 - x0) * smooth(u / d), lower: 0 };
      u -= d;
    }
    return { x: HOOK_REST_X, lower: 0 };
  }
  let running = false;
  let craneT = 0;
  // Se completa al cargar el modelo.
  let applyCrane: (x: number, lower: number) => void = () => {};

  let ready = false;
  let cameraFeed = true;
  let target: Vector3 | null = null;
  let inside: boolean | null = null;
  scene.onBeforeRenderObservable.add(() => {
    const dt = engine.getDeltaTime() / 1000;
    // Rótulos de tamaño casi constante en pantalla: en un primer plano no tapan todo.
    for (const l of labels) {
      const d = Vector3.Distance(main.position, l.getAbsolutePosition());
      l.scaling.setAll(Math.min(1.2, Math.max(0.22, d / 15)));
    }
    if (viewGoal && viewFrom) {
      // Acercamiento suave a la toma pedida; se suelta al llegar.
      const u = Math.min(1, (performance.now() - viewT0) / VIEW_MS);
      const k = smooth(u);
      // El target primero y sin recalcular ángulos (el setter de target los
      // rehace desde la posición vieja y la toma nunca llega).
      main.setTarget(Vector3.Lerp(viewFrom.target, viewGoal.target, k), false, false, true);
      main.alpha = viewFrom.alpha + (viewGoal.alpha - viewFrom.alpha) * k;
      main.beta = viewFrom.beta + (viewGoal.beta - viewFrom.beta) * k;
      main.radius = viewFrom.radius + (viewGoal.radius - viewFrom.radius) * k;
      if (u >= 1) viewGoal = viewFrom = null;
    }
    if (target) {
      const delta = target.subtract(operator.position);
      delta.y = 0;
      const dist = delta.length();
      if (dist < 0.03) {
        operator.position.copyFrom(target);
        target = null;
        settle();
      } else {
        const step = Math.min(dist, WALK_SPEED * Math.min(dt, 0.5));
        operator.position.addInPlace(delta.normalize().scale(step));
        face(delta);
        play('Walk');
      }
    }
    // El puente grúa sólo se mueve con RUNNING; al parar queda donde está.
    if (ready && running) {
      craneT += Math.min(dt, 0.5);
      const s = craneAt(craneT);
      applyCrane(s.x, s.lower);
    }
    // Verdad del simulador: ¿el operario está dentro de la zona?
    const now = isInsideZone(operator.position.x, operator.position.z);
    if (now !== inside) {
      inside = now;
      techInLabel.setEnabled(now && !watchLabel);
      techOutLabel.setEnabled(!now && !watchLabel);
      // Fuera de la zona el aviso ya no corre: el reloj vuelve a reposo.
      if (!now && watchId) clearWatch();
      hooks.onTruthChange(now);
    }
    if (watchId) {
      // Vibración: pulsos cortos los primeros segundos; después, ámbar fijo.
      const t = performance.now() - watchBuzzT0;
      const buzz = t < WATCH_BUZZ_MS ? Math.abs(Math.sin((t / 1000) * Math.PI * 5)) : 0;
      watchBody.scaling.setAll(1 + 0.18 * buzz);
      watchScreenMat.emissiveColor = WATCH_AMBER.scale(1 + 0.9 * buzz);
    }
    if (watchLabel) {
      // Encima de la cabeza a cualquier escala (el rótulo es más alto que el otro).
      watchLabel.position.y = OPERATOR_HEIGHT + 0.3 + (watchLabel.scaling.y * watchLabelH) / 2;
    }
  });

  // ── Post-proceso ────────────────────────────────────────────────
  const cameras = [main, cam01];
  // Sin SSAO: con dos cámaras y viewports, su prepass mezclaba la imagen de
  // la cámara principal dentro de la vista de CAM-01 (probado en crane-v1).
  const pipeline = new DefaultRenderingPipeline('post', true, scene, cameras);
  pipeline.samples = high ? 4 : 1;
  pipeline.fxaaEnabled = true;
  pipeline.bloomEnabled = true;
  pipeline.bloomThreshold = 0.92;
  pipeline.bloomWeight = 0.18;
  pipeline.imageProcessingEnabled = true;

  // Puente grúa con cable de largo variable: el polipasto se dibuja en tres
  // copias recortadas por planos horizontales (arriba: carro y tambor; medio:
  // los ramales de cable, estirados en Y; abajo: motón y gancho, desplazados).
  // Así el cable se alarga sin deformar el gancho.
  async function loadCrane() {
    const crane = await loadModel(scene, 'overhead_crane/overhead_crane_2k.gltf', 'crane');
    crane.holder.scaling.setAll(CRANE_SCALE);
    crane.holder.position.set(0, RUNWAY_TOP + 0.04 * CRANE_SCALE, BRIDGE_Z);
    // El modelo trae tramos cortos de riel; la nave tiene los suyos.
    crane.meshes.find((m) => m.name === 'overhead_crane_rails')?.setEnabled(false);
    const winch = crane.holder.getDescendants(false).find((n) => n.name === 'overhead_crane_winch') as TransformNode;
    // Cotas en el espacio del mesh del polipasto (leídas del glTF): entre
    // CUT_TOP y CUT_BOT sólo hay ramales de cable.
    const CUT_TOP = -1.0;
    const CUT_BOT = -1.7;
    const HOOK = new Vector3(-0.42, -3.2, -0.03);
    const base = winch.position.clone();
    const band = winch.clone('winch-cable', winch.parent)!;
    const block = winch.clone('winch-block', winch.parent)!;
    const parts = [winch, band, block];
    // Materiales propios por copia (cada una lleva sus planos de recorte).
    const mats = parts.map((p) => {
      const own = new Map<string, PBRMaterial>();
      for (const m of p.getChildMeshes(false)) {
        const src = m.material as PBRMaterial | null;
        if (!src) continue;
        let c = own.get(src.name);
        if (!c) {
          c = src.clone(`${src.name}-${p.name}`);
          own.set(src.name, c);
        }
        m.material = c;
      }
      return [...own.values()];
    });
    const hookPt = new TransformNode('hook-pt', scene);
    hookPt.parent = block;
    hookPt.position.copyFrom(HOOK);
    const topPt = new TransformNode('cut-top', scene);
    topPt.parent = winch;
    topPt.position.set(0, CUT_TOP, 0);
    const visible = (m: AbstractMesh) => m.isEnabled() && m.getTotalVertices() > 0;
    cast(crane.meshes.filter(visible));
    cast(band.getChildMeshes(false));
    cast(block.getChildMeshes(false));
    crane.meshes.forEach((m) => (m.receiveShadows = true));

    // Medidas en reposo para pasar de mundo a local del polipasto.
    const measure = () => {
      crane.holder.computeWorldMatrix(true);
      for (const p of parts) p.computeWorldMatrix(true);
      hookPt.computeWorldMatrix(true);
      topPt.computeWorldMatrix(true);
    };
    measure();
    const hook0 = hookPt.getAbsolutePosition().clone();
    const cutTopY = topPt.getAbsolutePosition().y;
    const topX0 = topPt.getAbsolutePosition().x;
    // Sentido del eje X local respecto del mundo (el glTF entra espejado).
    winch.position.x += 1;
    measure();
    const xSign = Math.sign(topPt.getAbsolutePosition().x - topX0) || -1;
    winch.position.x -= 1;
    const bandLen = (CUT_TOP - CUT_BOT) * CRANE_SCALE;
    const fullDrop = hook0.y - HOOK_WORK_Y;
    const eps = 0.002;

    applyCrane = (x, lower) => {
      const drop = lower * fullDrop;
      const s = 1 + drop / bandLen;
      const lx = base.x + (xSign * (x - hook0.x)) / CRANE_SCALE;
      for (const p of parts) p.position.x = lx;
      // Ramales: escala en Y con pivote en el corte de arriba.
      band.scaling.y = s;
      band.position.y = base.y + CUT_TOP * (1 - s);
      block.position.y = base.y - drop / CRANE_SCALE;
      const cutBotY = cutTopY - bandLen * s;
      for (const m of mats[0]!) m.clipPlane = new Plane(0, -1, 0, cutTopY - eps);
      for (const m of mats[1]!) {
        m.clipPlane = new Plane(0, 1, 0, -(cutTopY + eps));
        m.clipPlane2 = new Plane(0, -1, 0, cutBotY - eps);
      }
      for (const m of mats[2]!) m.clipPlane = new Plane(0, 1, 0, -(cutBotY + eps));
      halo.position.set(x, 0.009, hook0.z);
    };
    applyCrane(HOOK_REST_X, 1);
  }

  // Reloj a la muñeca izquierda: cerca del final del antebrazo (justo antes de
  // la muñeca) para que la correa no se doble con la mano. Sin hueso, queda
  // colgado del operario a la altura aproximada de la muñeca.
  function attachWatch(nodes: TransformNode[]) {
    const { forearm, wrist } = leftWristNodes(nodes);
    if (forearm && wrist && wrist.parent === forearm) {
      watchMount.parent = forearm;
      watchMount.position.copyFrom(wrist.position.scale(0.86));
    } else if (wrist ?? forearm) {
      watchMount.parent = (wrist ?? forearm)!;
    } else {
      watchMount.parent = operator;
      watchMount.position.set(0.24, 0.92, 0.12);
      return;
    }
    // La malla está en metros: se compensa la escala acumulada del rig (el
    // holder escalado y el ×100 de la armadura de Quaternius).
    const chain: TransformNode[] = [];
    for (let n: TransformNode | null = watchMount.parent as TransformNode; n; n = n.parent as TransformNode | null) chain.unshift(n);
    chain.forEach((n) => n.computeWorldMatrix(true));
    const k = new Vector3();
    (watchMount.parent as TransformNode).getWorldMatrix().decompose(k);
    watchMount.scaling.set(1 / Math.abs(k.x), 1 / Math.abs(k.y), 1 / Math.abs(k.z));
    watchMount.rotation.y = WATCH_TURN;
  }

  // ── Carga de assets ─────────────────────────────────────────────
  async function load() {
    await loadCrane();

    const props: Array<[string, Vector3, number]> = [
      ['metal_tool_chest/metal_tool_chest_1k.gltf', new Vector3(-3.4, 0, 6.45), Math.PI],
      ['worn_metal_rack/worn_metal_rack_1k.gltf', new Vector3(4.2, 0, 6.5), Math.PI],
      ['industrial_storage_cart/industrial_storage_cart_1k.gltf', new Vector3(-7.6, 0, 1.0), Math.PI / 2],
      ['hand_truck/hand_truck_1k.gltf', new Vector3(6.4, 0, 4.9), -0.5],
      ['power_box_01/power_box_01_1k.gltf', new Vector3(1.9, 1.5, 6.94), Math.PI],
      ['barrel_03/barrel_03_1k.gltf', new Vector3(-8.6, 0, 5.9), 0],
      ['barrel_03/barrel_03_1k.gltf', new Vector3(-7.9, 0, 6.1), 1.2],
      ['wooden_crate_01/wooden_crate_01_1k.gltf', new Vector3(8.4, 0, 5.6), 0.2],
      ['wooden_crate_01/wooden_crate_01_1k.gltf', new Vector3(8.5, 0, 4.7), -0.1],
    ];
    for (const [path, pos, rot] of props) {
      const p = await loadModel(scene, path, path.split('/')[0]!);
      p.holder.position = pos;
      p.holder.rotation.y = rot;
      cast(p.meshes);
      p.meshes.forEach((m) => (m.receiveShadows = true));
    }
    for (const p of lampLights) {
      const lamp = await loadModel(scene, 'hanging_industrial_lamp/hanging_industrial_lamp_1k.gltf', 'lamp');
      const { max: lampMax } = lamp.holder.getHierarchyBoundingVectors(true);
      lamp.holder.position = new Vector3(p.x, p.y - lampMax.y, p.z);
    }

    // Cámara de seguridad física donde está CAM-01 (queda fuera de su cuadro).
    const camModel = await loadModel(scene, 'security_camera_02/security_camera_02_1k.gltf', 'cam-01-body');
    camModel.holder.scaling.setAll(1.4);
    const ahead = cam01Target.subtract(cam01Pos).normalize();
    camModel.holder.position = cam01Pos.subtract(ahead.scale(0.62));
    camModel.holder.lookAt(cam01Target);
    // Ménsula desde la cara de la columna hasta la base de la cámara.
    const colFace = new Vector3(-COLUMN_X + 0.17, camModel.holder.position.y, COLUMN_Z[0]!);
    const armLen = Vector3.Distance(colFace, camModel.holder.position);
    const camArm = MeshBuilder.CreateBox('cam-01-arm', { width: 0.06, height: 0.06, depth: armLen + 0.05 }, scene);
    camArm.position = Vector3.Center(colFace, camModel.holder.position);
    camArm.lookAt(camModel.holder.position);
    camArm.material = poleMat;

    const worker = await loadModel(scene, 'quaternius_worker/worker.glb', 'worker');
    worker.holder.parent = operator;
    const b = worker.holder.getHierarchyBoundingVectors(true);
    const scale = OPERATOR_HEIGHT / (b.max.y - b.min.y);
    worker.holder.scaling.setAll(scale);
    worker.holder.position.y = -b.min.y * scale;
    cast(worker.meshes);
    worker.meshes.forEach((m) => (m.isPickable = false));
    attachWatch(worker.nodes);
    anims = Object.fromEntries(worker.animations.map((g) => [g.name.split('|').pop()!, g]));
    worker.animations.forEach((g) => g.stop());
    const targets = new Set(worker.animations.flatMap((g) => g.targetedAnimations.map((t) => t.target)));
    restPose = [...targets]
      .filter((t): t is TransformNode => t instanceof TransformNode)
      .map((node) => {
        const position = node.position.clone();
        const rotation = node.rotationQuaternion?.clone() ?? null;
        const scaling = node.scaling.clone();
        return () => {
          node.position.copyFrom(position);
          if (rotation) node.rotationQuaternion = rotation.clone();
          node.scaling.copyFrom(scaling);
        };
      });
    settle();

    // El que va a devolver la energía: chaleco azul y casco blanco, frente al
    // seccionador, detrás de la estantería (no ve al técnico).
    const craneOp = await loadModel(scene, 'quaternius_worker/worker.glb', 'panel-operator');
    craneOp.holder.scaling.setAll(scale);
    craneOp.holder.position.set(PANEL_OPERATOR.x, -b.min.y * scale, PANEL_OPERATOR.z);
    craneOp.holder.rotation.y = Math.atan2(PANEL.x - PANEL_OPERATOR.x, PANEL.z - PANEL_OPERATOR.z);
    for (const m of craneOp.materials) {
      if (!(m instanceof PBRMaterial)) continue;
      if (m.name === 'Worker_Vest') m.albedoColor = Color3.FromHexString('#1d4f8f').toLinearSpace();
      if (m.name === 'Worker_Yellow') m.albedoColor = Color3.FromHexString('#e8e8e4').toLinearSpace();
    }
    cast(craneOp.meshes);
    craneOp.meshes.forEach((m) => (m.isPickable = false));
    craneOp.animations.forEach((g) => g.stop());
    craneOp.animations.find((g) => g.name.endsWith('Interact'))?.start(true);

    floor.receiveShadows = true;
    await scene.whenReadyAsync();
    ready = true;
    hooks.onReady();
  }

  load().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    hooks.onError(`No se pudo cargar la escena 3D (${msg}). ¿Corriste node scripts/fetch-assets.mjs?`);
  });

  // Mientras carga, un cuadro por segundo: en máquinas sin GPU el render
  // compite con la carga, pero sin render la escena nunca se declara lista.
  let lastLoadingFrame = 0;
  engine.runRenderLoop(() => {
    if (!ready) {
      if (performance.now() - lastLoadingFrame < 1000) return;
      lastLoadingFrame = performance.now();
    }
    scene.render();
  });
  const onResize = () => engine.resize();
  window.addEventListener('resize', onResize);

  const api: FactoryScene = {
    moveOperator(where) {
      target = (where === 'zone' ? OPERATOR_IN_ZONE : OPERATOR_OUTSIDE).clone();
    },
    setStackLight(light) {
      for (const [c, m] of Object.entries(lamps)) {
        m.emissiveColor = c === light ? m.albedoColor.scale(2.2) : Color3.Black();
      }
    },
    setView,
    setCameraFeed(on) {
      cameraFeed = on;
      scene.activeCameras = on ? [main, cam01] : [main];
    },
    setMachineRunning(on) {
      running = on;
      halo.setEnabled(on);
      setPanelPower(on);
    },
    captureFrame(width, height) {
      if (!cameraFeed) throw new Error('camera feed is off');
      if (!ready) throw new Error('scene not ready');
      // Todo en el mismo tick: render de CAM-01 a pantalla completa, copia y
      // vuelta a la vista normal antes de que el navegador componga (no parpadea).
      const viewport = cam01.viewport;
      const active = scene.activeCameras;
      const fov = cam01.fov;
      const src = engine.getRenderingCanvas()!;
      const want = width / height;
      // Encuadre fijo como una cámara real: si el canvas es más angosto que el
      // frame, el recorte comería alto; se abre el fov para que el recorte
      // tenga siempre el mismo fov vertical (la zona calibrada en píxeles vale).
      const aspect = src.width / src.height;
      if (aspect < want) cam01.fov = 2 * Math.atan((Math.tan(fov / 2) * want) / aspect);
      cam01.viewport = new Viewport(0, 0, 1, 1);
      scene.activeCameras = [cam01];
      try {
        scene.render();
        // Recorte central a la proporción pedida y escalado.
        let sw = src.width;
        let sh = Math.round(sw / want);
        if (sh > src.height) {
          sh = src.height;
          sw = Math.round(sh * want);
        }
        const out = document.createElement('canvas');
        out.width = width;
        out.height = height;
        const ctx = out.getContext('2d')!;
        ctx.drawImage(src, (src.width - sw) / 2, (src.height - sh) / 2, sw, sh, 0, 0, width, height);
        const jpegBase64 = out.toDataURL('image/jpeg', 0.9).split(',')[1]!;
        return { jpegBase64, width, height, operatorInZone: isInsideZone(operator.position.x, operator.position.z) };
      } finally {
        cam01.fov = fov;
        cam01.viewport = viewport;
        scene.activeCameras = active;
        scene.render();
      }
    },
    notifyWatch,
    clearWatch,
    dispose() {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('keydown', onKey);
      engine.dispose();
    },
  };
  return api;
}
