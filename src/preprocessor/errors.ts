import type { RawEvent, Signal } from './types.ts';

// Extracts js_error (event type 52) and unhandled_rejection (event type 53)
// signals from raw events. One signal per matching event — no deduping,
// no clustering (that's scorer / incident-clustering territory).
export function extractErrorSignals(events: RawEvent[]): Signal[] {
  const signals: Signal[] = [];
  for (const e of events) {
    if (e.type === 52) {
      signals.push({
        kind: 'js_error',
        message: String(e.data?.message ?? ''),
        stack: e.data?.stack,
        url: e.data?.filename,
        ts: e.timestamp,
      });
    } else if (e.type === 53) {
      signals.push({
        kind: 'unhandled_rejection',
        reason: String(e.data?.reason ?? ''),
        ts: e.timestamp,
      });
    }
  }
  return signals;
}
