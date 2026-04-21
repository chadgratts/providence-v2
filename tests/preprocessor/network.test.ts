import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractNetworkSignals } from '../../src/preprocessor/network.ts';
import type { RawEvent } from '../../src/preprocessor/types.ts';

function req(data: any, ts = 0): RawEvent {
  return { type: 50, timestamp: ts, data };
}

test('emits failed_request for 5xx', () => {
  const events = [req({ type: 'FETCH', url: '/a', method: 'POST', status: 500 })];
  const signals = extractNetworkSignals(events);
  assert.equal(signals.length, 1);
  if (signals[0].kind !== 'failed_request') throw new Error('wrong kind');
  assert.equal(signals[0].status, 500);
  assert.equal(signals[0].url, '/a');
});

test('emits failed_request for 4xx', () => {
  const events = [req({ type: 'FETCH', url: '/a', method: 'GET', status: 404 })];
  assert.equal(extractNetworkSignals(events).length, 1);
});

test('emits failed_request with network status for thrown errors', () => {
  const events = [req({ type: 'FETCH', url: '/a', method: 'GET', error: 'net' })];
  const signals = extractNetworkSignals(events);
  assert.equal(signals.length, 1);
  if (signals[0].kind !== 'failed_request') throw new Error('wrong kind');
  assert.equal(signals[0].status, 'network');
});

test('ignores 2xx/3xx successes', () => {
  const events = [
    req({ type: 'FETCH', url: '/a', method: 'GET', status: 200 }),
    req({ type: 'FETCH', url: '/a', method: 'GET', status: 304 }),
  ];
  assert.deepEqual(extractNetworkSignals(events), []);
});
