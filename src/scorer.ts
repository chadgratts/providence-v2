import type { Signal } from './types.ts';

// The scorer embodies the product's opinion: which sessions deserve attention?
// It's a dumb weighted sum by design. No LLM, no ML, no black box.
// You should be able to eyeball why any session ranks where it does.
//
// The weights + thresholds are intentionally readable. Change them here,
// not by reaching into downstream consumers.

export type SessionScore = {
  score: number;
  bucket: 'high' | 'med' | 'low';
  topReasons: string[];
};

const CAP = 3; // each signal kind caps at 3 occurrences so one runaway
               // session can't drown the list.

// Each bucket: a weight, a predicate for which Signals match, and a
// `render()` that produces a human-readable reason line for the dashboard.
type WeightBucket = {
  weight: number;
  matches: (s: Signal) => boolean;
  render: (count: number, sample?: Signal) => string;
};

const BUCKETS: WeightBucket[] = [
  {
    weight: 25,
    matches: s => s.kind === 'js_error',
    render: c => `${c} JS error${c > 1 ? 's' : ''}`,
  },
  {
    weight: 20,
    matches: s => s.kind === 'unhandled_rejection',
    render: c => `${c} unhandled rejection${c > 1 ? 's' : ''}`,
  },
  {
    weight: 15,
    matches: s => s.kind === 'rage_click',
    render: (_c, s) =>
      s && s.kind === 'rage_click'
        ? `rage click on #${s.targetId}`
        : 'rage click burst',
  },
  {
    weight: 10,
    matches: s =>
      s.kind === 'failed_request' &&
      (s.status === 'network' || (typeof s.status === 'number' && s.status >= 500)),
    render: c => `${c} failed request${c > 1 ? 's' : ''} (5xx/network)`,
  },
  {
    weight: 8,
    matches: s => s.kind === 'dead_click',
    render: c => `${c} dead click${c > 1 ? 's' : ''}`,
  },
  {
    weight: 5,
    matches: s =>
      s.kind === 'failed_request' &&
      typeof s.status === 'number' &&
      s.status >= 400 &&
      s.status < 500,
    render: c => `${c} failed request${c > 1 ? 's' : ''} (4xx)`,
  },
];

export function score(signals: Signal[]): SessionScore {
  let total = 0;
  const contributions: { weight: number; count: number; reason: string }[] = [];

  for (const b of BUCKETS) {
    const matched = signals.filter(b.matches);
    if (matched.length === 0) continue;
    const capped = Math.min(matched.length, CAP);
    total += b.weight * capped;
    contributions.push({
      weight: b.weight,
      count: capped,
      reason: b.render(capped, matched[0]),
    });
  }

  // Sort by weight so the most-severe reason reads first on the dashboard.
  contributions.sort((a, b) => b.weight - a.weight);

  const bucket: SessionScore['bucket'] =
    total >= 60 ? 'high' : total >= 30 ? 'med' : 'low';

  return {
    score: total,
    bucket,
    topReasons: contributions.slice(0, 3).map(c => c.reason),
  };
}
