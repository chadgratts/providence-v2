import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractErrorSignals } from '../../src/preprocessor/errors.ts';
import type { RawEvent } from '../../src/preprocessor/types.ts';

test('extracts js_error from type 52 events', () => {
  const events: RawEvent[] = [
    {
      type: 52,
      timestamp: 1000,
      data: {
        message: 'TypeError: x is undefined',
        filename: 'https://example.com/app.js',
        stack: 'at foo (app.js:10:5)',
      },
    },
  ];
  const signals = extractErrorSignals(events);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].kind, 'js_error');
  if (signals[0].kind === 'js_error') {
    assert.equal(signals[0].message, 'TypeError: x is undefined');
    assert.equal(signals[0].url, 'https://example.com/app.js');
    assert.equal(signals[0].ts, 1000);
  }
});

test('extracts unhandled_rejection from type 53 events', () => {
  const events: RawEvent[] = [
    { type: 53, timestamp: 2000, data: { reason: 'fetch failed' } },
  ];
  const signals = extractErrorSignals(events);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].kind, 'unhandled_rejection');
  if (signals[0].kind === 'unhandled_rejection') {
    assert.equal(signals[0].reason, 'fetch failed');
  }
});

test('ignores unrelated events', () => {
  const events: RawEvent[] = [
    { type: 2, timestamp: 0, data: {} },
    { type: 3, timestamp: 0, data: {} },
  ];
  assert.deepEqual(extractErrorSignals(events), []);
});
