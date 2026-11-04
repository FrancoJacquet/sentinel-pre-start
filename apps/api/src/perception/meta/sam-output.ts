// Lectura de la salida de SAM 3.1 en Meta Model API (Responses API). La salida
// es texto con tokens especiales: una línea por frame, `<Nf>` y después
// registros separados por coma, cada uno `<id><|box;...|><|mask;...|>`.
// Doc: https://dev.meta.ai/docs/sam/reading-segmentation (consultada 2026-11-02).
// Sólo se usan las cajas; la máscara se cuenta pero no se decodifica.

export interface SamBox {
  objectId: number;
  frameIndex: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  // Tamaño de la imagen fuente que informa el modelo.
  w: number;
  h: number;
  // Confianza 0–1; sólo viene con metadata.include_confidence = "true".
  c: number | null;
  hasMask: boolean;
}

const FRAME = /^<(\d+)f>/;
// Los campos de la caja son sólo `clave=número`; la máscara es base85 y puede
// traer cualquier símbolo, por eso se corta por la posición de la caja siguiente.
const BOX = /(\d+)<\|box;([a-z0-9=;.]*)\|>/g;
const INT_KEYS = ['x1', 'y1', 'x2', 'y2', 'w', 'h'] as const;

function fields(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of body.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) throw new Error(`malformed box field "${part.slice(0, 40)}"`);
    out.set(part.slice(0, eq), part.slice(eq + 1));
  }
  return out;
}

// Texto vacío = cero coincidencias (válido, no es error). Cualquier cosa que no
// respete la gramática es error: no se adivina una detección.
export function parseSamOutput(text: string): SamBox[] {
  const boxes: SamBox[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    const frame = FRAME.exec(line);
    if (!frame) throw new Error(`SAM line without frame marker: "${line.slice(0, 40)}"`);
    const frameIndex = Number(frame[1]);
    const rest = line.slice(frame[0].length);
    const found = [...rest.matchAll(BOX)];
    if (found.length === 0) throw new Error(`SAM line without records: "${line.slice(0, 40)}"`);
    if (found[0]!.index !== 0) throw new Error(`unexpected SAM output: "${rest.slice(0, 40)}"`);
    found.forEach((m, i) => {
      // Entre esta caja y la siguiente: la máscara de este objeto y la coma.
      const end = i + 1 < found.length ? found[i + 1]!.index : rest.length;
      const tail = rest.slice(m.index + m[0].length, end).trim().replace(/,$/, '');
      const hasMask = tail.startsWith('<|mask;') && tail.endsWith('|>');
      if (tail !== '' && !hasMask) throw new Error(`unexpected SAM output after box: "${tail.slice(0, 40)}"`);
      const f = fields(m[2]!);
      const ints = {} as Record<(typeof INT_KEYS)[number], number>;
      for (const k of INT_KEYS) {
        const v = Number(f.get(k));
        if (!Number.isInteger(v)) throw new Error(`SAM box without integer ${k}`);
        ints[k] = v;
      }
      const cRaw = f.get('c');
      const c = cRaw === undefined ? null : Number(cRaw);
      if (c !== null && !(c >= 0 && c <= 1)) throw new Error(`SAM confidence out of range: ${cRaw}`);
      boxes.push({ objectId: Number(m[1]), frameIndex, ...ints, c, hasMask });
    });
  }
  return boxes;
}
