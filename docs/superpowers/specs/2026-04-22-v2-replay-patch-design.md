# Providence V2 — Replay Player Patch Design

**Status:** Approved for implementation planning
**Date:** 2026-04-22
**Owner:** Garrett
**Scope:** Small patch to V2. Not a new product. Adds session replay + click-to-seek to the existing detail page.
**Time budget:** ~30 minutes of active work.

---

## 1. Why this exists

V2 ships with a detection-first dashboard and a detail page containing structured signals + an LLM explainer. But the detail page never shows what actually happened in the browser — there's no replay of the user's session, even though the raw rrweb events are already captured and stored.

This gap is load-bearing for the wedge. The dashboard's claim ("these sessions need your attention, here's why") is a claim backed by text. Replay turns the claim into evidence the user can *see*. Without it:

- The text descriptions are asking you to trust — "a rage click on target #7" means something only if you can verify the user actually rage-clicked.
- "target #7" is unreadable noise (internal rrweb node id) until you can correlate it with a visual element.
- Detection-first products need an **artifact** the user walks away with. V1 delivered a summary; V2 currently delivers a ranked list + paragraph, neither of which feels like a thing. Replay is the natural artifact for this product category.

The patch makes V2 feel complete without changing its thesis.

## 2. Non-goals

- Resolving rrweb node ids to human-readable element labels ("button 'Save for later'"). Logged for V3; replay makes this unnecessary at V2 scope.
- Playback speed controls, keyboard shortcuts, scrubber customization. rrweb-player provides defaults, we ship defaults.
- Timeline scrubbing that shows signal markers on the player's progress bar. V3 candidate.
- Any change to the capture pipeline, scorer, storage, dashboard, or browser agent. Detail page only.

## 3. Architecture (delta from current V2)

```
┌──────────────────────────────────────────────────────────────────┐
│  src/server.ts      (modified) adds GET /sessions/:id/events     │
│  src/views/detail.ts (modified) renders the new layout           │
│  public/agent.js    (unchanged)                                   │
│  everything else    (unchanged)                                   │
└──────────────────────────────────────────────────────────────────┘

Client-side additions:
  - rrweb-player loaded from CDN (no bundler)
  - ~30 lines of inline JS in the detail page that fetches events
    and mounts the player
```

No new server modules, no new schema, no new storage concerns. The raw rrweb events are already persisted at `data/sessions/<id>.events.json` (Task 10). We're just exposing them over HTTP.

## 4. Layout — three zones

```
┌──────────────────────────────────────────────────────────────────┐
│  session-b60cd61c   74   HIGH                                    │
│  http://localhost:4000/app.html · 5s · 39 raw events · 7 signals │   Zone 1: header
├─────────────────┬────────────────────────────────────────────────┤
│                 │                                                │
│  +1.93s         │                                                │
│  JS_ERROR       │                                                │
│  ───────────    │                                                │
│  +1.93s         │          VIDEO PLAYER (rrweb replay)           │
│  DEAD_CLICK     │                                                │
│  ───────────    │          (~75% width)                          │   Zone 2: signals | video
│  +2.42s         │                                                │
│  DEAD_CLICK     │                                                │
│  ...            │                                                │
│                 │                                                │
│  (~25% width)   │                                                │
│                 │                                                │
├─────────────────┴────────────────────────────────────────────────┤
│  🤖 EXPLAINER (AI, grounded in signals above)                    │
│                                                                  │   Zone 3: explainer,
│  In a 4.6s session on localhost, a JavaScript error occurred     │           full width
│  from an onclick handler...                                      │
└──────────────────────────────────────────────────────────────────┘
```

- **Zone 1 — header.** Unchanged from V2.
- **Zone 2 — signals (left ~25%) + video (right ~75%).** Signals list runs vertically. rrweb-player fills the right column at its natural aspect ratio.
- **Zone 3 — explainer.** Below both columns, full page width. Unchanged from V2 except for vertical position.

At viewports under ~1100px, Zone 2 stacks vertically (signals on top, video below) via one `@media` query. This is the one responsive concession.

## 5. Data flow

```
Detail page load
      │
      ▼
GET /sessions/:id        ─── server returns renderDetail(record) HTML
      │                       (signals, header, player container, explainer)
      │
      ▼
Inline <script> runs
      │
      ▼
fetch('/sessions/:id/events')  ─── NEW server route, returns JSON array
      │
      ▼
new rrwebPlayer({
  target: document.getElementById('replay-player'),
  props: { events: <fetched events>, autoPlay: false, speed: 1 }
})
```

The player runs entirely client-side. The server's only new responsibility is exposing the stored events over HTTP.

## 6. Changes to existing files

### `src/server.ts`
Add one route above `/sessions/:id`:

```ts
app.get('/sessions/:id/events', async (req, res) => {
  const events = await storage.getRawEvents(req.params.id);
  res.json(events);
});
```

No other changes.

### `src/views/detail.ts`
Restructure the returned HTML into three zones (header / signals+video / explainer). Add a `<div id="replay-player">` in Zone 2. Append an inline `<script type="module">` that imports `rrweb-player` from a CDN, fetches events, and mounts the player.

Wire **click-to-seek**: each signal row in the left sidebar gets a `data-ts` attribute (the absolute timestamp of that signal). A single delegated click handler on the sidebar calls `player.goto(ts - sessionStart)` to jump the replay to that moment. Expected addition: ~10 lines of inline JS inside the same `<script>` tag that mounts the player.

Also trim the signal summary text so internal rrweb node ids don't appear:

- `rage_click: "target #7 — 4 clicks in 500ms"` → `rage_click: "4 clicks in 500ms"`
- `dead_click: "target #27 — no DOM reaction within 300ms"` → `dead_click: "no DOM reaction within 300ms"`

Reason: the replay now shows which element was clicked. Text redundancy is noise.

### `src/llm.ts`
Unchanged. The LLM still receives the full `Signal[]` (with target ids preserved in the data), so it can reference specific targets when useful. Only the human-facing text strip changes.

## 7. Choices worth naming

- **rrweb-player from CDN, not bundled.** Matches how the agent loads rrweb itself in `public/agent.js`. Zero build step. Specifically using `https://cdn.jsdelivr.net/npm/rrweb-player@1.0.0-alpha.4/dist/index.js` or latest matching the rrweb version in the agent.
- **Events fetched client-side, not inlined into HTML.** Keeps the initial HTML response fast. Player can show a "loading" state during fetch. Also lets the events payload be cached separately from the (dynamic) HTML.
- **No autoplay.** The user should click play deliberately. Forcing autoplay on load is intrusive and blocks ad-friendly browser defaults anyway.
- **No speed control in V2.** rrweb-player exposes one by default; we accept it. No custom UI.

## 8. Open risks

- **rrweb-player version mismatch with the captured rrweb version.** The agent uses `rrweb@2.0.0-alpha.11`. Need the matching `rrweb-player` version (alpha track). If the alpha is unstable, fall back to a patched local copy.
- **Large session playback performance.** A session with 10k events may lag in the player. Not a concern at wedge scale but worth knowing.
- **Cross-origin DOM replay.** If the captured page referenced external stylesheets or iframes, the replay may render imperfectly. Not a correctness bug (the events are faithful) but a cosmetic one. rrweb's known limitation.

## 9. Success criteria

The patch is successful when:

1. Opening a session detail page shows the evidence sidebar, video player, and explainer — all three zones visible without horizontal scroll at ≥1100px wide.
2. Clicking play on the player accurately replays the captured browser session, including DOM mutations, mouse movements, clicks, and inputs.
3. Clicking a signal row in the sidebar seeks the replay to that signal's timestamp.
4. Signal summary text no longer contains "target #N" noise.
5. The existing capture/score/dashboard/explainer flows remain unchanged (no regressions on spec §15 criteria).

## 10. Deferred to V3

- **Resolve node ids to element descriptions** for tooltip/accessibility use. Relies on walking the captured DOM snapshot.
- **Timeline markers on the player scrubber** showing where each signal fired.
- **Keyboard shortcuts** (space = play/pause, arrow keys = seek).
- **Broader realization logged from this work:** detection-first products need an *artifact*. V3 should center on "what do you walk away with?" as a design constraint — replay is one answer; auto-generated incident tickets, shareable deep-linked moments, and exported video clips are others worth considering.
