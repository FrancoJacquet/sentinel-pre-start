# Igual que subs.py, pero sobre la voz YA limpia de cada sección (work/voice-NN.wav,
# con las pausas recortadas): así los tiempos son los del audio final.
import sys, json, subprocess, numpy as np, torch
from transformers import pipeline
lines = json.load(open(sys.argv[1])); work, out_dir = sys.argv[2], sys.argv[3]
asr = pipeline('automatic-speech-recognition', model='openai/whisper-large-v3-turbo', torch_dtype=torch.float16, device='cuda:0')
def load(p):
    raw = subprocess.run(['ffmpeg', '-loglevel', 'error', '-i', p, '-ac', '1', '-ar', '16000', '-f', 'f32le', '-'], capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.float32)
def chunks(text, n=7):
    w = text.split(); k = max(1, round(len(w) / n)); size = -(-len(w) // k)
    return [' '.join(w[i:i + size]) for i in range(0, len(w), size)]
for s, sec in enumerate(lines, 1):
    a = load(f'{work}/voice-{s:02d}.wav')
    r = asr({'raw': a, 'sampling_rate': 16000}, return_timestamps='word', generate_kwargs={'language': 'en'})
    words = [(c['timestamp'][0], c['timestamp'][1] or c['timestamp'][0] + 0.3, c['text'].strip()) for c in r['chunks']]
    cum, acc = [], 0
    for _, _, w in words: acc += len(w) + 1; cum.append(acc)
    def at(frac, edge):
        i = next((j for j, c in enumerate(cum) if c >= frac * acc - 1e-6), len(words) - 1)
        return words[i][0] if edge == 'start' else words[i][1]
    parts = [p for text in sec for p in chunks(text)]
    total = sum(len(p) + 1 for p in parts); done, out = 0, []
    for part in parts:
        a_f = done / total; done += len(part) + 1
        out.append([round(at(a_f + 1e-3, 'start'), 3), round(at(done / total, 'end'), 3), part])
    json.dump(out, open(f'{out_dir}/{s:02d}.subs.json', 'w'), indent=0)
    print(s, round(len(a) / 16000, 2), out[-1])
