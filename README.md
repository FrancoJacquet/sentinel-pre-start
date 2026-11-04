# Sentinel AI — Pre-Start Intelligence

**Demo video (2 min):** https://youtu.be/TcWZ4PX6Rgw

**Look before you power.** People still die because someone restored power
while another person was still working on the machine: a padlock was missing,
the wrong circuit was switched on, or someone assumed the job was done. The
person at the switch often cannot see the person at risk.

Sentinel is a 3D digital twin of a small factory bay where a technician is
servicing an overhead crane hoist and an operator stands at the crane's main
disconnect, behind a rack, with no line of sight to the hoist. When the
operator presses **ENERGIZE**, a virtual security camera (CAM-01) captures the
work zone, Meta's **SAM 3.1** segments the people it sees in the *rendered
pixels*, a deterministic rule checks whether anyone is standing in the work
zone, and a **virtual PLC** refuses to energize unless perception is fresh,
valid and clear — and a human has just authorized that specific request.

Energizing is a discrete act, so a ~2.4 s check before it is acceptable — unlike
continuous monitoring of a moving machine, where that latency would be too late.

> **This is a simulation, not a safety system.** Nothing here drives real
> hardware. Real industrial interlocks are always independent of AI. Sentinel
> explores an *advisory* extra check that adds to lockout/tagout and never
> replaces a personal padlock; it is not certified and must never be described
> as such.

Built for the Meta Global AI Developer Hackathon (Oct 26 – Nov 4, 2026),
Indie Developer track. **Problem statement: Build for Your World** — I build
software for factories in Argentina, and lockout accidents are a problem I
know first-hand.

## What actually happens on every start request

```
ENERGIZE ──▶ VirtualPLC: START_REQUESTED (new authorizationId, never reused)
                    │
                    ▼
            PerceptionGateway ── frame.request ──▶ browser renders CAM-01
                    ◀── frame.capture (JPEG 1280×720, SHA-256, sceneRevision)
                    │   evidence store: JPEG + JSON (simulator truth stored apart, labeled SIMULATION)
                    ▼
            SAM 3.1 (Meta Model API, prompt "person") ──▶ boxes + masks
                    ▼
            zone rule: foot point of each person box inside the calibrated
            zone polygon? ──▶ RISK_OBSERVED | NO_RISK_OBSERVED
                    ▼
            VirtualPLC: ENABLED only on fresh NO_RISK_OBSERVED; anything else
            (no camera, capture failed, model error, stale, budget, disabled)
            is UNKNOWN ⇒ BLOCKED
```

- **The model never sees simulator coordinates.** It gets pixels. The
  simulator's ground truth ("is the worker in the zone?") is stored next to
  the evidence only to *measure* the model, never to replace it.
- **UNKNOWN is never safe.** Camera unplugged, capture timeout, model error,
  stale result (`FRESHNESS_TTL_MS`), budget exhausted, inference disabled —
  all block.
- **No auto-start.** Clearing a condition never starts anything; every start
  needs a new human authorization. A stop that arrives while perception is
  still evaluating wins over the result. The panel's e-stop latches until
  reset and reset does not start anything — in this demo that latch lives in
  the UI, not in the virtual PLC.

## How Meta models are used

| Piece | Meta model | Why |
|---|---|---|
| Person segmentation on the rendered CAM-01 frame | `sam-3.1` via the Responses API (`POST https://api.meta.ai/v1/responses`) | Pixel-accurate, auditable geometry: we draw the box, the foot point and the zone polygon over the exact frame that was evaluated |
| Warnings in plain words, after the decision: an alert for the technician's (simulated) watch and an explanation for the operator | `muse-spark-1.3` (Standard mode) via the same Responses API | Runs **after** the PLC has decided, in the background, on the same JPEG plus the zone polygon and the decision already taken (never SAM's boxes, never the simulator truth). **It communicates, it never decides**: it cannot change the status or the PLC. When a start is blocked because a person was seen, a fixed warning goes to the technician's watch at once; Spark's own alert replaces it seconds later. Its operator explanation is shown under the evaluated frame, labeled as decision evidence, not live. Reassuring watch texts ("safe", "you can"…) are dropped. If Spark fails, the fixed warning stays. Own request cap and ledger; off by default (`META_SPARK_ENABLED=false`) |

Standard mode only (content not used for training), `store: false`, one
request at a time, no automatic retries, a persistent request counter with a
hard cap, and the API key lives only in the backend `.env`. Details:
[`docs/meta/MODEL-API-RESEARCH.md`](docs/meta/MODEL-API-RESEARCH.md) and
[`docs/meta/COST-AND-CONSENT-GATE.md`](docs/meta/COST-AND-CONSENT-GATE.md).

**Status:** the SAM 3.1 adapter, output parser, zone rule and spend guard are
implemented and unit-tested with an injected `fetch`, and **off by default**
(`META_API_ENABLED=false`). First real call (Nov 3, 2026): SAM found the
worker under the load, foot point inside the zone ⇒ `RISK_OBSERVED`, matching
the simulator. Details and raw output: [`docs/meta/RESULTS.md`](docs/meta/RESULTS.md).
The demo video runs SAM and Muse Spark live inside the app (Nov 4, 2026):
18 SAM requests in all under a hard cap of 40, and 8 Spark requests under a
cap of 15.

**Measured so far:** SAM's verdict matched the simulator's ground truth on
**19 of 19** real requests (10 with the worker inside the zone, 9 outside).
Muse Spark answered 5 of 8 calls; the other 3 came back `incomplete` because
its reasoning ran out of output tokens (2 at a 300-token cap, 1 at 2,048; the
cap is now 4,096 and the last 2 calls were complete). In all 5 answers Spark's
own "person in the zone?" matched SAM, and it took about 10–13 s — which is
why it runs after the decision, not in front of it. A small sample of one
scene and two positions: it shows the pipeline works end to end, not that it
generalizes.

## Run it

Requirements: Node 24.12+, pnpm 11.

```bash
pnpm install
node scripts/fetch-assets.mjs      # CC0 3D assets (~50 MB), SHA-256 verified
cp .env.example .env               # META_API_ENABLED=false by default
pnpm dev:api                       # WebSocket API on :4710
pnpm dev:web                       # web UI on :4711
```

Open `http://127.0.0.1:4711`. Set `HUB_HOST` to the interface(s) to bind
(default `127.0.0.1`); binding to `0.0.0.0` is refused on purpose.

With the default `.env` no request goes to Meta, so **every ENERGIZE is
blocked as UNKNOWN (inference disabled)** — that is the safe default, not a
bug. To see SAM live, put your own key in `.env` (`MODEL_API_KEY`) and start
the API with `META_API_ENABLED=true META_MAX_REQUESTS=<N>`; see
[`docs/meta/COST-AND-CONSENT-GATE.md`](docs/meta/COST-AND-CONSENT-GATE.md).

Tests: `pnpm test` (unit + WebSocket integration), `pnpm typecheck`,
`pnpm e2e` (Playwright; works without a GPU, slower).

## Layout

- `apps/web` — Vue 3 + Babylon.js: the bay, crane, technician (with a simulated smartwatch on the wrist), work zone, CAM-01, main disconnect panel and the SAM overlay drawn on the evaluated frame.
- `apps/api` — Node + TypeScript: WebSocket server, VirtualPLC, PerceptionGateway,
  Meta SAM adapter, optional Muse Spark communicator (after the decision), simulated wearable notifications, zone rule,
  spend guards, evidence store.
- `packages/contracts` — versioned WebSocket messages (zod).
- `tests/e2e` — Playwright.
- `scripts/record-demo.mjs`, `scripts/video/` — how the demo video was made:
  screen recording of the app (`?video=1` hides debug details), a
  [HyperFrames](https://github.com/heygen-com/hyperframes) composition with
  hard cuts and word-timed subtitles, and the background-music mix.

## Provenance and licenses

All code was written during the hackathon, from Oct 26, 2026
([`PROJECT_PROVENANCE.md`](PROJECT_PROVENANCE.md)). 3D assets are CC0
(Poly Haven, Quaternius) and listed in
[`docs/ASSET-LICENSES.md`](docs/ASSET-LICENSES.md). No third-party video
or real camera footage is used. The narration is the author's own voice,
re-synthesized locally with F5-TTS. Music: "Tech Talk" by Kevin MacLeod
([incompetech.com](https://incompetech.com)), licensed under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Code: [MIT](LICENSE).
