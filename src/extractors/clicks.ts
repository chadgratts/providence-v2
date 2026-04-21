import type { RawEvent, Signal } from '../types.ts';

// rrweb MouseInteraction subtype values (see rrweb source).
// We only care about Click (type 2) — MouseDown, MouseUp, Focus, etc. are noise.
const RRWEB_SOURCE_MUTATION = 0;
const RRWEB_SOURCE_MOUSE_INTERACTION = 2;
const RRWEB_MOUSE_CLICK = 2;

// Heuristic thresholds. Start here; tune after smoke tests.
const RAGE_MIN_CLICKS = 4;
const RAGE_WINDOW_MS = 1000;
const DEAD_WINDOW_MS = 300;

type ClickEvent = { ts: number; id: number };

function isClick(e: RawEvent): boolean {
  return (
    e.type === 3 &&
    e.data?.source === RRWEB_SOURCE_MOUSE_INTERACTION &&
    e.data?.type === RRWEB_MOUSE_CLICK
  );
}

function isMutation(e: RawEvent): boolean {
  return e.type === 3 && e.data?.source === RRWEB_SOURCE_MUTATION;
}

export function extractClickSignals(events: RawEvent[]): Signal[] {
  const signals: Signal[] = [];
  const clicks: ClickEvent[] = [];
  const mutationTimestamps: number[] = [];

  // Partition events into clicks + mutation timestamps. One pass.
  for (const e of events) {
    if (isClick(e)) {
      clicks.push({ ts: e.timestamp, id: Number(e.data.id) });
    } else if (isMutation(e)) {
      mutationTimestamps.push(e.timestamp);
    }
  }

  // --- Rage click bursts ---
  // Group clicks by target id, then slide a 1000ms window over each group.
  // Any window containing ≥4 clicks becomes one rage_click signal.
  const rageTargets = new Set<number>();
  const byTarget = new Map<number, number[]>();
  for (const c of clicks) {
    const arr = byTarget.get(c.id) ?? [];
    arr.push(c.ts);
    byTarget.set(c.id, arr);
  }
  for (const [id, times] of byTarget) {
    times.sort((a, b) => a - b);
    let i = 0;
    while (i < times.length) {
      // Extend the window as long as times[j+1] is within 1000ms of times[i].
      let j = i;
      while (j + 1 < times.length && times[j + 1] - times[i] <= RAGE_WINDOW_MS) {
        j++;
      }
      const count = j - i + 1;
      if (count >= RAGE_MIN_CLICKS) {
        signals.push({
          kind: 'rage_click',
          targetId: String(id),
          count,
          spanMs: times[j] - times[i],
          ts: times[i],
        });
        rageTargets.add(id);
        // Skip past this burst so we don't re-emit overlapping bursts.
        i = j + 1;
      } else {
        // Slide the window forward by one.
        i++;
      }
    }
  }

  // --- Dead clicks ---
  // A click is "dead" if no mutation occurs within DEAD_WINDOW_MS after it.
  // Rage-flagged targets are skipped — the rage_click signal already covers them.
  mutationTimestamps.sort((a, b) => a - b);
  for (const c of clicks) {
    if (rageTargets.has(c.id)) continue;
    const hasMutation = mutationTimestamps.some(
      m => m >= c.ts && m - c.ts <= DEAD_WINDOW_MS,
    );
    if (!hasMutation) {
      signals.push({ kind: 'dead_click', targetId: String(c.id), ts: c.ts });
    }
  }

  return signals;
}
