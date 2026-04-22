# Providence V2 — Replay Patch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an rrweb replay player to the existing V2 session detail page, with click-to-seek wiring and a cleanup pass on signal summary text. No new product architecture — this is a patch.

**Architecture:** New server route `GET /sessions/:id/events` exposes the already-stored raw rrweb events as JSON. `src/views/detail.ts` is restructured into three CSS-grid zones (header / signals-sidebar + player / explainer). An inline `<script type="module">` loaded from the rendered HTML imports `rrweb-player` from a CDN, fetches events, mounts the player, and attaches a delegated click handler that reads `data-ts` attributes off signal rows to seek the replay.

**Tech Stack:** TypeScript, tsx, Express (all already installed). `rrweb-player@2.0.0-alpha.11` loaded from jsDelivr CDN at runtime (matches the agent's rrweb version; no bundler or new npm deps). Existing `createStorage(dataDir)` already exposes `getRawEvents(id)`.

**Spec:** [2026-04-22-v2-replay-patch-design.md](../specs/2026-04-22-v2-replay-patch-design.md)

---

## File Structure

```
providence-v2/
├── src/
│   ├── server.ts            ← Task 1: +1 route (GET /sessions/:id/events)
│   ├── views/
│   │   └── detail.ts        ← Task 2: signalSummary() text cleanup
│   │                        ← Task 3: renderDetail() layout + player + click-to-seek
│   └── (everything else unchanged)
└── (everything else unchanged)
```

Three changes, two files touched, one logical patch. Each task produces a working deployable state on its own.

---

## Task 1: Add `/sessions/:id/events` route

**Files:**
- Modify: `src/server.ts` (add one route before the existing `/sessions/:id` route)

The route exposes already-stored raw rrweb events as JSON so the detail page's client script can fetch them. `storage.getRawEvents(id)` already returns `RawEvent[]`; this is purely an HTTP surface.

- [ ] **Step 1: Edit `src/server.ts`**

Find this block (currently at ~line 64):

```ts
// Session detail — signal timeline + grounded LLM explainer.
app.get('/sessions/:id', async (req, res) => {
  const record = await storage.getSession(req.params.id);
  if (!record) return res.status(404).send('Not found');
  res.set('Content-Type', 'text/html').send(await renderDetail(record));
});
```

Insert this new route **immediately above** it:

```ts
// Raw rrweb events for a session — consumed by the detail page's replay player.
app.get('/sessions/:id/events', async (req, res) => {
  const events = await storage.getRawEvents(req.params.id);
  res.json(events);
});

```

Order matters: Express matches routes in registration order. The events route must register before `/sessions/:id` to avoid being shadowed by it. Express 4 with `:id` as a path param actually wouldn't shadow `/sessions/:id/events` (the paths differ in structure) but registering specific-before-general is the safe habit.

- [ ] **Step 2: Start the server and verify the new route**

Run in one terminal:

```bash
lsof -ti:4000 | xargs -r kill 2>/dev/null; sleep 1
PORT=4000 npm start
```

In another terminal, capture a session and hit the new route:

```bash
# Post a small synthetic session
RESP=$(curl -sX POST http://localhost:4000/capture -H 'Content-Type: application/json' -d '[
  {"type":51,"timestamp":1000,"data":{"url":"http://test","userAgent":"X"}},
  {"type":52,"timestamp":2000,"data":{"message":"boom"}}
]')
echo "$RESP"

# Extract id and GET its events
SID=$(echo "$RESP" | node -e "process.stdin.once('data', d => process.stdout.write(JSON.parse(d).id))")
echo "--- GET /sessions/$SID/events ---"
curl -s http://localhost:4000/sessions/$SID/events
```

Expected: the GET returns the exact two-element event array you just posted, as JSON.

- [ ] **Step 3: Stop the server and commit**

```bash
lsof -ti:4000 | xargs -r kill 2>/dev/null
git add src/server.ts
git commit -m "feat: GET /sessions/:id/events route for replay player"
git push origin main
```

---

## Task 2: Drop `target #N` from signal summary text

**Files:**
- Modify: `src/views/detail.ts` (edit the `signalSummary()` function at ~line 34)

Rrweb's internal node ids (e.g., `#27`) are meaningless to the user and become redundant once the replay player is visible — the replay shows which element was clicked. Stripping them from the text is a pure readability win and has no functional effect on the rest of the system (the ids are still in the underlying `Signal` objects, still sent to the LLM, still stored on disk).

- [ ] **Step 1: Edit `signalSummary()` in `src/views/detail.ts`**

Replace the existing function (currently at ~line 34):

```ts
// One-line human summary of a single signal. Deliberately terse — the
// detail page is about scanning, not reading paragraphs.
function signalSummary(s: Signal): string {
  switch (s.kind) {
    case 'js_error':
      return `${esc(s.message)}${s.url ? ` — ${esc(s.url)}` : ''}`;
    case 'unhandled_rejection':
      return esc(s.reason);
    case 'rage_click':
      return `target #${esc(s.targetId)} — ${s.count} clicks in ${s.spanMs}ms`;
    case 'dead_click':
      return `target #${esc(s.targetId)} — no DOM reaction within 300ms`;
    case 'failed_request':
      return `${esc(s.method)} ${esc(s.url)} → ${s.status}`;
  }
}
```

With:

```ts
// One-line human summary of a single signal. Deliberately terse — the
// detail page is about scanning, not reading paragraphs. Target node ids
// are intentionally omitted; the replay player shows which element was
// clicked with far more fidelity than a numeric id ever could.
function signalSummary(s: Signal): string {
  switch (s.kind) {
    case 'js_error':
      return `${esc(s.message)}${s.url ? ` — ${esc(s.url)}` : ''}`;
    case 'unhandled_rejection':
      return esc(s.reason);
    case 'rage_click':
      return `${s.count} clicks in ${s.spanMs}ms`;
    case 'dead_click':
      return `no DOM reaction within 300ms`;
    case 'failed_request':
      return `${esc(s.method)} ${esc(s.url)} → ${s.status}`;
  }
}
```

- [ ] **Step 2: Verify by rendering a session's detail page**

```bash
lsof -ti:4000 | xargs -r kill 2>/dev/null; sleep 1; rm -rf data
PORT=4000 npm start &
sleep 2

# Post a session that produces rage + dead clicks
RESP=$(curl -sX POST http://localhost:4000/capture -H 'Content-Type: application/json' -d '[
  {"type":51,"timestamp":1000,"data":{"url":"http://test","userAgent":"X"}},
  {"type":3,"timestamp":2000,"data":{"source":2,"type":2,"id":7}},
  {"type":3,"timestamp":2100,"data":{"source":2,"type":2,"id":7}},
  {"type":3,"timestamp":2200,"data":{"source":2,"type":2,"id":7}},
  {"type":3,"timestamp":2300,"data":{"source":2,"type":2,"id":7}},
  {"type":3,"timestamp":3000,"data":{"source":2,"type":2,"id":9}}
]')
SID=$(echo "$RESP" | node -e "process.stdin.once('data', d => process.stdout.write(JSON.parse(d).id))")
curl -s http://localhost:4000/sessions/$SID | grep -oE 'class="summary">[^<]+' | head -5
```

Expected output (no `target #N` substrings):
```
class="summary">4 clicks in 300ms
class="summary">no DOM reaction within 300ms
```

(If you see `target #7` or similar, the edit didn't take effect — restart the server.)

- [ ] **Step 3: Stop server and commit**

```bash
lsof -ti:4000 | xargs -r kill 2>/dev/null; rm -rf data
git add src/views/detail.ts
git commit -m "refactor: drop internal node ids from signal summary text"
git push origin main
```

---

## Task 3: Restructure detail page layout + mount replay player + wire click-to-seek

**Files:**
- Modify: `src/views/detail.ts` (rewrite `renderDetail()` plus CSS)

This is the biggest change. Three concerns compose into one commit because they can't work independently: the new HTML structure creates the player container; the inline script mounts the player into it; the click-to-seek handler depends on the player existing. Splitting would create intermediate broken states.

- [ ] **Step 1: Replace `renderDetail()` in `src/views/detail.ts`**

Find the function (currently at ~line 49, ends near line 174) — everything from `export async function renderDetail(record: SessionRecord): Promise<string> {` to the final closing `}` of the function.

Replace the entire function with:

```ts
export async function renderDetail(record: SessionRecord): Promise<string> {
  const explanation = await explainSession(record);

  // Each signal row gets a `data-ts` attribute carrying the signal's offset
  // from session start (ms). The inline script uses this for click-to-seek.
  const timeline = record.signals.length
    ? record.signals
        .map(s => `
          <div class="signal kind-${s.kind}" data-ts="${s.ts - record.startedAt}">
            <span class="ts">${relTs(s.ts, record.startedAt)}</span>
            <span class="icon">${SIGNAL_ICON[s.kind]}</span>
            <span class="kind">${s.kind}</span>
            <span class="summary">${signalSummary(s)}</span>
          </div>`)
        .join('')
    : '<div class="empty">No signals extracted from this session.</div>';

  const durationSec = Math.round(record.durationMs / 1000);
  const bucketColor = record.score.bucket === 'high' ? '#b42318'
                    : record.score.bucket === 'med'  ? '#b54708'
                    :                                   '#855c00';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>session-${esc(record.id)}</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/rrweb-player@2.0.0-alpha.11/dist/style.css">
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: ui-monospace, 'SF Mono', Menlo, monospace;
      max-width: 1400px; margin: 0 auto; padding: 40px 20px;
      color: #1a1a1a; background: #fafaf7;
    }
    a { color: #444; }
    .back { font-size: 12px; color: #888; margin-bottom: 20px; display: inline-block; }

    header { border-bottom: 1px solid #ddd; padding-bottom: 16px; margin-bottom: 24px; }
    h1 {
      font-size: 16px; font-weight: 600; margin: 0 0 6px 0;
      display: flex; align-items: baseline; gap: 14px;
    }
    .score-badge {
      font-size: 20px; font-weight: 700; color: ${bucketColor};
      font-variant-numeric: tabular-nums;
    }
    .bucket {
      font-size: 11px; text-transform: uppercase; letter-spacing: 1px;
      padding: 2px 8px; border-radius: 3px; background: #f0f0f0; color: #555;
    }
    .meta { color: #888; font-size: 12px; line-height: 1.6; }
    .meta span + span::before { content: " · "; color: #ccc; }

    /* Zone 2: signals sidebar + player, side by side */
    .investigate {
      display: grid;
      grid-template-columns: 25% 1fr;
      gap: 20px;
      margin-bottom: 28px;
    }
    .sidebar {
      max-height: 600px; overflow-y: auto;
      border-right: 1px solid #eee; padding-right: 14px;
    }
    .section-label {
      font-size: 11px; text-transform: uppercase; color: #888;
      letter-spacing: 1px; margin-bottom: 10px;
    }
    .signal {
      display: grid;
      grid-template-columns: 60px 20px 1fr;
      gap: 8px;
      padding: 8px 10px;
      border-bottom: 1px solid #eee;
      font-size: 12px;
      align-items: start;
      cursor: pointer;
      transition: background 80ms;
      border-radius: 3px;
    }
    .signal:hover { background: #f0efe9; }
    .signal.active { background: #fff4d6; }
    .signal .ts { color: #aaa; text-align: right; font-variant-numeric: tabular-nums; }
    .signal .icon { font-size: 13px; }
    .signal .kind {
      grid-column: 3; color: #666; font-size: 10px;
      text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 2px;
    }
    .signal .summary {
      grid-column: 3; color: #222; word-break: break-word; font-size: 12px;
    }
    .kind-js_error .summary { color: #b42318; }
    .kind-unhandled_rejection .summary { color: #b54708; }
    .kind-rage_click .kind { color: #b54708; font-weight: 700; }
    .kind-failed_request .summary { color: #b54708; }

    #replay-player {
      min-height: 500px;
      background: #111;
      border-radius: 6px;
      display: flex; align-items: center; justify-content: center;
      color: #888; font-size: 13px;
    }
    .player-loading::before { content: "Loading replay…"; }

    /* Zone 3: full-width explainer */
    .explainer-block { margin-top: 8px; }
    .explainer {
      background: #fffcf0;
      border-left: 3px solid #c9a227;
      padding: 16px 20px;
      font-family: Georgia, 'Times New Roman', serif;
      font-size: 14px;
      line-height: 1.6;
      color: #333;
      white-space: pre-wrap;
      border-radius: 0 4px 4px 0;
    }
    .explainer-label {
      display: flex; align-items: center; gap: 6px;
      font-size: 11px; text-transform: uppercase; color: #888;
      letter-spacing: 1px; margin-bottom: 10px;
    }
    .empty { color: #aaa; padding: 20px; text-align: center; }

    @media (max-width: 1100px) {
      .investigate { grid-template-columns: 1fr; }
      .sidebar { max-height: none; border-right: 0; padding-right: 0; }
    }
  </style>
</head>
<body>
  <a class="back" href="/">&larr; back to sessions</a>

  <header>
    <h1>
      <span>session-${esc(record.id)}</span>
      <span class="score-badge">${record.score.score}</span>
      <span class="bucket">${esc(record.score.bucket)}</span>
    </h1>
    <div class="meta">
      <span>${esc(record.url || '(no url)')}</span>
      <span>${durationSec}s</span>
      <span>${record.rawEventCount} raw events</span>
      <span>${record.signals.length} signals</span>
    </div>
  </header>

  <div class="investigate">
    <aside class="sidebar" id="signal-sidebar">
      <div class="section-label">Evidence — ${record.signals.length} signal${record.signals.length === 1 ? '' : 's'}</div>
      ${timeline}
    </aside>
    <div id="replay-player" class="player-loading"></div>
  </div>

  <div class="explainer-block">
    <div class="explainer-label">🤖 Explainer (AI, grounded in signals above)</div>
    <div class="explainer">${esc(explanation)}</div>
  </div>

  <script type="module">
    import rrwebPlayer from 'https://cdn.jsdelivr.net/npm/rrweb-player@2.0.0-alpha.11/+esm';

    const sessionId = ${JSON.stringify(record.id)};
    const container = document.getElementById('replay-player');
    const sidebar = document.getElementById('signal-sidebar');

    let player = null;

    try {
      const res = await fetch(\`/sessions/\${sessionId}/events\`);
      const events = await res.json();
      container.classList.remove('player-loading');
      container.innerHTML = '';
      player = new rrwebPlayer({
        target: container,
        props: {
          events,
          autoPlay: false,
          showController: true,
          width: container.clientWidth,
          height: 480,
        },
      });
    } catch (err) {
      container.classList.remove('player-loading');
      container.textContent = 'Replay failed to load: ' + (err && err.message ? err.message : err);
    }

    // Click-to-seek: delegated handler on the sidebar. Each .signal row
    // carries data-ts = offset from session start (ms). player.goto() seeks
    // to that offset. Also toggles an .active highlight on the clicked row.
    sidebar.addEventListener('click', (e) => {
      const row = e.target.closest('.signal[data-ts]');
      if (!row || !player) return;
      const ts = Number(row.dataset.ts);
      if (!Number.isFinite(ts)) return;
      player.goto(ts);
      sidebar.querySelectorAll('.signal.active').forEach(el => el.classList.remove('active'));
      row.classList.add('active');
    });
  </script>
</body>
</html>`;
}
```

Notes on what this does vs. the old `renderDetail`:
- Adds `<link rel="stylesheet">` for rrweb-player's CSS.
- Wraps sidebar + player in `.investigate` (CSS grid, 25% / 75%).
- Wraps the existing explainer in `.explainer-block` below both columns.
- Adds `data-ts` attributes per signal row.
- Adds `#replay-player` container with a loading state.
- Adds the inline `<script type="module">` that fetches events, mounts rrweb-player, and wires click-to-seek.
- Adds `@media (max-width: 1100px)` that collapses the grid to a single column on narrow screens.

- [ ] **Step 2: Smoke-test the page in a real browser**

```bash
lsof -ti:4000 | xargs -r kill 2>/dev/null; sleep 1; rm -rf data
PORT=4000 npm start &
sleep 2
echo "Visit http://localhost:4000/app.html, click Throw, Reject, Failing fetch, and the Dead button in quick succession, then click Stop & Send."
echo "After that, visit http://localhost:4000/ and click into the top session."
echo "Verify:"
echo "  (a) Three zones visible: header / signals+player / explainer"
echo "  (b) Replay player loads and Play button works"
echo "  (c) Clicking a signal row seeks the replay to that moment"
echo "  (d) Signal summary text has no 'target #N'"
```

Open the URL in the browser. Watch the dev console for any red errors related to rrweb-player. Click a signal row — the replay position should jump to that moment and the row should highlight.

- [ ] **Step 3: Stop server, clean up, commit**

```bash
lsof -ti:4000 | xargs -r kill 2>/dev/null; rm -rf data
git add src/views/detail.ts
git commit -m "feat: replay player + click-to-seek in session detail page"
git push origin main
```

---

## Task 4: Document smoke test results

**Files:**
- Create: `docs/superpowers/specs/replay-patch-smoke-test.md`

- [ ] **Step 1: Write the results document**

After running the smoke test in Task 3 Step 2 against a real browser session, create `docs/superpowers/specs/replay-patch-smoke-test.md` with this content (fill in the `ACTUAL RESULTS` sections yourself based on what you saw):

```markdown
# Providence V2 — Replay Patch Smoke Test Results

**Date:** 2026-04-22
**Tested build:** main @ (commit hash of the Task 3 commit)

## Success criteria (from design §9)

1. Detail page shows three zones (header / signals+player / explainer), no horizontal scroll at ≥1100px.
2. Replay plays the captured session accurately.
3. Clicking a signal row seeks the replay to that signal's timestamp.
4. Signal summary text no longer contains "target #N".
5. Existing capture/score/dashboard/explainer flows unchanged.

## Actual results

1. Three-zone layout: [PASS / FAIL — what you saw]
2. Replay accuracy: [PASS / FAIL — any desync or missing interactions]
3. Click-to-seek: [PASS / FAIL — does the video jump?]
4. Target-id cleanup: [PASS / FAIL — grep for "target #" in page HTML]
5. No regressions: [PASS / FAIL — dashboard still ranks, capture still works]

## Notes / surprises

(Any rrweb-player version mismatches, cosmetic issues, performance observations, etc.)
```

- [ ] **Step 2: Commit the results**

```bash
git add docs/superpowers/specs/replay-patch-smoke-test.md
git commit -m "test: document replay patch smoke test results"
git push origin main
```

---

## Self-review notes

- **Spec §1 (why):** addressed by the whole patch landing replay; verifying in Task 4.
- **Spec §2 (non-goals):** honored — node id resolution, playback speed controls, scrubber markers, keyboard shortcuts are NOT in any task.
- **Spec §3 (architecture delta):** Task 1 adds the new server route; Task 3 adds the rrweb-player CDN load + mount. No new npm deps, no build step change.
- **Spec §4 (three-zone layout):** Task 3 implements the exact layout (header / `.investigate` grid / `.explainer-block`) with the 25/75 split and 1100px responsive breakpoint.
- **Spec §5 (data flow):** Task 1 exposes the GET; Task 3's inline script fetches it and mounts the player.
- **Spec §6 (file changes):** Task 1 modifies `server.ts`; Tasks 2 and 3 modify `views/detail.ts` in the two specified ways (summary-text strip, layout+player+seek). `llm.ts` is untouched as specified.
- **Spec §7 (choices):** CDN-loaded rrweb-player (✓), events fetched client-side (✓), no autoplay (✓, `autoPlay: false`), no custom speed UI (✓, rrweb-player's default controller is used).
- **Spec §8 (open risks):** the rrweb-player version string `2.0.0-alpha.11` is chosen to match the agent's rrweb version — if this mismatches at implementation time, the task's Step 2 smoke test will surface it via console error and the fix is a version bump on the CDN URL.
- **Spec §9 (success criteria):** 1 and 4 verified by Task 3 Step 2; 2 and 3 verified in a real browser during Task 3 Step 2; 5 verified by running a capture-and-rank cycle on the already-existing demo page after Task 3, also part of Step 2.

Placeholder / consistency scan: all file paths absolute within project, all code blocks complete, all commands runnable. Type names match existing V2 (`Signal`, `SessionRecord`, `storage.getRawEvents`). No dangling "TBD"s.
