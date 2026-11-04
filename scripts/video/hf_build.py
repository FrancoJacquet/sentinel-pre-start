#!/usr/bin/env python3
"""Arma el video de la demo como composición HyperFrames (HTML → MP4).

    python3 scripts/video/hf_build.py <take.mp4> <cards/> <fonts/> <voz-work/> <voz-subs/> <proyecto/>

Cortes secos, sin carteles ni zoom. Donde la voz dura más que el plano no se
congela el cuadro: sigue corriendo la toma real. Copia los assets a
<proyecto>/assets y escribe <proyecto>/index.html; el render es aparte:
`npx hyperframes render <proyecto>`.

<voz-work/> trae a01.wav … a09.wav (cada sección ya con su duración, la salida
de edit.py) y voice-track.wav; <voz-subs/> trae NN.subs.json.
"""
import json
import shutil
import subprocess
import sys
from pathlib import Path

TAKE, CARDS, FONTS, VWORK, VSUBS, PROJ = (Path(a) for a in sys.argv[1:7])
LEAD = 0.4  # la voz entra 0,4 s después del corte (igual que edit.py)

# Recortes 16:9 sobre la toma de 1920×1080: (ancho, alto, x, y).
CROP = {
    'panel': (818, 460, 1102, 290),
    'evidence': (676, 380, 925, 692),
    'verdict': (640, 360, 1280, 40),
    'cam': (533, 300, 1050, 72),
    'watch': (853, 480, 500, 225),
    # Cuadro evaluado con la explicación de Spark abajo: el subtítulo va arriba.
    'explain': (676, 380, 925, 692),
}

# Planos por sección: ('card', nombre, s) | ('take', desde, hasta, recorte, velocidad).
# El último plano de cada sección se estira o recorta para cerrar con la voz.
SHOTS = [
    [('card', 'hook', 4.5), ('take', 0.0, 6.0, None, 1.0)],
    [('card', 'problem', 5.0), ('take', 6.2, 11.0, None, 0.7), ('take', 11.2, 16.0, None, 1.0),
     ('card_tail',)],
    [('card', 'title', 4.5), ('take', 14.3, 18.5, None, 1.0), ('take', 14.4, 18.5, 'cam', 1.0),
     ('take', 14.4, 18.5, 'verdict', 1.0)],
    # Antes de las 27,6 s (cambio a la vista del técnico) para que lo de Spark no se adelante.
    [('take', 18.5, 22.2, None, 0.8), ('take', 22.2, 24.4, 'panel', 0.5),
     ('take', 24.3, 27.5, 'evidence', 0.5), ('take', 25.0, 27.6, 'verdict', 0.5)],
    # Reloj del técnico: aviso fijo al instante y, ~11 s después, el de Muse Spark;
    # cierra con la explicación de Spark bajo el cuadro evaluado.
    [('take', 27.8, 31.0, None, 1.0), ('take', 31.0, 35.8, 'watch', 1.0),
     ('take', 35.8, 39.0, 'watch', 1.0), ('take', 39.0, 42.5, 'explain', 1.0)],
    [('take', 42.6, 45.4, None, 1.0), ('take', 45.4, 47.5, 'panel', 1.0),
     ('take', 47.5, 50.8, 'evidence', 1.0), ('take', 49.3, 59.4, None, 1.0)],
    [('take', 61.4, 64.1, None, 1.0), ('take', 64.1, 69.4, 'verdict', 1.0)],
    [('card', 'built', 10.0), ('take', 37.0, 45.0, 'explain', 1.0)],
    [('card', 'end', 6.0)],
]


def duration(p):
    out = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', str(p)],
                         check=True, capture_output=True, text=True).stdout
    return float(out)


def shot_len(s):
    return s[2] if s[0] == 'card' else (s[2] - s[1]) / s[4]


def fit(shots, total):
    """Cierra la sección con la voz: el que absorbe la diferencia es el último
    plano de toma (corre más footage) o, con 'card_tail', la placa inicial."""
    shots = [s for s in shots]
    tail_card = shots[-1] == ('card_tail',)
    if tail_card:
        shots.pop()
    diff = total - sum(shot_len(s) for s in shots)
    k = 0 if tail_card or shots[-1][0] == 'card' else len(shots) - 1
    s = shots[k]
    if s[0] == 'card':
        shots[k] = (s[0], s[1], s[2] + diff)
    else:
        shots[k] = (s[0], s[1], s[2] + diff * s[4], s[3], s[4])
    return shots


def main():
    take_len = duration(TAKE)
    assets = PROJ / 'assets'
    assets.mkdir(parents=True, exist_ok=True)
    shutil.copy(TAKE, assets / 'take.mp4')
    shutil.copy(VWORK / 'voice-track.wav', assets / 'voice.wav')
    for f in FONTS.glob('*.woff'):
        shutil.copy(f, assets / f.name)
    shutil.copy(PROJ.parent / 'node_modules/gsap/dist/gsap.min.js', assets / 'gsap.min.js')

    clips, subs, t = [], [], 0.0
    top = []  # tramos (desde, hasta) con el subtítulo arriba
    for i, raw in enumerate(SHOTS, 1):
        total = duration(VWORK / f'a{i:02d}.wav')
        for s in fit(raw, total):
            d = shot_len(s)
            if s[0] == 'card':
                shutil.copy(CARDS / f'{s[1]}.png', assets / f'{s[1]}.png')
                clips.append(f'<img id="c{len(clips)}" class="clip" src="assets/{s[1]}.png" data-start="{t:.3f}" '
                             f'data-duration="{d:.3f}" data-track-index="0" />')
            else:
                _, a, b, crop, speed = s
                if crop == 'explain':
                    top.append((t, t + d))
                assert b <= take_len + 0.01, (i, s, take_len)
                style = ''
                if crop:
                    w, h, x, y = CROP[crop]
                    k = 1920 / w
                    style = (f' style="width:{1920 * k:.1f}px;height:{1080 * k:.1f}px;'
                             f'left:{-x * k:.1f}px;top:{-y * k:.1f}px"')
                rate = f' data-playback-rate="{speed}"' if speed != 1.0 else ''
                clips.append(f'<video id="c{len(clips)}" class="clip take" src="assets/take.mp4" muted data-start="{t:.3f}" '
                             f'data-duration="{d:.3f}" data-media-start="{a:.3f}"{rate} '
                             f'data-track-index="0"{style}></video>')
            t += d
        rows = json.loads((VSUBS / f'{i:02d}.subs.json').read_text())
        base = t - total + LEAD
        for k, (a, b, text) in enumerate(rows):
            a = max(a, rows[k - 1][1]) if k else a
            b = min(b + 0.15, rows[k + 1][0]) if k + 1 < len(rows) else b + 0.3
            subs.append([base + a, base + b, text.lstrip('— ').rstrip(' —')])

    # Sin parpadeo: un tramo termina donde arranca el siguiente si el hueco es corto.
    subs.sort()
    for k in range(len(subs) - 1):
        subs[k][1] = min(subs[k][1], subs[k + 1][0])
        if subs[k + 1][0] - subs[k][1] < 0.6:
            subs[k][1] = subs[k + 1][0]
    def where(a, b):
        # Sólo si el subtítulo arranca dentro del plano (no tapa el anterior).
        return ' top' if any(x <= a < y for x, y in top) else ''

    sub_html = [f'<div id="sub{n}" class="clip sub{where(a, b)}" data-start="{a:.3f}" data-duration="{b - a:.3f}" data-track-index="2">'
                f'<span>{x.replace("&", "&amp;").replace("<", "&lt;")}</span></div>' for n, (a, b, x) in enumerate(subs)]

    (PROJ / 'index.html').write_text(f'''<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=1920, height=1080" />
    <script src="assets/gsap.min.js"></script>
    <style>
      @font-face {{ font-family: "Barlow Semi Condensed"; font-weight: 600;
        src: url("assets/barlow-semi-condensed-latin-600-normal.woff") format("woff"); }}
      * {{ margin: 0; padding: 0; box-sizing: border-box; }}
      html, body {{ width: 1920px; height: 1080px; overflow: hidden; background: #141819; }}
      #root {{ position: relative; width: 1920px; height: 1080px; overflow: hidden; }}
      .clip {{ position: absolute; left: 0; top: 0; width: 1920px; height: 1080px; }}
      video.take {{ object-fit: fill; }}
      .sub {{ height: auto; top: auto; bottom: 48px; display: flex; justify-content: center; z-index: 10; }}
      .sub.top {{ top: 48px; bottom: auto; }}
      .sub span {{ max-width: 1480px; padding: 10px 26px 12px; background: rgba(20, 24, 25, 0.82);
        color: #fff; font: 600 50px/1.2 "Barlow Semi Condensed", sans-serif; text-align: center; }}
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="{t:.3f}" data-width="1920" data-height="1080">
      {chr(10).join('      ' + c for c in clips).lstrip()}
      <audio id="voice" class="clip" src="assets/voice.wav" data-start="0" data-duration="{t:.3f}" data-track-index="1"></audio>
      {chr(10).join('      ' + c for c in sub_html).lstrip()}
    </div>
    <script>
      window.__timelines = window.__timelines || {{}};
      window.__timelines["main"] = gsap.timeline({{ paused: true }});
    </script>
  </body>
</html>
''')
    print(f'{PROJ / "index.html"} {t:.1f}s clips={len(clips)} subs={len(subs)}')


main()
