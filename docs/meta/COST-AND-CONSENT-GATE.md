# Cost and consent gate — Meta Model API

Rule: **no request leaves for Meta without an explicit decision by the person
paying, every time.** Promotional credits are a balance, not a budget, and
billing alerts are not a cap: a charge can go past them. So the cap lives in
the code.

## What stops spending (all covered by tests with an injected `fetch`)

| Control | Where | Covered by |
|---|---|---|
| `META_API_ENABLED=false` (default) ⇒ `DisabledAdapter`; key and cap are ignored; every start request is UNKNOWN ⇒ blocked | `apps/api/src/config.ts`, `adapter.ts` | `config.test.ts`, `adapter.test.ts` |
| `META_API_ENABLED=true` without a non-empty `MODEL_API_KEY` or an integer `META_MAX_REQUESTS` in 1–200 ⇒ **the API refuses to start**; the message names the variable, never the value | `config.ts` | `config.test.ts` |
| Persistent counter `<EVIDENCE_DIR>/meta-spend.json`: a request is counted **before** it is sent and never refunded, even if it fails | `perception/meta/spend-guard.ts` | "a failed request still counts" |
| Cap reached ⇒ `BUDGET_EXHAUSTED`, also after a restart; unreadable counter ⇒ error, never treated as zero | idem | "survives restart", "unreadable counter" |
| One request at a time, **no automatic retries** | adapter + `gateway.ts` | "concurrency 1", "no retry" |
| Frame from another scene, camera or size ⇒ `UNVERIFIED` without spending | adapter | "other scene revision" |
| Standard mode only (`sam-3.1`, `muse-spark-1.3`), never a `-contributor` model; `store:false` | adapters | "Responses API request" |
| A Meta error body is never copied; only the HTTP status | adapters | "meta http 500" |
| The key lives only in the backend `.env`; never in the browser, logs, evidence files or git | — | key-sentinel tests in `spark-explainer.test.ts`, `server.test.ts` |

## SAM 3.1 — the perception step

| | |
|---|---|
| Endpoint | `POST https://api.meta.ai/v1/responses`, `Authorization: Bearer $MODEL_API_KEY` |
| Request | `input_text: "person"`, `input_image: data:image/jpeg;base64,…` (the CAM-01 frame, 1280×720), `stream:false`, `store:false` |
| Cost | **US$0.0025** per start request (1 image at US$2.50 per 1,000). Example: cap 40 ⇒ at most US$0.10 |
| What counts | each start request with the camera connected and a valid frame of the current scene |
| Failure | `MODEL_ERROR` ⇒ no energize |
| UI | `perception.state.overlay`: SAM's real boxes, foot points, `inZone` and the calibrated polygon. Once the result is older than `FRESHNESS_TTL_MS` the live overlay goes `null`; the evaluated frame keeps it only labeled "expired — not live" |

## Muse Spark 1.3 — communicates after the decision, never decides

Off by default. Called for real 8 times on Nov 4, 2026 (see
[`RESULTS.md`](RESULTS.md)); everything below is also tested with an injected `fetch`.

| | |
|---|---|
| Switch | `META_SPARK_ENABLED=false` by default. `true` requires `META_API_ENABLED=true`, `MODEL_API_KEY` and `META_SPARK_MAX_REQUESTS` (1–200), or the API refuses to start |
| When | after the virtual PLC has already decided, in the background, only if SAM made a model observation (`RISK_OBSERVED` / `NO_RISK_OBSERVED`) on that frame. The PLC never waits for it |
| Input | the same JPEG, the zone polygon and the decision already taken (blocked / allowed) — **not** SAM's boxes, never the simulator's truth. Strict JSON `{"explanation": ≤200 chars, "technician_alert": ≤140 chars or null, "person_in_zone_visible": boolean}`; `max_output_tokens: 4096` (at 300 and at 2,048 some real calls came back `incomplete`: Spark reasons inside that cap) |
| Role | it cannot change the status, the timestamp, the overlay or the PLC. If its own "person in the zone?" disagrees with SAM, that is recorded as a note in the evidence and SAM's decision stands |
| Technician's watch (simulated) | when a start is blocked because SAM saw a person in the zone, `wearable.notify` goes out **at once** with a fixed warning (`source: template`). If Spark then writes a `technician_alert` for that same frame, a second message with the same `notificationId` replaces the text (`source: muse-spark-1.3`). Reassuring texts ("safe", "all clear", "you can"…) are dropped and the fixed warning stays. Never sent on "clear" or on UNKNOWN |
| If Spark fails | HTTP error, timeout (`SPARK_TIMEOUT_MS`, default 20 s), cap reached, `incomplete` or bad JSON ⇒ only the fixed warning, no explanation; the reason goes to the evidence |
| Cap | its own counter `<EVIDENCE_DIR>/meta-spark-spend.json`, same rules as SAM |
| Cost | estimated **< US$0.02** per call (US$1.25 / M input tokens, US$4.25 / M output; Meta does not publish how many tokens a 1280×720 image counts as) |
| UI | the watch on the technician's wrist in the 3D scene lights amber and pulses, with a callout; a "Technician's watch — simulated wearable" block in the panel; Spark's operator explanation under the evaluated frame as `decision evidence — not live · Muse Spark 1.3 · explained HH:MM:SS — …` |
| Evidence | `evaluation.spark` (prompt, raw output, texts, boolean, failure reason, requests used) and `evaluation.wearable` (each notification sent) in the frame's JSON |

## Turning it on

```bash
# in .env (never committed): MODEL_API_KEY=...
META_API_ENABLED=true META_MAX_REQUESTS=40 pnpm dev:api
# plus Muse Spark:
META_API_ENABLED=true META_MAX_REQUESTS=40 META_SPARK_ENABLED=true META_SPARK_MAX_REQUESTS=15 pnpm dev:api
```

Afterwards: turn it off, read `requests` from the counter files and check
Usage/Billing in the Meta Model API console.
