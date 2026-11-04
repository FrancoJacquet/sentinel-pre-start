# Provenance

- **Event:** Meta Global AI Developer Hackathon, Oct 26 – Nov 4, 2026, Indie
  Developer track.
- **Started:** the project repository was created on 2026-10-26 (22:56 ART).
  Every line of code here was written during the hackathon.
- **Author:** Franco Jacquet. Development was done with AI coding assistants
  under his direction; he made the design decisions and reviewed the results.
- **History:** this public repository is published as a single snapshot of the
  hackathon work. The development history lives in a private repository with
  internal notes that are not part of the submission.

## Prior work (research only, not reused)

Before the hackathon there was a private research prototype exploring the same
idea (digital twin + virtual PLC + visual perception). **No code was copied
from it.** What carried over is knowledge — what was worth trying and what
failed — not code.

## Use of Meta models

Every real call is recorded with its evidence.

| Date | Model | Requests | Cost (USD) | Evidence |
|---|---|---|---|---|
| 2026-11-03 | `sam-3.1` (Standard, `store:false`) | 1 | 0.0025 (estimated; promotional credits) | input `ef303af04d7ec237…`, output `eb4c76d4856e55e4…` — [`docs/meta/results/`](docs/meta/results/) |
| 2026-11-03/04 | `sam-3.1`, live in the app while recording the demo video | 18 | 0.045 (estimated; promotional credits) | request counter `evidence/meta-spend.json` (local, not published) |
| 2026-11-04 | `muse-spark-1.3` (Standard, `store:false`), live in the app after each decision | 8 (5 answered, 3 `incomplete`) | < 0.10 (estimated; promotional credits) | request counter `evidence/meta-spark-spend.json` (local, not published) |

## Third parties

3D assets are CC0 and listed with their sources in
[`docs/ASSET-LICENSES.md`](docs/ASSET-LICENSES.md). No third-party video, real
camera footage or personal data is used. The demo video's narration is the
author's own voice, cleaned up and re-synthesized locally (F5-TTS). Background
music: "Tech Talk" by Kevin MacLeod (incompetech.com), CC BY 4.0.
