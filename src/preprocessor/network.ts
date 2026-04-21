import type { RawEvent, Signal } from './types.ts';

// Extracts failed_request signals from event type 50 (fetch events).
// A request "fails" if:
//   - data.error is set (fetch threw — treat as status='network'), OR
//   - data.status is a number >= 400 (HTTP error)
// 2xx/3xx successes are ignored.
export function extractNetworkSignals(events: RawEvent[]): Signal[] {
  const signals: Signal[] = [];
  for (const e of events) {
    if (e.type !== 50) continue;
    const d = e.data ?? {};
    if (d.error !== undefined) {
      signals.push({
        kind: 'failed_request',
        url: String(d.url ?? ''),
        method: String(d.method ?? 'GET'),
        status: 'network',
        ts: e.timestamp,
      });
      continue;
    }
    if (typeof d.status === 'number' && d.status >= 400) {
      signals.push({
        kind: 'failed_request',
        url: String(d.url ?? ''),
        method: String(d.method ?? 'GET'),
        status: d.status,
        ts: e.timestamp,
      });
    }
  }
  return signals;
}
