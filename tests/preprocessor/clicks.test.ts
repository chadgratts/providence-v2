import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { extractClickSignals } from '../../src/preprocessor/clicks.ts';
import type { RawEvent } from '../../src/preprocessor/types.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): RawEvent[] =>
  JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', name), 'utf8'));

// Regression test: locks in observed behavior against a real rrweb capture.
// V1 session has 4 clicks on ids 31/33/34/43 and 4 mutations. Rage clicks
// require same-id bursts so this session should produce zero. Three clicks
// (31, 33, 34) have no mutation within 300ms so they flag dead; id 43 does,
// so it's alive.
test('V1 fixture → 0 rage, 3 dead clicks (matches observed real-data run)', () => {
  const signals = extractClickSignals(fixture('v1-session.json'));
  const rage = signals.filter(s => s.kind === 'rage_click');
  const dead = signals.filter(s => s.kind === 'dead_click');
  assert.equal(rage.length, 0, 'no rage: all V1 clicks on different ids');
  assert.equal(dead.length, 3, 'three dead: clicks on ids 31, 33, 34');
  const deadIds = dead
    .map(s => (s.kind === 'dead_click' ? s.targetId : ''))
    .sort();
  assert.deepEqual(deadIds, ['31', '33', '34']);
});

// Synthetic rage-click test: the one piece of behavior V1 data can't validate,
// because V1's user never rage-clicked anything.
test('synthetic: 4 clicks on same id within 1s → 1 rage_click signal', () => {
  const events: RawEvent[] = [100, 300, 500, 700].map(ts => ({
    type: 3,
    timestamp: ts,
    data: { source: 2, type: 2, id: 7 },
  }));
  const signals = extractClickSignals(events);
  const rage = signals.filter(s => s.kind === 'rage_click');
  assert.equal(rage.length, 1);
  if (rage[0].kind === 'rage_click') {
    assert.equal(rage[0].targetId, '7');
    assert.equal(rage[0].count, 4);
    assert.equal(rage[0].spanMs, 600);
  }
});
