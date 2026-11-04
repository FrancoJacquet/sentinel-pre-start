#!/usr/bin/env python3
"""Suma la música de fondo a un video ya renderizado, sin tocar la imagen.

    python3 scripts/video/mix_music.py <video.mp4> <musica.mp3> <salida.mp4>

La música va a -30 LUFS y baja sola cuando hay voz (sidechain, ratio 6: con 3
la voz sonaba tapada); la
mezcla final queda a -16 LUFS. Pista usada en la demo: "Tech Talk" de Kevin
MacLeod (incompetech.com), CC BY 4.0.
"""
import subprocess
import sys

VIDEO, MUSIC, OUT = sys.argv[1:4]
d = float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', VIDEO],
                         check=True, capture_output=True, text=True).stdout)
graph = ('[0:a]aresample=48000,aformat=channel_layouts=stereo,asplit[v][sc];'
         f'[1:a]aresample=48000,aformat=channel_layouts=stereo,atrim=0:{d:.3f},loudnorm=I=-30:TP=-6,'
         f'afade=t=in:d=2,afade=t=out:st={d - 4:.3f}:d=4[m];'
         '[m][sc]sidechaincompress=threshold=0.03:ratio=6:attack=30:release=400[md];'
         '[v][md]amix=inputs=2:normalize=0:duration=first,loudnorm=I=-16:TP=-2[a]')
subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-i', VIDEO, '-stream_loop', '-1', '-i', MUSIC,
                '-filter_complex', graph, '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
                '-movflags', '+faststart', OUT], check=True)
print(OUT)
