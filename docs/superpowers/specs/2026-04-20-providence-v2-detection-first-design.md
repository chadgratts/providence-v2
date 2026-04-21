# Providence V2 — Detection-First Design

**Status:** Approved for implementation planning
**Date:** 2026-04-20
**Owner:** Garrett
**Time budget:** 1–2 days, AI-agent-built

---

## 1. Thesis

V1 (and the original Providence) are **investigation-first** products: the user must already suspect a problem to extract value. They ask questions, the tool answers from a corpus of session summaries.

V2 flips this. The primary output is a **detection dashboard**: a ranked list of sessions that need attention, with one-line evidence for each. Investigation tools (replay, LLM explainer, chatbot) are secondary drill-downs, reached *from* detection rather than replacing it.

> Detection is the product. Summaries support detection. The dashboard is the deliverable.

### Secondary divergence: cost and latency

V1 sends every captured session to the LLM twice (summarize + embed) before it can be queried via RAG. This is expensive per session, slow (5–10s summarization latency), and architecturally limiting — the LLM summary *is* the queryable representation of the session, so nothing can be asked about a session until it has been LLM-processed. V1 has no ranking at all; every session is treated as equally worth summarizing.

V2's ranking path is zero-LLM. Scoring runs in milliseconds on structured signals. The LLM is only invoked when a human opens a specific session's detail page — typically a small fraction of total sessions. This is roughly a 100× reduction in LLM spend and removes the processing-latency bottleneck between capture and ranking.

### Core assumption (load-bearing)

The one assumption V2's thesis rests on:

> A dumb weighted sum of six signal counts is a good-enough ranker to separate sessions worth investigating from sessions not worth investigating.

This is validated by the smoke test in §13 step 7 (a deliberately-buggy demo app whose "bad" sessions must rank above clean sessions). If the formula fails, weights get tuned or signals get added; the architecture does not change. If the formula fails *structurally* — i.e., no weight configuration produces useful rankings — V2 falls back to the V4 roadmap (a learned ranker) earlier than planned.

Four of the six signals (js_error, unhandled_rejection, failed_request 5xx/4xx) are captured directly at the source by the browser agent and do not depend on rrweb extraction. Rage-click and dead-click detection from rrweb events is industry-standard technique — not a research problem.

## 2. Non-goals

These are intentionally excluded from V2:

- **Summaries as primary output.** V1's `/multi-summary` and RAG chatbot are not rebuilt in V2's main path. V1 code remains on the shelf; individual pieces may be re-enabled as drill-downs if time permits.
- **User journey analysis.** V2 detects *things going wrong in a session*, not flow/conversion patterns.
- **Anomaly/novelty detection.** Requires a corpus V2 won't have. Deferred to V4+.
- **ML-based ranking.** No labels exist yet. Deferred to V4 (see §10).
- **Session replay UI.** The rrweb events are stored, but a replay player is out of scope.
- **Vector store, Redis, Qdrant.** Storage is plain JSON files on disk.
- **Authentication, multi-tenant, production hardening.** This is a single-user learning wedge.

## 3. Architecture

```
Browser                     Server (tsx, Express)              UI
┌──────────┐   events   ┌────────────────────────┐        ┌────────────────┐
│ agent.js │ ─────────▶ │  POST /capture         │        │ GET /          │
│  rrweb   │            │    ├─ Preprocessor     │        │  Ranked list   │
│  fetch   │            │    │   (typed signals) │        └────────────────┘
│  onerror │            │    ├─ Scorer           │        ┌────────────────┐
│  reject  │            │    │   (weighted sum)  │        │ GET /sessions/ │
└──────────┘            │    └─ Storage (JSON)   │        │       :id      │
                        │                        │        │  Signals +     │
                        │  GET  /                │        │  LLM explainer │
                        │  GET  /sessions/:id    │        └────────────────┘
                        └────────────────────────┘
```

All processing on `/capture` is synchronous: preprocess → score → persist. No queue, no background workers.

## 4. Components

| # | Component | Responsibility | Reuses V1? |
|---|---|---|---|
| 1 | `agent.js` | rrweb recording, fetch wrap, `window.onerror`, `window.onunhandledrejection`. POST event array to `/capture`. | Extends V1's agent (adds error + rejection hooks) |
| 2 | `src/preprocessor/` | Consumes raw events, emits typed `Signal[]`. **Evidence only, no interpretive labels.** | Ports V1's typed processors (Network, Mouse, Console); adds ErrorProcessor + RageDeadClickProcessor |
| 3 | `src/scorer.ts` | Pure function. `(Signal[]) ⇒ SessionScore`. Readable weighted formula. No LLM. | New |
| 4 | `src/storage.ts` | Writes `data/sessions.json` (index) and `data/sessions/<id>.json` (full record). | Simpler than V1's summaries-folder scan |
| 5 | `src/server.ts` | Express app: `/capture`, `/`, `/sessions/:id`. | Trimmed V1 server |
| 6 | `src/dashboard/` | Server-rendered HTML for ranked list. Vanilla, no React. | New |
| 7 | `src/detail/` | Server-rendered HTML for session detail; calls OpenAI for a grounded explainer. | Partly reuses V1's `ai.ts` OpenAI client setup |

## 5. Data shapes

### Signal (evidence emitted by preprocessor)

A discriminated union — each variant tagged by `kind`, carrying its own evidence fields.

```ts
type Signal =
  | { kind: 'js_error';           message: string; stack?: string; url?: string; ts: number }
  | { kind: 'unhandled_rejection'; reason: string; ts: number }
  | { kind: 'rage_click';          targetId: string; count: number; spanMs: number; ts: number }
  | { kind: 'dead_click';          targetId: string; ts: number }
  | { kind: 'failed_request';      url: string; method: string; status: number | 'network'; ts: number }
```

**Why raw fields (not just counts):** the session detail page quotes specific evidence ("rage click on `#checkout-btn`"). A counts map would throw this away. The scorer only reads `kind` + the list length per kind, so the extra fields cost it nothing.

### SessionScore (output of scorer)

```ts
type SessionScore = {
  score: number             // integer, unbounded
  bucket: 'high' | 'med' | 'low'
  topReasons: string[]      // e.g. ["3 JS errors", "rage click on button#checkout"]
}
```

Bucket thresholds: `high ≥ 60`, `med 30–59`, `low < 30`. These are starting values, tunable.

### SessionRecord (persisted)

```ts
type SessionRecord = {
  id: string                // e.g. "8a2f1c9e"
  startedAt: number         // unix ms
  durationMs: number
  url: string
  userAgent: string
  signals: Signal[]
  score: SessionScore
  rawEventCount: number     // we don't store all rrweb events in the record for size reasons
}
```

Raw rrweb events are stored separately under `data/sessions/<id>.events.json` so the record file stays small enough to quick-scan.

## 6. Scorer — weighted formula

```
severity =  25 × min(3, count(js_error))
          + 20 × min(3, count(unhandled_rejection))
          + 15 × min(3, count(rage_click_burst))
          + 10 × min(3, count(failed_request where status ≥ 500 or 'network'))
          +  8 × min(3, count(dead_click_burst))
          +  5 × min(3, count(failed_request where 400 ≤ status < 500))
```

Each signal caps at 3 occurrences so one runaway session can't dominate. Ties break by `startedAt` descending (most recent first).

`topReasons` are generated by rendering each non-zero contributor as a short string, sorted by weight descending, max 3 shown.

**Why a dumb formula:** the scorer is the product's opinion; it must be legible. A user looking at rank position 7 should be able to tell *why* it's there by reading the row. An LLM or ML model here would obscure that. This is also how the V4 ML ranker will be trained (§10): user feedback on formula-ranked output becomes training labels.

## 7. Signal definitions

- **`js_error`** — caught by `window.addEventListener('error', ...)`. Captures `message`, `filename`, `lineno`, `colno`, `error.stack`. One event per thrown error.
- **`unhandled_rejection`** — caught by `window.addEventListener('unhandledrejection', ...)`. Captures `reason` (stringified).
- **`rage_click_burst`** — ≥4 clicks on the same target element within 1000ms. Emitted once per burst with `count` and `spanMs`.
- **`dead_click_burst`** — a click with no DOM mutation within 300ms after. Detected by correlating rrweb MouseInteraction events with subsequent Incremental Snapshots.
- **`failed_request`** — fetch resolved with `status ≥ 400`, or rejected (network error). Captured by the existing V1 fetch wrapper extended with status bucketing.

Rage click and dead click heuristics will need tuning against real traffic; start with these thresholds, adjust if the signal/noise is wrong.

## 8. Dashboard

Single page, `GET /`.

- Server-rendered HTML, no client framework.
- Reads `data/sessions.json` index, sorts by `score` desc.
- Each row: colored dot (🔴 high / 🟠 med / 🟡 low), score, short session id, one-line `topReasons.join(' · ')`, relative timestamp.
- Row is a link to `/sessions/:id`.
- Auto-refresh: `<meta http-equiv="refresh" content="10">`. Ugly but zero-JS; acceptable for a wedge.
- No pagination, no filters, no search in V2. Top 50 rows, that's it.

See §11 mockup for visual reference.

## 9. Session detail page (with LLM)

`GET /sessions/:id`.

Shows:
1. **Header:** session id, url, duration, user agent, score, bucket.
2. **Evidence:** the raw `signals` list, rendered as a timeline. Each signal shows `kind`, key fields, and timestamp. No interpretation.
3. **LLM grounded explainer:** a ~150-word narrative produced by calling OpenAI with the `Signal[]` + a short DOM context window. Strict system prompt:
   - Must only reference signals in the input.
   - Must acknowledge uncertainty where evidence is ambiguous.
   - Must not invent causes.
   - Must not use narrative polish ("unfortunately the user…").
   - Format: plain prose, 1–3 short paragraphs.

The LLM's output is labeled **"Explainer (AI, grounded in signals above)"** so the user sees it as a summary *of* the evidence, not independent analysis.

This is the only LLM call in the primary V2 path. It's scoped to one session, fed structured evidence, and constrained to grounded output — avoiding V1's problem of LLMs narrating over raw rrweb.

## 10. Future roadmap (not V2 scope, documented for context)

**V3 — feedback capture.** Add 👍/👎 per dashboard row, "mark as real bug" button, track dwell time on detail pages. No scorer changes, just logging.

**V4 — learned ranker.** Replace the weighted formula with an XGBoost learning-to-rank model trained on V3's logged labels. Features = current signal counts + metadata (error-message novelty, URL path, time-of-day). Keep the weighted formula available as a fallback and as a baseline in evaluation.

**V5+ — embedding-based features.** Embed error messages and DOM context, cluster similar incidents, feed embeddings as features to the ranker. This is where LLMs and the ranker meet.

This roadmap exists so V2 choices don't accidentally box out V3/V4. Specifically: the `SessionRecord` shape preserves raw signals (needed for V4 feature extraction), and the dashboard is built as server-rendered HTML that can host feedback buttons without a framework rewrite.

## 11. Dashboard mockup (approved layout A)

```
Providence V2 — Sessions needing attention                  [auto-refresh 10s]
─────────────────────────────────────────────────────────────────────────────
🔴  94   session-8a2f   3 JS errors · rage click on #checkout-btn      2m ago
🔴  87   session-1c9e   dead click burst · failed POST /api/cart       4m ago
🟠  71   session-44d1   failed POST /checkout (500)                    8m ago
🟠  65   session-ff03   unhandled rejection                            12m ago
🟡  42   session-2b77   2 failed fetches                               18m ago
🟡  31   session-5a1d   dead click                                     25m ago
```

## 12. Stack

- **Language:** TypeScript throughout.
- **Server runtime:** `tsx` (same as V1 — no build step). V1's `agent.js` loads rrweb from a CDN; V2 keeps that approach, avoiding a bundler entirely.
- **Framework:** Express (matches V1).
- **Browser agent:** rrweb v2 from CDN, inline glue code in `agent.js`.
- **Storage:** JSON files under `./data/`. No SQLite in V2. (SQLite is a trivial upgrade later if queries get annoying.)
- **LLM:** OpenAI, single call on the detail page only. Model is `gpt-5-nano` (matches V1). No embeddings in V2.
- **Dashboard:** Server-rendered HTML with inline CSS. Zero client JS.

## 13. Build order

Estimated time in parentheses. Totals ~12 hours.

1. **Agent error + rejection capture** (1h) — extend V1's `agent.js` with `window.addEventListener('error', …)` and `'unhandledrejection'`; verify events arrive at `/capture`.
2. **Preprocessor + signal types** (3h) — port V1's Network/Mouse/Console processors into V2 shape; add ErrorProcessor and RageDeadClickProcessor. Unit-test each on fixture events.
3. **Scorer** (1h) — pure function, unit-tested against crafted signal lists.
4. **Storage + /capture wiring** (1h) — filesystem writes, index file maintenance, session id generation.
5. **Dashboard (ranked list)** (2h) — server-rendered HTML, auto-refresh, links to detail.
6. **Session detail page + LLM explainer** (2h) — signal timeline + grounded LLM call.
7. **Smoke test with a buggy demo app** (2h) — a small HTML page with deliberate bugs (throws, rage-click traps, dead click zones, failing endpoints). Confirms the full loop.
8. **Stretch: error-signature clustering** (2h, optional) — group repeated error messages on the dashboard using an LLM similarity call. Only if steps 1–7 finish with time left.

## 14. Open risks

- **Dead click detection** may be noisy — click handlers that only update state without mutating DOM will look like dead clicks. If noise is too high in smoke test, reduce the dead-click weight or drop the signal entirely.
- **Rage click thresholds** (≥4 clicks / 1000ms) are guesses. May need tuning.
- **LLM explainer hallucination risk** is mitigated by prompt + evidence grounding but not eliminated. The UI label "(AI, grounded in signals above)" is the honest hedge.
- **Auto-refresh** is a UX cop-out. If it feels bad during smoke test, the 30-minute path to improvement is polling `/sessions.json` with a tiny script tag.

## 15. Success criteria

V2 is considered successful when:

1. A smoke test session that throws a JS error, rage-clicks a trap, and hits a 500 endpoint appears at or near rank #1 on the dashboard within 10 seconds.
2. A clean session with no signals does not appear in the top 50.
3. Clicking a row loads a detail page where the LLM explainer accurately names the signals present, without inventing causes not in the evidence.
4. Total build time fits inside 2 days.
