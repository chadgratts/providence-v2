import { test } from 'node:test';
import assert from 'node:assert/strict';
import { score } from '../src/scorer.ts';
import type { Signal } from '../src/types.ts';

function jsErrors(n: number): Signal[] {
  return Array.from({ length: n }, (_, i) => ({
    kind: 'js_error' as const, message: 'e', ts: i,
  }));
}

test('empty signals → score 0, bucket low, no reasons', () => {
  const s = score([]);
  assert.equal(s.score, 0);
  assert.equal(s.bucket, 'low');
  assert.deepEqual(s.topReasons, []);
});

test('1 js_error → score 25, bucket low', () => {
  const s = score(jsErrors(1));
  assert.equal(s.score, 25);
  assert.equal(s.bucket, 'low');
});

test('3 js_errors → score 75, bucket high', () => {
  const s = score(jsErrors(3));
  assert.equal(s.score, 75);
  assert.equal(s.bucket, 'high');
});

test('per-signal cap at 3 occurrences (10 errors → score 75, not 250)', () => {
  const s = score(jsErrors(10));
  assert.equal(s.score, 75);
});

test('mixed signals accumulate by weight', () => {
  const signals: Signal[] = [
    { kind: 'js_error', message: 'e', ts: 0 },              // 25
    { kind: 'rage_click', targetId: '1', count: 4, spanMs: 500, ts: 0 }, // 15
    { kind: 'failed_request', url: '/x', method: 'GET', status: 500, ts: 0 }, // 10
  ];
  assert.equal(score(signals).score, 50);
});

test('4xx failed_request weighted 5, 5xx + network weighted 10', () => {
  const s4xx = score([{ kind: 'failed_request', url: '/x', method: 'GET', status: 404, ts: 0 }]);
  assert.equal(s4xx.score, 5);
  const s5xx = score([{ kind: 'failed_request', url: '/x', method: 'GET', status: 503, ts: 0 }]);
  assert.equal(s5xx.score, 10);
  const sNet = score([{ kind: 'failed_request', url: '/x', method: 'GET', status: 'network', ts: 0 }]);
  assert.equal(sNet.score, 10);
});

test('topReasons sorted by weight descending, max 3', () => {
  const signals: Signal[] = [
    { kind: 'js_error', message: 'e', ts: 0 },
    { kind: 'unhandled_rejection', reason: 'r', ts: 0 },
    { kind: 'rage_click', targetId: '1', count: 4, spanMs: 500, ts: 0 },
    { kind: 'dead_click', targetId: '2', ts: 0 },
  ];
  const s = score(signals);
  assert.equal(s.topReasons.length, 3);
  assert.ok(s.topReasons[0].toLowerCase().includes('error'), 'highest-weight reason first');
});

test('bucket thresholds: <30 low, 30-59 med, ≥60 high', () => {
  // 1 js_error = 25 → low
  assert.equal(score(jsErrors(1)).bucket, 'low');
  // 2 js_errors = 50 → med
  assert.equal(score(jsErrors(2)).bucket, 'med');
  // 3 js_errors = 75 → high
  assert.equal(score(jsErrors(3)).bucket, 'high');
});
