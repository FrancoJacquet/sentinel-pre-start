#!/usr/bin/env python3
"""Arma el video de la demo con ffmpeg: placas, cortes con zoom, carteles y subtítulos.

    python3 scripts/video/edit.py <take.mp4> <cards/> <fonts/> <salida.mp4> [voz/]

<voz/> es opcional: 01.* … 09.*, un archivo por sección del guion. Con voz,
cada sección dura lo que dura su audio (se congela el último plano si hace
falta); sin voz, se estima por cantidad de palabras y el video sale mudo.
"""
import json
import os
import re
import subprocess
import sys
from pathlib import Path

TAKE, CARDS, FONTS, OUT = (Path(a) for a in sys.argv[1:5])
VOICE = Path(sys.argv[5]) if len(sys.argv) > 5 else None
WORK = OUT.parent / 'work'
WORK.mkdir(parents=True, exist_ok=True)
FPS = 30

# Recortes 16:9 sobre la toma de 1920×1080 (coordenadas de la UI).
# Fundido entre planos y acercamiento en lo sostenido: apagados por defecto
# (cortes secos se ven más limpios). Ej.: XFADE=0.35 ZOOM_PUSH=0.06.
XFADE = float(os.environ.get('XFADE', '0'))
ZOOM_PUSH = float(os.environ.get('ZOOM_PUSH', '0'))

CROP = {
    'panel': (818, 460, 1102, 290),       # tablero del seccionador (modo video)
    'evidence': (676, 380, 925, 692),     # CAM-01 · evaluated frame con la caja de SAM
    'verdict': (640, 360, 1280, 40),      # misión + veredicto del PLC
    'cam': (533, 300, 1050, 72),          # CAM-01 en vivo
    'watch': (680, 383, 540, 240),        # muñeca del técnico + globo del reloj (vista técnico)
}

# Sección: frases del guion (voz y subtítulo), planos y carteles.
# Plano: ('card', nombre, s) | ('take', desde, hasta, recorte|None, velocidad)
# Cartel: (segundo dentro de la sección, duración, texto)
SECTIONS = [
    dict(lines=['I build software for factories in Argentina.',
                'And I know of people who died the same way:',
                'someone restored the power while another person was still working.'],
         shots=[('card', 'hook', 4.5), ('take', 0.0, 6.0, None, 1.0)]),
    dict(lines=['Every plant has lockout rules. Each technician puts a personal lock on the switch.',
                'But accidents still happen.',
                'A lock is missing. The wrong circuit gets switched on.',
                'Or someone just assumes the job is done.',
                'The person at the switch often cannot see the person at risk.'],
         shots=[('card', 'problem', 5.0), ('take', 6.2, 11.0, None, 0.7), ('take', 11.2, 16.0, None, 1.0)],
         tags=[(5.5, 6.0, 'Main disconnect: lockout hasp empty'), (12.5, 4.0, 'No line of sight to the hoist')]),
    dict(lines=['Sentinel adds one more check, right before power comes back.',
                'A camera looks at the work zone.',
                "Meta's SAM 3.1 finds any person in the image.",
                'If someone is there, or if the system is not sure, it does not energize. It warns you.'],
         shots=[('card', 'title', 4.5), ('take', 16.0, 18.5, None, 1.0), ('take', 18.4, 18.5, 'cam', 1.0, 4.0),
                ('take', 18.4, 18.5, 'verdict', 1.0, 4.0)],
         tags=[(7.2, 3.8, 'CAM-01 watches the work zone'), (11.0, 4.0, 'Person or unknown ⇒ no energize')]),
    dict(lines=['The operator presses Energize.',
                'The virtual PLC asks CAM-01 for a fresh frame — real rendered pixels, with a SHA-256 fingerprint.',
                'SAM 3.1 segments the person. A simple rule checks where the feet are.',
                'Inside the zone. Power stays off.',
                'And the frame, the model output and the decision are saved as evidence.'],
         shots=[('take', 19.1, 22.4, None, 1.0), ('take', 22.4, 24.7, 'panel', 1.0),
                ('take', 24.7, 26.4, 'evidence', 1.0, 4.5), ('take', 26.4, 31.4, 'verdict', 1.0)],
         tags=[(3.4, 2.2, 'ENERGIZE ⇒ new human authorization'), (5.7, 6.0, 'SAM 3.1 output · foot point IN ZONE'),
               (11.9, 4.5, 'Blocked · frame + output saved as evidence')]),
    dict(lines=["At the same moment, a warning goes to the technician's watch.",
                "Then Meta's Muse Spark looks at the same frame. It writes the alert for the technician, "
                'and tells the operator why power stayed off.',
                'Spark explains. It never decides.'],
         shots=[('take', 27.3, 31.0, None, 1.0), ('take', 31.0, 36.5, 'watch', 1.0),
                ('take', 36.5, 40.0, 'watch', 1.0), ('take', 40.0, 43.5, 'verdict', 1.0)]),
    dict(lines=['The technician steps out.',
                'Energizing needs a new human request — nothing ever starts by itself.',
                'SAM still sees the person, but outside the zone. Now power is allowed.'],
         shots=[('take', 33.6, 36.4, None, 1.0), ('take', 36.4, 38.5, 'panel', 1.0),
                ('take', 38.5, 40.3, 'evidence', 1.0, 1.5), ('take', 40.3, 50.4, None, 1.0)],
         tags=[(2.9, 2.0, 'New request, new authorization'), (5.0, 3.3, 'Person outside the zone ⇒ allowed'),
               (8.4, 5.0, 'Energized · the crane moves')]),
    dict(lines=['And if the camera fails, Sentinel does not guess.',
                'Not knowing is never treated as safe.'],
         shots=[('take', 52.5, 55.2, None, 1.0), ('take', 55.2, 60.5, 'verdict', 1.0)],
         tags=[(2.9, 5.0, 'No camera ⇒ UNKNOWN ⇒ blocked')]),
    dict(lines=['Everything here was built during the hackathon:',
                'a 3D digital twin, a deterministic virtual PLC, and SAM 3.1 and Muse Spark through the Meta Model API —',
                'one request at a time, with a hard spending cap.',
                "The model never sees the simulator's answers. Only pixels."],
         shots=[('card', 'built', 10.0), ('take', 29.0, 29.1, 'evidence', 1.0, 5.0)],
         tags=[(10.2, 4.6, 'The model gets pixels, never the simulator truth')]),
    dict(lines=['It does not replace the lock. It looks before you power.'],
         shots=[('card', 'end', 6.0)]),
]


def run(args):
    subprocess.run(args, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)


def duration(path):
    out = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', str(path)],
                         check=True, capture_output=True, text=True).stdout
    return float(out.strip())


def clean_voice(src, dst):
    # Graves fuera, ruido de fondo, pausas largas acortadas, volumen parejo.
    # VOICE_DENOISE=0 para voz sintética: el filtro de ruido la deja metálica.
    denoise = 'afftdn=nf=-25,' if os.environ.get('VOICE_DENOISE', '1') != '0' else ''
    # VOICE_EQ: filtros extra antes del resto (ej. presencia para una voz opaca).
    eq = os.environ.get('VOICE_EQ', '')
    af = ('highpass=f=80,' + (eq + ',' if eq else '') + denoise +
          'silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.1:'
          'stop_periods=-1:stop_duration=0.45:stop_threshold=-45dB,'
          f"atempo={os.environ.get('VOICE_TEMPO', '1.0')},loudnorm=I=-16:TP=-2:LRA=11")
    run(['ffmpeg', '-y', '-i', str(src), '-af', af, '-ar', '48000', '-ac', '1', str(dst)])


def shot_len(s):
    if s[0] == 'card':
        return s[2]
    _, a, b, _, speed, *hold = s
    return (b - a) / speed + (hold[0] if hold else 0.0)


def render_shot(s, extra, path):
    """extra: segundos de más (último cuadro sostenido); + XFADE para el fundido con el siguiente."""
    if s[0] == 'card':
        d = s[2] + extra
        run(['ffmpeg', '-y', '-loop', '1', '-t', f'{d:.3f}', '-i', str(CARDS / f'{s[1]}.png'),
             '-vf', f'fps={FPS},format=yuv420p,fade=in:d=0.35,fade=out:st={d - 0.35:.3f}:d=0.35',
             '-c:v', 'libx264', '-crf', '16', '-pix_fmt', 'yuv420p', '-video_track_timescale', '15360', str(path)])
        return
    _, a, b, crop, speed, *hold = s
    hold_s = (hold[0] if hold else 0.0) + extra
    vf = []
    if crop:
        w, h, x, y = CROP[crop]
        vf.append(f'crop={w}:{h}:{x}:{y}')
    vf.append('scale=1920:1080:flags=lanczos')
    if speed != 1.0:
        vf.append(f'setpts=PTS/{speed}')
    vf.append(f'fps={FPS}')
    if hold_s > 0:
        vf.append(f'tpad=stop_mode=clone:stop_duration={hold_s:.3f}')
    if hold_s > 0 and ZOOM_PUSH:
        # Lo sostenido no queda muerto: acercamiento lento sobre todo el plano
        # (escala 2x antes del zoompan para que no tiemble).
        n = round(((b - a) / speed + hold_s) * FPS)
        vf += ['scale=3840:2160:flags=lanczos',
               f"zoompan=z='1+{ZOOM_PUSH}*on/{n}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1920x1080:fps={FPS}"]
    vf.append('format=yuv420p')
    run(['ffmpeg', '-y', '-ss', f'{a:.3f}', '-to', f'{b:.3f}', '-i', str(TAKE), '-an', '-vf', ','.join(vf),
         '-c:v', 'libx264', '-crf', '16', '-video_track_timescale', '15360', str(path)])


def ass_time(t):
    h, rem = divmod(t, 3600)
    m, s = divmod(rem, 60)
    return f'{int(h)}:{int(m):02d}:{s:05.2f}'


def ass_escape(t):
    return t.replace('\\', '\\\\').replace('{', '(').replace('}', ')')


def main():
    video_clips, audio_parts, section_audio, events = [], [], [], []
    t = 0.0
    for i, sec in enumerate(SECTIONS, 1):
        base = sum(shot_len(s) for s in sec['shots'])
        voice = None
        if VOICE:
            found = sorted(p for p in VOICE.glob(f'{i:02d}.*') if p.suffix != '.json')
            if found:
                voice = WORK / f'voice-{i:02d}.wav'
                clean_voice(found[0], voice)
        words = sum(len(l.split()) for l in sec['lines'])
        speech = duration(voice) if voice else words / 2.6
        lead = 0.4  # la voz entra un poco después del corte
        total = max(base, speech + lead + 0.6)
        extra = total - base
        for j, s in enumerate(sec['shots']):
            p = WORK / f's{i:02d}-{j:02d}.mp4'
            nominal = shot_len(s) + (extra if j == len(sec['shots']) - 1 else 0.0)
            last = i == len(SECTIONS) and j == len(sec['shots']) - 1
            render_shot(s, nominal - shot_len(s) + (0.0 if last else XFADE), p)
            video_clips.append((p, nominal))
        # Pista de la sección, con su duración exacta: la voz entra en `lead`.
        part = WORK / f'a{i:02d}.wav'
        if voice:
            audio_parts.append(voice)
            run(['ffmpeg', '-y', '-i', str(voice), '-af',
                 f'adelay={int(lead * 1000)},apad=whole_dur={total:.3f},atrim=0:{total:.3f}',
                 '-ar', '48000', '-ac', '1', str(part)])
        else:
            run(['ffmpeg', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-t', f'{total:.3f}', str(part)])
        section_audio.append(part)
        # Subtítulos: con <NN>.lines.json (inicio y fin de cada frase en la voz) van
        # exactos; si no, cada frase ocupa su parte de la voz según sus palabras.
        spans = VOICE / f'{i:02d}.lines.json' if VOICE else None
        subs = VOICE / f'{i:02d}.subs.json' if VOICE else None
        if subs and subs.exists():
            # Tramos cortos con la hora de sus palabras: entran y salen con la voz,
            # sin pisarse con el siguiente.
            rows = json.loads(subs.read_text())
            for k, (a, b, text) in enumerate(rows):
                a = max(a, rows[k - 1][1]) if k else a
                b = min(b + 0.15, rows[k + 1][0]) if k + 1 < len(rows) else b + 0.3
                events.append(('Sub', t + lead + a, t + lead + b, text.lstrip('— ').rstrip(' —')))
        elif spans and spans.exists():
            for line, (a, b) in zip(sec['lines'], json.loads(spans.read_text())):
                events.append(('Sub', t + lead + a, t + lead + b + 0.25, line))
        else:
            cursor = t + lead
            for line in sec['lines']:
                d = speech * len(line.split()) / words
                events.append(('Sub', cursor, cursor + d, line))
                cursor += d
        for (at, d, text) in sec.get('tags', []):
            events.append(('Tag', t + at, t + at + d, text))
        t += total

    # Entre secciones tampoco se pisan: cada subtítulo termina cuando empieza el siguiente.
    subs = sorted((e for e in events if e[0] == 'Sub'), key=lambda e: e[1])
    for k in range(len(subs) - 1):
        st, a, b, x = subs[k]
        subs[k] = (st, a, min(b, subs[k + 1][1]), x)
    for k in range(len(subs) - 1):
        st, a, b, x = subs[k]
        if subs[k + 1][1] - b < 0.6:
            subs[k] = (st, a, subs[k + 1][1], x)
    fades = {}
    for k, e in enumerate(subs):
        fin = 0 if k and e[1] - subs[k - 1][2] < 0.05 else 150
        fout = 0 if k + 1 < len(subs) and subs[k + 1][1] - e[2] < 0.05 else 150
        fades[id(e)] = (fin, fout)
    events = subs + [e for e in events if e[0] != 'Sub']

    # Fundidos cortos entre planos: cada clip trae XFADE de más, así que la
    # línea de tiempo nominal (y la voz) no se corre.
    silent = WORK / 'silent.mp4'
    cmd = ['ffmpeg', '-y']
    for p, _ in video_clips:
        cmd += ['-i', str(p)]
    if not XFADE:
        concat = WORK / 'concat.txt'
        concat.write_text(''.join(f"file '{p.resolve()}'\n" for p, _ in video_clips))
        cmd = ['ffmpeg', '-y', '-f', 'concat', '-safe', '0', '-i', str(concat), '-c', 'copy', str(silent)]
    graph, prev, offset = [], '[0:v]', 0.0
    for k in range(1, len(video_clips)):
        offset += video_clips[k - 1][1]
        out = f'[x{k}]'
        graph.append(f'{prev}[{k}:v]xfade=transition=fade:duration={XFADE}:offset={offset:.3f}{out}')
        prev = out
    if XFADE:
        cmd += ['-filter_complex', ';'.join(graph), '-map', prev, '-c:v', 'libx264', '-crf', '16',
                '-pix_fmt', 'yuv420p', str(silent)]
    run(cmd)

    ass = WORK / 'subs.ass'
    ass.write_text('\n'.join([
        '[Script Info]', 'ScriptType: v4.00+', 'PlayResX: 1920', 'PlayResY: 1080', '',
        '[V4+ Styles]',
        'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, '
        'Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, '
        'MarginR, MarginV, Encoding',
        'Style: Sub,Barlow Semi Condensed SemiBold,50,&H00FFFFFF,&H00FFFFFF,&H00141819,&H96141819,0,0,0,0,100,100,0,0,'
        '3,14,0,2,220,220,48,1',
        'Style: Tag,Barlow Condensed,58,&H00141819,&H00141819,&H001AA2E3,&H001AA2E3,1,0,0,0,100,100,0.5,0,'
        '3,18,0,7,60,60,60,1',
        '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
        *[f'Dialogue: 0,{ass_time(e[1])},{ass_time(e[2])},{e[0]},,0,0,0,,'
          f'{{\\fad({fades.get(id(e), (180, 180))[0]},{fades.get(id(e), (180, 180))[1]})}}{ass_escape(e[3])}'
          for e in events],
    ]) + '\n')

    vf = f"subtitles={ass}:fontsdir={FONTS}"
    cmd = ['ffmpeg', '-y', '-i', str(silent)]
    if audio_parts:
        alist = WORK / 'audio.txt'
        alist.write_text(''.join(f"file '{p.resolve()}'\n" for p in section_audio))
        track = WORK / 'voice-track.wav'
        run(['ffmpeg', '-y', '-f', 'concat', '-safe', '0', '-i', str(alist), '-c', 'copy', str(track)])
        cmd += ['-i', str(track), '-filter_complex', f'[0:v]{vf}[vout]', '-map', '[vout]', '-map', '1:a',
                '-c:a', 'aac', '-b:a', '192k']
    else:
        cmd += ['-vf', vf]
    cmd += ['-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
            '-t', f'{t:.3f}', str(OUT)]
    run(cmd)
    (OUT.parent / 'timeline.json').write_text(json.dumps(
        [{'style': st, 'start': round(a, 2), 'end': round(b, 2), 'text': x} for st, a, b, x in events], indent=1))
    print(f'{OUT} {t:.1f}s voice={len(audio_parts)}/8')


if __name__ == '__main__':
    try:
        main()
    except subprocess.CalledProcessError as e:
        sys.stderr.write(e.stderr.decode(errors='replace')[-2000:])
        sys.exit(1)
