import type { RawEvent, Signal } from '../types.ts';
import { extractErrorSignals } from './errors.ts';
import { extractNetworkSignals } from './network.ts';
import { extractClickSignals } from './clicks.ts';

// The single entry point the server calls. Takes raw browser events,
// returns session metadata + a combined (time-sorted) list of signals.
// This is the "preprocess" step in the capture pipeline:
//   /capture → preprocess(events) → score(signals) → storage.save(...)
export type PreprocessResult = {
  url: string;
  userAgent: string;
  startedAt: number;
  durationMs: number;
  signals: Signal[];
  rawEventCount: number;
};

export function preprocess(events: RawEvent[]): PreprocessResult {
  // Session context comes from the type-51 event the agent emits once at start.
  const ctx = events.find(e => e.type === 51);
  const url = String(ctx?.data?.url ?? '');
  const userAgent = String(ctx?.data?.userAgent ?? '');

  // Session duration = span between earliest and latest event timestamps.
  const timestamps = events.map(e => e.timestamp).filter(n => Number.isFinite(n));
  const startedAt = timestamps.length ? Math.min(...timestamps) : Date.now();
  const endedAt = timestamps.length ? Math.max(...timestamps) : startedAt;

  // Run all three extractors, concat, sort by timestamp so the detail view
  // renders them as a proper timeline.
  const signals: Signal[] = [
    ...extractErrorSignals(events),
    ...extractNetworkSignals(events),
    ...extractClickSignals(events),
  ].sort((a, b) => a.ts - b.ts);

  return {
    url,
    userAgent,
    startedAt,
    durationMs: endedAt - startedAt,
    signals,
    rawEventCount: events.length,
  };
}
