# Providence V2 — Replay Patch Smoke Test Results

**Date:** 2026-04-22
**Tested build:** main @ `418a8ea` (Task 3 commit)
**Tester:** User, in Chrome on macOS, real browser capture from `/demo`.

## Success criteria (from design §9)

1. Detail page shows three zones (header / signals+player / explainer), no horizontal scroll at ≥1100px.
2. Replay plays the captured session accurately.
3. Clicking a signal row seeks the replay to that signal's timestamp.
4. Signal summary text no longer contains "target #N".
5. Existing capture/score/dashboard/explainer flows unchanged.

## Actual results

1. **Three-zone layout: PASS.** Header at top, signals sidebar + video player side-by-side, explainer below.
2. **Replay accuracy: PASS.** User captured a session on `/demo`, video played back the interaction including clicks and form input.
3. **Click-to-seek: PASS.** Clicking a signal row in the sidebar jumped the replay to that moment and highlighted the clicked row.
4. **Target-id cleanup: PASS.** Signal summary text no longer shows `target #N`. Verified during implementation via curl grep.
5. **No regressions: PASS.** Dashboard still ranks, capture still works, explainer still renders.

## Notes / surprises

**Dead-click false positives surfaced during testing.** Two independent failure modes:

- Clicking the "Pay now" button (whose onclick throws an error) was flagged as a dead click. The handler ran — it just didn't produce a DOM mutation.
- Clicking into the email input field was flagged as a dead click. The browser focused the input (cursor blink, focus ring appeared), but focus events are rrweb Input events (source 5), and our detector only watches Mutation events (source 0).

Both are signal-quality issues, not patch-level bugs. The patch itself behaved correctly — it displayed the signals the scorer/extractor gave it. The extractor is what needs the fix.

Logged as a V3 deferred item in `docs/superpowers/specs/2026-04-20-providence-v2-detection-first-design.md` §14 with a concrete fix sketch (~5 lines in `src/extractors/clicks.ts`).

## Verdict

**Replay patch ships.** All five §9 success criteria pass against a real browser capture. The dead-click tuning question is orthogonal to the patch scope — the patch's job was "show the replay, wire click-to-seek, drop node-id noise," and it does all three.
