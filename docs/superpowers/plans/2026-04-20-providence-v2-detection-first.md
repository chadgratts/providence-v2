# Providence V2 — Detection-First Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a working detection-first session replay wedge: browser agent captures rrweb + errors + network, server preprocesses into typed signals, a weighted-sum scorer ranks sessions, and a dashboard lists sessions by severity with a grounded LLM explainer on the detail page.

**Architecture:** Single Node.js process (tsx + Express) serving a static browser agent, a `POST /capture` endpoint that preprocesses and scores synchronously, and server-rendered HTML pages for the ranked dashboard and session detail. Storage is plain JSON files. All signals except rage/dead clicks are captured directly at the source; rage/dead clicks are extracted from rrweb MouseInteraction + Mutation events. Scorer is a pure function with a readable weighted formula (no LLM in ranking). The LLM runs only on detail-page requests, producing a grounded explainer from structured signals.

**Tech Stack:** TypeScript, tsx (runtime, no build), Express, rrweb v2 (CDN-loaded in browser), OpenAI SDK (`gpt-5-nano`), Node's built-in `node:test` for unit tests.

**Spec:** [2026-04-20-providence-v2-detection-first-design.md](../specs/2026-04-20-providence-v2-detection-first-design.md)

---

## File Structure

```
providence-v2/
├── package.json             # Task 1
├── tsconfig.json            # Task 1
├── .gitignore               # Task 1
├── .env                     # OPENAI_API_KEY (user-created, gitignored)
├── public/
│   ├── agent.js             # Task 2 — browser agent (rrweb + fetch + errors)
│   └── app.html             # Task 2 — lab page (for interactive capture)
├── demo/
│   └── index.html           # Task 14 — deliberately-buggy smoke-test app
├── src/
│   ├── server.ts            # Task 11 — Express app + routes
│   ├── storage.ts           # Task 10 — JSON file IO
│   ├── scorer.ts            # Task 9 — pure weighted-sum ranker
│   ├── llm.ts               # Task 13 — OpenAI client + grounded explainer
│   ├── preprocessor/
│   │   ├── types.ts         # Task 3 — Signal discriminated union
│   │   ├── errors.ts        # Task 4 — js_error + unhandled_rejection
│   │   ├── network.ts       # Task 5 — failed_request (5xx / 4xx / network)
│   │   ├── clicks.ts        # Task 6 — rage_click + dead_click
│   │   └── index.ts         # Task 7 — orchestrator: events → Signal[]
│   └── views/
│       ├── dashboard.ts     # Task 12 — ranked list HTML
│       └── detail.ts        # Task 13 — session detail HTML + LLM output
├── tests/
│   ├── scorer.test.ts       # Task 9
│   ├── preprocessor/
│   │   ├── errors.test.ts   # Task 4
│   │   ├── network.test.ts  # Task 5
│   │   ├── clicks.test.ts   # Task 6
│   │   └── index.test.ts    # Task 7
│   └── storage.test.ts      # Task 10
└── data/                    # runtime only, gitignored
    ├── sessions.json        # index
    ├── sessions/
    │   ├── <id>.json        # SessionRecord
    │   └── <id>.events.json # raw rrweb events
    └── ...
```

**Responsibilities:**

- `preprocessor/*` — each file extracts one signal kind from events. Pure functions, no IO.
- `scorer.ts` — pure function on `Signal[]`, no IO.
- `storage.ts` — all filesystem reads/writes.
- `llm.ts` — all OpenAI calls.
- `views/*` — return HTML strings. No IO beyond calling `storage.ts`.
- `server.ts` — wires everything, no business logic.

---

## Task 1: Project setup

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`

- [ ] **Step 1: Initialize package.json**

Create `package.json`:

```json
{
  "name": "providence-v2",
  "type": "module",
  "private": true,
  "scripts": {
    "start": "tsx src/server.ts",
    "test": "tsx --test tests/**/*.test.ts"
  },
  "dependencies": {
    "dotenv": "^17.4.2",
    "express": "^4.21.0",
    "openai": "^6.34.0"
  },
  "devDependencies": {
    "@types/express": "^5.0.0",
    "@types/node": "^22.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src/**/*", "tests/**/*"]
}
```

- [ ] **Step 3: Create .gitignore**

```
node_modules
data/
.env
.DS_Store
.superpowers/
```

- [ ] **Step 4: Install**

```bash
cd /Users/chadgratts/Studio/Products/providence-v2 && npm install
```

Expected: `node_modules/` populated, no errors.

- [ ] **Step 5: Initialize git and commit**

```bash
git init && git add . && git commit -m "chore: scaffold providence v2"
```

---

## Task 2: Browser agent

**Files:**
- Create: `public/agent.js`
- Create: `public/app.html`

The agent extends V1's pattern (rrweb from CDN + fetch wrap) with two additions: `window.addEventListener('error', ...)` emitting custom event type 52, and `window.addEventListener('unhandledrejection', ...)` emitting type 53.

- [ ] **Step 1: Write public/agent.js**

```js
import { record } from 'https://cdn.jsdelivr.net/npm/rrweb@2.0.0-alpha.11/+esm';

const events = [];
const eventCountEl = document.getElementById('event-count');
const stopButtonEl = document.getElementById('stop-btn');
const originalFetch = window.fetch.bind(window);

function addEvent(event) {
  events.push(event);
  if (eventCountEl) eventCountEl.textContent = String(events.length);
}

// Session context (type 51)
addEvent({
  type: 51,
  timestamp: Date.now(),
  data: {
    url: location.href,
    userAgent: navigator.userAgent,
    language: navigator.language,
    platform: navigator.platform,
  },
});

// Fetch wrap (type 50)
window.fetch = async (resource, config) => {
  const url = resource instanceof Request ? resource.url : String(resource);
  const method = resource instanceof Request ? resource.method : config?.method || 'GET';

  if (url.includes('/capture')) {
    return originalFetch(resource, config);
  }

  try {
    const response = await originalFetch(resource, config);
    addEvent({
      type: 50,
      timestamp: Date.now(),
      data: { type: 'FETCH', url, method, status: response.status },
    });
    return response;
  } catch (error) {
    addEvent({
      type: 50,
      timestamp: Date.now(),
      data: {
        type: 'FETCH',
        url,
        method,
        error: error instanceof Error ? error.message : String(error),
      },
    });
    throw error;
  }
};

// JS error capture (type 52) — NEW in V2
window.addEventListener('error', (e) => {
  addEvent({
    type: 52,
    timestamp: Date.now(),
    data: {
      message: e.message,
      filename: e.filename,
      lineno: e.lineno,
      colno: e.colno,
      stack: e.error?.stack,
    },
  });
});

// Unhandled rejection capture (type 53) — NEW in V2
window.addEventListener('unhandledrejection', (e) => {
  addEvent({
    type: 53,
    timestamp: Date.now(),
    data: {
      reason: e.reason instanceof Error
        ? (e.reason.stack || e.reason.message)
        : String(e.reason),
    },
  });
});

// rrweb recording
const stopRecording = record({
  emit(event) { addEvent(event); },
});

// Auto-send on unload + manual stop button
async function sendEvents() {
  const payload = JSON.stringify(events);
  // Use sendBeacon for reliability on unload; fall back to fetch for stop button.
  if (typeof navigator.sendBeacon === 'function') {
    navigator.sendBeacon('/capture', new Blob([payload], { type: 'application/json' }));
    return;
  }
  await originalFetch('/capture', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
  });
}

window.addEventListener('beforeunload', sendEvents);

if (stopButtonEl) {
  stopButtonEl.addEventListener('click', async () => {
    stopRecording();
    window.fetch = originalFetch;
    stopButtonEl.disabled = true;
    stopButtonEl.textContent = 'Sending...';
    await sendEvents();
    stopButtonEl.textContent = 'Sent ✓';
  });
}
```

- [ ] **Step 2: Write public/app.html**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Providence V2 — Lab</title>
  <style>
    body { font-family: sans-serif; max-width: 600px; margin: 40px auto; padding: 0 20px; }
    .section { margin: 24px 0; padding: 16px; border: 1px solid #ddd; border-radius: 8px; }
    button { padding: 8px 16px; margin: 4px; cursor: pointer; }
    input, textarea { padding: 8px; width: 100%; box-sizing: border-box; margin: 4px 0; }
    #controls { position: fixed; top: 0; left: 0; right: 0; background: #111; color: #fff;
      padding: 12px 20px; display: flex; justify-content: space-between; align-items: center;
      z-index: 999; }
    #event-count { font-family: monospace; }
  </style>
</head>
<body>
  <div id="controls" class="rr-block">
    <span>rrweb recording... <span id="event-count">0</span> events</span>
    <button id="stop-btn">Stop & Send</button>
  </div>
  <h1 style="margin-top: 60px;">Providence V2 Lab</h1>
  <div class="section">
    <button onclick="throw new Error('test error')">Throw</button>
    <button onclick="Promise.reject(new Error('rejected'))">Reject</button>
    <button onclick="fetch('/does-not-exist')">Failing fetch</button>
    <button id="dead">Dead button (no handler)</button>
  </div>
  <script type="module" src="/agent.js"></script>
</body>
</html>
```

- [ ] **Step 3: Commit**

```bash
git add public && git commit -m "feat: browser agent with error + rejection capture"
```

---

## Task 3: Signal types

**Files:**
- Create: `src/preprocessor/types.ts`

- [ ] **Step 1: Write the Signal union + RawEvent type**

```ts
// src/preprocessor/types.ts

export type RawEvent = {
  type: number;
  timestamp: number;
  data: any;
};

export type Signal =
  | { kind: 'js_error'; message: string; stack?: string; url?: string; ts: number }
  | { kind: 'unhandled_rejection'; reason: string; ts: number }
  | { kind: 'rage_click'; targetId: string; count: number; spanMs: number; ts: number }
  | { kind: 'dead_click'; targetId: string; ts: number }
  | {
      kind: 'failed_request';
      url: string;
      method: string;
      status: number | 'network';
      ts: number;
    };

export type SignalKind = Signal['kind'];
```

- [ ] **Step 2: Commit**

```bash
git add src/preprocessor/types.ts
git commit -m "feat: Signal discriminated union"
```

---

## Task 4: Error preprocessor

**Files:**
- Create: `src/preprocessor/errors.ts`
- Create: `tests/preprocessor/errors.test.ts`

Extracts `js_error` (event type 52) and `unhandled_rejection` (event type 53) from raw events. One signal per event.

- [ ] **Step 1: Write the failing test**

```ts
// tests/preprocessor/errors.test.ts
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
```

- [ ] **Step 2: Run — expect failure**

```bash
npm test -- tests/preprocessor/errors.test.ts
```

Expected: fails with module not found.

- [ ] **Step 3: Implement**

```ts
// src/preprocessor/errors.ts
import type { RawEvent, Signal } from './types.ts';

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
```

- [ ] **Step 4: Run — expect pass**

```bash
npm test -- tests/preprocessor/errors.test.ts
```

Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/preprocessor/errors.ts tests/preprocessor/errors.test.ts
git commit -m "feat: extract js_error + unhandled_rejection signals"
```

---

## Task 5: Network preprocessor

**Files:**
- Create: `src/preprocessor/network.ts`
- Create: `tests/preprocessor/network.test.ts`

Extracts `failed_request` from event type 50. Emits a signal when `data.error` is set (network error) or `data.status >= 400`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/preprocessor/network.test.ts
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
```

- [ ] **Step 2: Run — expect failure**

```bash
npm test -- tests/preprocessor/network.test.ts
```

- [ ] **Step 3: Implement**

```ts
// src/preprocessor/network.ts
import type { RawEvent, Signal } from './types.ts';

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
```

- [ ] **Step 4: Run — expect pass**

```bash
npm test -- tests/preprocessor/network.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/preprocessor/network.ts tests/preprocessor/network.test.ts
git commit -m "feat: extract failed_request signals"
```

---

## Task 6: Click preprocessor (rage + dead)

**Files:**
- Create: `src/preprocessor/clicks.ts`
- Create: `tests/preprocessor/clicks.test.ts`

Rage click: **≥4 clicks on the same `id`, all within a 1000ms span, emitted as one `rage_click` signal.** Dead click: **a click whose target's subtree has no DOM Mutation in the next 300ms.**

rrweb event shapes used here:
- MouseInteraction: `{ type: 3, timestamp, data: { source: 2, type: 2 /*Click*/, id: <nodeId> } }`
- Mutation: `{ type: 3, timestamp, data: { source: 0, adds, removes, texts, attributes } }` — each mutation item has an `id` field.

For the wedge, dead-click detection uses a simplified heuristic: a click is "dead" if no Mutation event (any) occurs within 300ms anywhere. This is intentionally loose; we can tighten to same-subtree matching later if smoke tests show false positives.

- [ ] **Step 1: Write the failing test**

```ts
// tests/preprocessor/clicks.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractClickSignals } from '../../src/preprocessor/clicks.ts';
import type { RawEvent } from '../../src/preprocessor/types.ts';

function click(ts: number, id: number): RawEvent {
  return { type: 3, timestamp: ts, data: { source: 2, type: 2, id } };
}
function mutation(ts: number): RawEvent {
  return { type: 3, timestamp: ts, data: { source: 0, adds: [], removes: [], texts: [], attributes: [] } };
}

test('detects rage click burst (4 clicks same id within 1s)', () => {
  const events = [click(100, 7), click(300, 7), click(500, 7), click(700, 7)];
  const signals = extractClickSignals(events);
  const rage = signals.filter(s => s.kind === 'rage_click');
  assert.equal(rage.length, 1);
  if (rage[0].kind !== 'rage_click') throw new Error();
  assert.equal(rage[0].targetId, '7');
  assert.equal(rage[0].count, 4);
  assert.equal(rage[0].spanMs, 600);
});

test('does not emit rage click for 3 clicks', () => {
  const events = [click(100, 7), click(300, 7), click(500, 7)];
  const rage = extractClickSignals(events).filter(s => s.kind === 'rage_click');
  assert.equal(rage.length, 0);
});

test('does not emit rage click when clicks span > 1000ms', () => {
  const events = [click(0, 7), click(400, 7), click(800, 7), click(1500, 7)];
  const rage = extractClickSignals(events).filter(s => s.kind === 'rage_click');
  assert.equal(rage.length, 0);
});

test('detects dead click (no mutation within 300ms)', () => {
  const events = [click(1000, 9)];
  const dead = extractClickSignals(events).filter(s => s.kind === 'dead_click');
  assert.equal(dead.length, 1);
  if (dead[0].kind !== 'dead_click') throw new Error();
  assert.equal(dead[0].targetId, '9');
});

test('click with mutation within 300ms is NOT dead', () => {
  const events = [click(1000, 9), mutation(1100)];
  const dead = extractClickSignals(events).filter(s => s.kind === 'dead_click');
  assert.equal(dead.length, 0);
});

test('rage-clicked target is not also reported as dead-clicked (dedupe)', () => {
  const events = [click(100, 7), click(300, 7), click(500, 7), click(700, 7)];
  const signals = extractClickSignals(events);
  const rage = signals.filter(s => s.kind === 'rage_click');
  const dead = signals.filter(s => s.kind === 'dead_click');
  assert.equal(rage.length, 1);
  assert.equal(dead.length, 0);
});
```

- [ ] **Step 2: Run — expect failure**

```bash
npm test -- tests/preprocessor/clicks.test.ts
```

- [ ] **Step 3: Implement**

```ts
// src/preprocessor/clicks.ts
import type { RawEvent, Signal } from './types.ts';

const RAGE_MIN_CLICKS = 4;
const RAGE_WINDOW_MS = 1000;
const DEAD_WINDOW_MS = 300;

type ClickEvent = { ts: number; id: number };

function isClick(e: RawEvent): boolean {
  return e.type === 3 && e.data?.source === 2 && e.data?.type === 2;
}
function isMutation(e: RawEvent): boolean {
  return e.type === 3 && e.data?.source === 0;
}

export function extractClickSignals(events: RawEvent[]): Signal[] {
  const signals: Signal[] = [];
  const clicks: ClickEvent[] = [];
  const mutations: number[] = [];

  for (const e of events) {
    if (isClick(e)) clicks.push({ ts: e.timestamp, id: Number(e.data.id) });
    else if (isMutation(e)) mutations.push(e.timestamp);
  }

  // --- Rage click bursts ---
  // Group clicks by target id in sequence; a burst is ≥4 clicks on same id within 1000ms.
  const rageTargets = new Set<number>();
  const byTarget = new Map<number, number[]>();
  for (const c of clicks) {
    const arr = byTarget.get(c.id) ?? [];
    arr.push(c.ts);
    byTarget.set(c.id, arr);
  }
  for (const [id, times] of byTarget) {
    times.sort((a, b) => a - b);
    // Sliding window
    let i = 0;
    while (i < times.length) {
      let j = i;
      while (j + 1 < times.length && times[j + 1] - times[i] <= RAGE_WINDOW_MS) j++;
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
        i = j + 1;
      } else {
        i++;
      }
    }
  }

  // --- Dead clicks ---
  // A click is dead if no mutation occurs within DEAD_WINDOW_MS after it.
  // Skip clicks on rage-flagged targets (already represented by a stronger signal).
  mutations.sort((a, b) => a - b);
  for (const c of clicks) {
    if (rageTargets.has(c.id)) continue;
    const hasMutation = mutations.some(m => m >= c.ts && m - c.ts <= DEAD_WINDOW_MS);
    if (!hasMutation) {
      signals.push({ kind: 'dead_click', targetId: String(c.id), ts: c.ts });
    }
  }

  return signals;
}
```

- [ ] **Step 4: Run — expect pass**

```bash
npm test -- tests/preprocessor/clicks.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/preprocessor/clicks.ts tests/preprocessor/clicks.test.ts
git commit -m "feat: extract rage_click + dead_click signals"
```

---

## Task 7: Preprocessor orchestrator

**Files:**
- Create: `src/preprocessor/index.ts`
- Create: `tests/preprocessor/index.test.ts`

Combines all extractors and also derives session metadata (`url`, `userAgent`, `startedAt`, `durationMs`) from the type-51 context event and event timestamps.

- [ ] **Step 1: Write the failing test**

```ts
// tests/preprocessor/index.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { preprocess } from '../../src/preprocessor/index.ts';
import type { RawEvent } from '../../src/preprocessor/types.ts';

test('combines signals and derives metadata', () => {
  const events: RawEvent[] = [
    { type: 51, timestamp: 1000, data: { url: 'https://app.example/', userAgent: 'UA' } },
    { type: 52, timestamp: 1200, data: { message: 'boom' } },
    { type: 50, timestamp: 1400, data: { type: 'FETCH', url: '/x', method: 'GET', status: 500 } },
    { type: 3, timestamp: 1600, data: { source: 2, type: 2, id: 1 } },
    { type: 3, timestamp: 1700, data: { source: 2, type: 2, id: 1 } },
    { type: 3, timestamp: 1800, data: { source: 2, type: 2, id: 1 } },
    { type: 3, timestamp: 1900, data: { source: 2, type: 2, id: 1 } },
    { type: 2, timestamp: 2500, data: {} },
  ];
  const r = preprocess(events);
  assert.equal(r.url, 'https://app.example/');
  assert.equal(r.userAgent, 'UA');
  assert.equal(r.startedAt, 1000);
  assert.equal(r.durationMs, 1500); // 2500 - 1000
  assert.ok(r.signals.some(s => s.kind === 'js_error'));
  assert.ok(r.signals.some(s => s.kind === 'failed_request'));
  assert.ok(r.signals.some(s => s.kind === 'rage_click'));
});

test('handles missing context event gracefully', () => {
  const events: RawEvent[] = [
    { type: 52, timestamp: 500, data: { message: 'boom' } },
  ];
  const r = preprocess(events);
  assert.equal(r.url, '');
  assert.equal(r.userAgent, '');
  assert.equal(r.startedAt, 500);
  assert.equal(r.durationMs, 0);
  assert.equal(r.signals.length, 1);
});
```

- [ ] **Step 2: Run — expect failure**

- [ ] **Step 3: Implement**

```ts
// src/preprocessor/index.ts
import type { RawEvent, Signal } from './types.ts';
import { extractErrorSignals } from './errors.ts';
import { extractNetworkSignals } from './network.ts';
import { extractClickSignals } from './clicks.ts';

export type PreprocessResult = {
  url: string;
  userAgent: string;
  startedAt: number;
  durationMs: number;
  signals: Signal[];
  rawEventCount: number;
};

export function preprocess(events: RawEvent[]): PreprocessResult {
  const ctx = events.find(e => e.type === 51);
  const url = String(ctx?.data?.url ?? '');
  const userAgent = String(ctx?.data?.userAgent ?? '');

  const timestamps = events.map(e => e.timestamp).filter(n => Number.isFinite(n));
  const startedAt = timestamps.length ? Math.min(...timestamps) : Date.now();
  const endedAt = timestamps.length ? Math.max(...timestamps) : startedAt;

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
```

- [ ] **Step 4: Run — expect pass**

- [ ] **Step 5: Commit**

```bash
git add src/preprocessor/index.ts tests/preprocessor/index.test.ts
git commit -m "feat: preprocessor orchestrator"
```

---

## Task 9: Scorer

*(Task 8 intentionally omitted — task numbering continues to match build-order chunks.)*

**Files:**
- Create: `src/scorer.ts`
- Create: `tests/scorer.test.ts`

Pure function. Formula from spec §6.

- [ ] **Step 1: Write the failing test**

```ts
// tests/scorer.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { score } from '../src/scorer.ts';
import type { Signal } from '../src/preprocessor/types.ts';

function js(n: number): Signal[] {
  return Array.from({ length: n }, (_, i) => ({
    kind: 'js_error' as const, message: 'e', ts: i,
  }));
}

test('empty signals → score 0, bucket low', () => {
  const s = score([]);
  assert.equal(s.score, 0);
  assert.equal(s.bucket, 'low');
  assert.deepEqual(s.topReasons, []);
});

test('1 js_error → score 25, bucket low', () => {
  const s = score(js(1));
  assert.equal(s.score, 25);
  assert.equal(s.bucket, 'low');
});

test('3 js_errors → score 75, bucket high', () => {
  const s = score(js(3));
  assert.equal(s.score, 75);
  assert.equal(s.bucket, 'high');
});

test('per-signal cap at 3 occurrences', () => {
  const s = score(js(10));
  assert.equal(s.score, 75); // capped at 3 * 25
});

test('mixed signals accumulate', () => {
  const signals: Signal[] = [
    { kind: 'js_error', message: 'e', ts: 0 },
    { kind: 'rage_click', targetId: '1', count: 4, spanMs: 500, ts: 0 },
    { kind: 'failed_request', url: '/x', method: 'GET', status: 500, ts: 0 },
  ];
  // 25 + 15 + 10 = 50
  assert.equal(score(signals).score, 50);
});

test('4xx failed_request weighted 5, 5xx weighted 10', () => {
  const s1 = score([{ kind: 'failed_request', url: '/x', method: 'GET', status: 404, ts: 0 }]);
  assert.equal(s1.score, 5);
  const s2 = score([{ kind: 'failed_request', url: '/x', method: 'GET', status: 503, ts: 0 }]);
  assert.equal(s2.score, 10);
  const s3 = score([{ kind: 'failed_request', url: '/x', method: 'GET', status: 'network', ts: 0 }]);
  assert.equal(s3.score, 10);
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
  // First reason references js_error (weight 25, highest)
  assert.ok(s.topReasons[0].toLowerCase().includes('error'));
});
```

- [ ] **Step 2: Run — expect failure**

```bash
npm test -- tests/scorer.test.ts
```

- [ ] **Step 3: Implement**

```ts
// src/scorer.ts
import type { Signal } from './preprocessor/types.ts';

export type SessionScore = {
  score: number;
  bucket: 'high' | 'med' | 'low';
  topReasons: string[];
};

const CAP = 3;

type Bucket = {
  weight: number;
  matches: (s: Signal) => boolean;
  render: (count: number, sample?: Signal) => string;
};

const BUCKETS: Bucket[] = [
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
    render: (c, s) =>
      s && s.kind === 'rage_click'
        ? `rage click on #${s.targetId}`
        : `${c} rage click burst${c > 1 ? 's' : ''}`,
  },
  {
    weight: 10,
    matches: s =>
      s.kind === 'failed_request' && (s.status === 'network' || (typeof s.status === 'number' && s.status >= 500)),
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
      s.kind === 'failed_request' && typeof s.status === 'number' && s.status >= 400 && s.status < 500,
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

  contributions.sort((a, b) => b.weight - a.weight);

  const bucket: SessionScore['bucket'] =
    total >= 60 ? 'high' : total >= 30 ? 'med' : 'low';

  return {
    score: total,
    bucket,
    topReasons: contributions.slice(0, 3).map(c => c.reason),
  };
}
```

- [ ] **Step 4: Run — expect pass**

- [ ] **Step 5: Commit**

```bash
git add src/scorer.ts tests/scorer.test.ts
git commit -m "feat: weighted-sum session scorer"
```

---

## Task 10: Storage

**Files:**
- Create: `src/storage.ts`
- Create: `tests/storage.test.ts`

Responsibilities:
- `saveSession(record, rawEvents)` — writes `data/sessions/<id>.json` + `data/sessions/<id>.events.json`, updates `data/sessions.json` index.
- `listSessions()` — returns the index sorted by score desc (ties: `startedAt` desc).
- `getSession(id)` — returns `SessionRecord | null`.
- `getRawEvents(id)` — returns `RawEvent[]`.

Uses `crypto.randomUUID()` short-form for session ids (first 8 hex chars, per spec's `session-8a2f` style).

- [ ] **Step 1: Write the failing test**

```ts
// tests/storage.test.ts
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStorage } from '../src/storage.ts';
import type { SessionRecord } from '../src/storage.ts';

let dir: string;
let storage: ReturnType<typeof createStorage>;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'provv2-'));
  storage = createStorage(dir);
});
after(() => rmSync(dir, { recursive: true, force: true }));

test('saves and retrieves a session', async () => {
  const rec: SessionRecord = {
    id: 'abc12345',
    startedAt: 1000,
    durationMs: 500,
    url: '/',
    userAgent: 'UA',
    signals: [],
    score: { score: 25, bucket: 'low', topReasons: ['1 JS error'] },
    rawEventCount: 3,
  };
  await storage.saveSession(rec, [{ type: 2, timestamp: 1000, data: {} }]);
  const got = await storage.getSession('abc12345');
  assert.deepEqual(got, rec);
  const raw = await storage.getRawEvents('abc12345');
  assert.equal(raw.length, 1);
});

test('listSessions sorts by score desc, then recency desc', async () => {
  await storage.saveSession(
    { id: 'a', startedAt: 1, durationMs: 0, url: '', userAgent: '', signals: [], rawEventCount: 0,
      score: { score: 10, bucket: 'low', topReasons: [] } },
    [],
  );
  await storage.saveSession(
    { id: 'b', startedAt: 2, durationMs: 0, url: '', userAgent: '', signals: [], rawEventCount: 0,
      score: { score: 50, bucket: 'med', topReasons: [] } },
    [],
  );
  await storage.saveSession(
    { id: 'c', startedAt: 3, durationMs: 0, url: '', userAgent: '', signals: [], rawEventCount: 0,
      score: { score: 50, bucket: 'med', topReasons: [] } },
    [],
  );
  const list = await storage.listSessions();
  const ids = list.map(s => s.id);
  // b and c tied on score; c wins by recency
  assert.deepEqual(ids.slice(0, 3), ['c', 'b', 'a']);
});

test('getSession returns null for unknown id', async () => {
  assert.equal(await storage.getSession('nope'), null);
});
```

- [ ] **Step 2: Run — expect failure**

- [ ] **Step 3: Implement**

```ts
// src/storage.ts
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Signal } from './preprocessor/types.ts';
import type { SessionScore } from './scorer.ts';
import type { RawEvent } from './preprocessor/types.ts';

export type SessionRecord = {
  id: string;
  startedAt: number;
  durationMs: number;
  url: string;
  userAgent: string;
  signals: Signal[];
  score: SessionScore;
  rawEventCount: number;
};

type IndexEntry = Omit<SessionRecord, 'signals'>;

export function createStorage(dataDir: string) {
  const sessionsDir = join(dataDir, 'sessions');
  const indexPath = join(dataDir, 'sessions.json');

  async function ensureDirs() {
    await fs.mkdir(sessionsDir, { recursive: true });
  }

  async function readIndex(): Promise<IndexEntry[]> {
    try {
      const raw = await fs.readFile(indexPath, 'utf8');
      return JSON.parse(raw);
    } catch {
      return [];
    }
  }

  async function writeIndex(entries: IndexEntry[]) {
    await ensureDirs();
    await fs.writeFile(indexPath, JSON.stringify(entries, null, 2));
  }

  async function saveSession(record: SessionRecord, rawEvents: RawEvent[]) {
    await ensureDirs();
    await fs.writeFile(
      join(sessionsDir, `${record.id}.json`),
      JSON.stringify(record, null, 2),
    );
    await fs.writeFile(
      join(sessionsDir, `${record.id}.events.json`),
      JSON.stringify(rawEvents),
    );
    const index = await readIndex();
    const { signals, ...entry } = record;
    const filtered = index.filter(e => e.id !== record.id);
    filtered.push(entry);
    await writeIndex(filtered);
  }

  async function listSessions(): Promise<IndexEntry[]> {
    const index = await readIndex();
    return index.sort((a, b) => {
      if (b.score.score !== a.score.score) return b.score.score - a.score.score;
      return b.startedAt - a.startedAt;
    });
  }

  async function getSession(id: string): Promise<SessionRecord | null> {
    try {
      const raw = await fs.readFile(join(sessionsDir, `${id}.json`), 'utf8');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  async function getRawEvents(id: string): Promise<RawEvent[]> {
    try {
      const raw = await fs.readFile(join(sessionsDir, `${id}.events.json`), 'utf8');
      return JSON.parse(raw);
    } catch {
      return [];
    }
  }

  return { saveSession, listSessions, getSession, getRawEvents };
}

export function generateSessionId(): string {
  // 8-hex-char short id, e.g. "8a2f1c9e"
  return crypto.randomUUID().replace(/-/g, '').slice(0, 8);
}
```

- [ ] **Step 4: Run — expect pass**

- [ ] **Step 5: Commit**

```bash
git add src/storage.ts tests/storage.test.ts
git commit -m "feat: JSON filesystem storage"
```

---

## Task 11: Server — /capture wiring

**Files:**
- Create: `src/server.ts`

Minimal Express app exposing `/capture`, static `public/`, and placeholders for `/` and `/sessions/:id` that Tasks 12–13 fill in.

- [ ] **Step 1: Implement server.ts**

```ts
// src/server.ts
import 'dotenv/config';
import express from 'express';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { preprocess } from './preprocessor/index.ts';
import { score } from './scorer.ts';
import { createStorage, generateSessionId, type SessionRecord } from './storage.ts';
import { renderDashboard } from './views/dashboard.ts';
import { renderDetail } from './views/detail.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, '..', 'data');
const publicDir = join(__dirname, '..', 'public');

const storage = createStorage(dataDir);
const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.static(publicDir, { index: 'app.html' }));

app.post('/capture', async (req, res) => {
  try {
    const events = Array.isArray(req.body) ? req.body : [];
    const pre = preprocess(events);
    const record: SessionRecord = {
      id: generateSessionId(),
      startedAt: pre.startedAt,
      durationMs: pre.durationMs,
      url: pre.url,
      userAgent: pre.userAgent,
      signals: pre.signals,
      score: score(pre.signals),
      rawEventCount: pre.rawEventCount,
    };
    await storage.saveSession(record, events);
    res.json({ id: record.id, score: record.score });
  } catch (err) {
    console.error('capture failed', err);
    res.status(500).json({ error: 'capture failed' });
  }
});

app.get('/', async (_req, res) => {
  const sessions = await storage.listSessions();
  res.set('Content-Type', 'text/html').send(renderDashboard(sessions));
});

app.get('/sessions/:id', async (req, res) => {
  const record = await storage.getSession(req.params.id);
  if (!record) return res.status(404).send('Not found');
  res.set('Content-Type', 'text/html').send(await renderDetail(record));
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  console.log(`Providence V2 at http://localhost:${port}`);
});
```

- [ ] **Step 2: Smoke test /capture end-to-end**

Run in one terminal:
```bash
npm start
```

In another:
```bash
curl -X POST http://localhost:3000/capture \
  -H 'Content-Type: application/json' \
  -d '[{"type":52,"timestamp":1000,"data":{"message":"boom"}}]'
```

Expected: `{"id":"...","score":{"score":25,"bucket":"low","topReasons":["1 JS error"]}}`

Verify: `ls data/sessions/` shows `<id>.json` and `<id>.events.json`; `cat data/sessions.json` shows the index entry.

- [ ] **Step 3: Commit**

```bash
git add src/server.ts
git commit -m "feat: /capture endpoint wires preprocess + score + storage"
```

---

## Task 12: Dashboard view

**Files:**
- Create: `src/views/dashboard.ts`

Server-rendered HTML. Accepts the index entries from `storage.listSessions()`.

- [ ] **Step 1: Implement dashboard.ts**

```ts
// src/views/dashboard.ts
import type { SessionRecord } from '../storage.ts';

type IndexEntry = Omit<SessionRecord, 'signals'>;

const BUCKET_DOT: Record<string, string> = {
  high: '🔴',
  med: '🟠',
  low: '🟡',
};

function esc(s: string): string {
  return s.replace(/[&<>"']/g, c =>
    c === '&' ? '&amp;' :
    c === '<' ? '&lt;' :
    c === '>' ? '&gt;' :
    c === '"' ? '&quot;' : '&#39;');
}

function relTime(ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function renderDashboard(sessions: IndexEntry[]): string {
  const rows = sessions.slice(0, 50).map(s => `
    <a class="row bucket-${s.score.bucket}" href="/sessions/${esc(s.id)}">
      <span class="dot">${BUCKET_DOT[s.score.bucket] ?? '⚪'}</span>
      <span class="score">${s.score.score}</span>
      <span class="id">session-${esc(s.id)}</span>
      <span class="reasons">${esc(s.score.topReasons.join(' · ') || '—')}</span>
      <span class="when">${esc(relTime(s.startedAt))}</span>
    </a>
  `).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="refresh" content="10">
  <title>Providence V2 — Sessions</title>
  <style>
    body { font-family: ui-monospace, Menlo, monospace; max-width: 1000px; margin: 40px auto; padding: 0 20px; color: #222; }
    h1 { font-size: 18px; margin-bottom: 24px; }
    .row { display: grid; grid-template-columns: 30px 50px 120px 1fr 100px; gap: 12px;
           padding: 10px 6px; border-bottom: 1px solid #eee; text-decoration: none; color: inherit; align-items: center; }
    .row:hover { background: #fafafa; }
    .score { font-weight: 700; text-align: right; }
    .id { color: #555; }
    .reasons { color: #333; }
    .when { color: #999; text-align: right; }
    .empty { color: #999; padding: 40px; text-align: center; }
  </style>
</head>
<body>
  <h1>Providence V2 — Sessions needing attention (auto-refresh 10s)</h1>
  ${rows || '<div class="empty">No sessions captured yet.</div>'}
</body>
</html>`;
}
```

- [ ] **Step 2: Smoke test**

With the server running and at least one captured session (from Task 11), open `http://localhost:3000/` and confirm the row renders. Click the row; expect a 200 (content from Task 13 placeholder).

- [ ] **Step 3: Commit**

```bash
git add src/views/dashboard.ts
git commit -m "feat: ranked session dashboard"
```

---

## Task 13: LLM + detail view

**Files:**
- Create: `src/llm.ts`
- Create: `src/views/detail.ts`

LLM call is tightly scoped: input is a serialized signal list + session metadata; output is a 1–3 paragraph grounded narrative. No access to raw rrweb.

- [ ] **Step 1: Implement llm.ts**

```ts
// src/llm.ts
import OpenAI from 'openai';
import type { SessionRecord } from './storage.ts';

const openai = new OpenAI();

const SYSTEM_PROMPT = `You are Providence V2's session explainer. You receive a list of structured signals extracted from a browser session and must write a short, honest explanation of what happened.

Rules — you must follow all of these:
- Only reference signals that appear in the input. Do not invent causes or events.
- Acknowledge uncertainty. If the evidence is ambiguous, say so.
- Do not use narrative polish ("unfortunately", "the user was frustrated"). Be clinical.
- Do not speculate about the user's emotional state beyond what the evidence directly shows.
- Output 1–3 short paragraphs, plain prose, no markdown headings or lists.
- Do not make recommendations unless asked.`;

export async function explainSession(record: SessionRecord): Promise<string> {
  if (record.signals.length === 0) {
    return 'No signals were extracted from this session. There is no evidence of errors, failed requests, or user-frustration patterns.';
  }
  const user = JSON.stringify(
    {
      url: record.url,
      durationMs: record.durationMs,
      score: record.score,
      signals: record.signals,
    },
    null,
    2,
  );
  try {
    const res = await openai.chat.completions.create({
      model: 'gpt-5-nano',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: user },
      ],
    });
    return res.choices[0]?.message?.content?.trim() ?? '(no explanation)';
  } catch (err) {
    console.error('LLM call failed', err);
    return '(Explainer unavailable — LLM call failed. See evidence above.)';
  }
}
```

- [ ] **Step 2: Implement detail.ts**

```ts
// src/views/detail.ts
import type { SessionRecord } from '../storage.ts';
import { explainSession } from '../llm.ts';

function esc(s: string): string {
  return s.replace(/[&<>"']/g, c =>
    c === '&' ? '&amp;' :
    c === '<' ? '&lt;' :
    c === '>' ? '&gt;' :
    c === '"' ? '&quot;' : '&#39;');
}

function renderSignal(s: SessionRecord['signals'][number]): string {
  const ts = new Date(s.ts).toISOString().slice(11, 23);
  switch (s.kind) {
    case 'js_error':
      return `[${ts}] js_error — ${esc(s.message)}${s.url ? ` @ ${esc(s.url)}` : ''}`;
    case 'unhandled_rejection':
      return `[${ts}] unhandled_rejection — ${esc(s.reason)}`;
    case 'rage_click':
      return `[${ts}] rage_click — target #${esc(s.targetId)} (${s.count} clicks in ${s.spanMs}ms)`;
    case 'dead_click':
      return `[${ts}] dead_click — target #${esc(s.targetId)}`;
    case 'failed_request':
      return `[${ts}] failed_request — ${esc(s.method)} ${esc(s.url)} → ${s.status}`;
  }
}

export async function renderDetail(record: SessionRecord): Promise<string> {
  const explanation = await explainSession(record);
  const signalsHtml = record.signals.length
    ? record.signals.map(renderSignal).map(l => `<div>${l}</div>`).join('')
    : '<div class="empty">No signals.</div>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Session ${esc(record.id)}</title>
  <style>
    body { font-family: ui-monospace, Menlo, monospace; max-width: 900px; margin: 40px auto; padding: 0 20px; color: #222; }
    h1 { font-size: 16px; }
    .meta { color: #555; margin-bottom: 24px; }
    .section { margin: 24px 0; }
    .section h2 { font-size: 13px; text-transform: uppercase; color: #666; letter-spacing: 1px; margin-bottom: 8px; }
    .evidence div { padding: 4px 0; border-bottom: 1px solid #f0f0f0; font-size: 13px; }
    .explainer { background: #fafaf5; border-left: 3px solid #c9a227; padding: 12px 16px; white-space: pre-wrap; font-family: Georgia, serif; }
    .label { font-size: 11px; color: #999; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 4px; }
    a { color: #444; }
  </style>
</head>
<body>
  <div><a href="/">&larr; back to sessions</a></div>
  <h1>session-${esc(record.id)} — score ${record.score.score} (${record.score.bucket})</h1>
  <div class="meta">${esc(record.url || '(no url)')} · ${Math.round(record.durationMs / 1000)}s · ${esc(record.userAgent)}</div>

  <div class="section">
    <h2>Evidence (${record.signals.length} signals)</h2>
    <div class="evidence">${signalsHtml}</div>
  </div>

  <div class="section">
    <div class="label">Explainer (AI, grounded in signals above)</div>
    <div class="explainer">${esc(explanation)}</div>
  </div>
</body>
</html>`;
}
```

- [ ] **Step 3: Smoke test**

With `OPENAI_API_KEY` in `.env`, start the server and click a session row on the dashboard. Confirm:
- Signals list renders.
- Explainer paragraph appears below.
- Explainer references only signals in the list.

- [ ] **Step 4: Commit**

```bash
git add src/llm.ts src/views/detail.ts
git commit -m "feat: detail page with grounded LLM explainer"
```

---

## Task 14: Buggy demo app

**Files:**
- Create: `demo/index.html`

A single page that, when loaded and clicked through, deliberately generates:
- A JS error (from an inline `throw`)
- An unhandled promise rejection
- A rage-click target (button with a broken handler that doesn't mutate DOM)
- A dead-click target (a span styled like a button with no handler)
- A 500-returning fetch (hits a path the V2 server doesn't define → 404 today; for 500, mount a stub endpoint)

Note: Because V2's server doesn't have a `/always-500` endpoint, a 404 works fine for the signal (it's still in the 4xx failed_request bucket). If you want a 500 signal, add a trivial handler in `server.ts` under Task 11: `app.get('/demo/500', (_, res) => res.status(500).send('boom'))`.

- [ ] **Step 1: Write the demo page**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Providence V2 — Buggy Demo</title>
  <style>
    body { font-family: sans-serif; max-width: 600px; margin: 40px auto; padding: 0 20px; }
    button, .dead { padding: 10px 14px; margin: 6px; cursor: pointer; border: 1px solid #ccc; background: #f5f5f5; display: inline-block; }
    .dead { user-select: none; }
    #controls { position: fixed; top: 0; left: 0; right: 0; background: #111; color: #fff; padding: 10px 20px; z-index: 999; display: flex; justify-content: space-between; }
  </style>
</head>
<body>
  <div id="controls" class="rr-block">
    <span>Demo recording — <span id="event-count">0</span> events</span>
    <button id="stop-btn">Stop &amp; Send</button>
  </div>
  <h1 style="margin-top:60px">Buggy demo app</h1>
  <p>Click everything. Then press Stop &amp; Send.</p>

  <button onclick="throw new Error('Cannot read properties of undefined (reading &quot;checkout&quot;)')">Throw TypeError</button>

  <button onclick="Promise.reject(new Error('fetch failed: /api/user timeout'))">Reject promise</button>

  <button onclick="fetch('/demo/500')">Hit broken endpoint</button>

  <!-- Rage click target: handler exists but intentionally no-ops -->
  <button onclick="void 0">Broken checkout button</button>

  <!-- Dead click target: no handler, looks clickable -->
  <span class="dead">Looks clickable (no handler)</span>

  <script type="module" src="/agent.js"></script>
</body>
</html>
```

- [ ] **Step 2: Add /demo/500 route and serve demo page**

Add to `src/server.ts` (after static middleware):

```ts
app.get('/demo/500', (_req, res) => res.status(500).send('boom'));
app.get('/demo', (_req, res) => {
  res.sendFile(join(__dirname, '..', 'demo', 'index.html'));
});
```

- [ ] **Step 3: Commit**

```bash
git add demo src/server.ts
git commit -m "feat: buggy demo app for smoke testing"
```

---

## Task 15: End-to-end smoke test

Validates spec §15 success criteria.

- [ ] **Step 1: Run the full loop**

```bash
npm start
```

Open `http://localhost:3000/demo`. Perform this script:

1. Click "Throw TypeError" once.
2. Click "Reject promise" once.
3. Click "Hit broken endpoint" once.
4. Click "Broken checkout button" 5 times fast (rage click).
5. Click "Looks clickable (no handler)" once.
6. Click "Stop & Send".

- [ ] **Step 2: Capture a clean session**

Open `http://localhost:3000/` (the lab app at `public/app.html`). Interact harmlessly (type in inputs, scroll). Click "Stop & Send".

Actually — `http://localhost:3000/` now serves the dashboard. Navigate instead to `http://localhost:3000/app.html` for the original lab page. Interact and send.

- [ ] **Step 3: Verify ranking (spec §15 criterion 1 & 2)**

Open `http://localhost:3000/`. Expect:
- The demo session is at or near rank #1 with a score ≥60 (bucket "high").
- The clean session either appears far below or is not in the top 5.
- The demo session's reasons include "JS error" and "rage click".

- [ ] **Step 4: Verify LLM explainer (spec §15 criterion 3)**

Click the demo session row. Read the explainer. Confirm:
- It names `js_error`, `unhandled_rejection`, `failed_request`, `rage_click`, `dead_click` signals that are present.
- It does not invent events not in the evidence list (no "the user abandoned checkout" unless it's literally in the signals).
- It uses hedged language where evidence is thin.

- [ ] **Step 5: Record results**

Create `docs/superpowers/specs/smoke-test-results.md` and note:
- Actual demo session score.
- Actual clean session score.
- Any surprising rankings or explainer hallucinations.
- Whether each §15 criterion passed.

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/specs/smoke-test-results.md
git commit -m "test: document V2 smoke test results"
```

---

## Task 16 (stretch): Error-signature clustering

**Skip this task unless Tasks 1–15 are complete and there is time remaining.**

Adds a "top incidents" summary at the top of the dashboard, grouping sessions by normalized error message.

- [ ] **Step 1: Normalize error messages**

Create `src/incidents.ts`:

```ts
// src/incidents.ts
import type { SessionRecord } from './storage.ts';
type IndexEntry = Omit<SessionRecord, 'signals'>;

// Naive normalization: strip numbers, line/col refs, URLs.
// Good enough for a wedge; LLM-based clustering is a future upgrade.
export function normalizeErrorMessage(msg: string): string {
  return msg
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/:\d+:\d+/g, '')
    .replace(/\b\d+\b/g, '<n>')
    .trim();
}

export type Incident = { signature: string; sessionIds: string[]; count: number };

export async function topIncidents(
  entries: IndexEntry[],
  loadFull: (id: string) => Promise<SessionRecord | null>,
  limit = 5,
): Promise<Incident[]> {
  const groups = new Map<string, Set<string>>();
  for (const entry of entries) {
    const full = await loadFull(entry.id);
    if (!full) continue;
    for (const sig of full.signals) {
      if (sig.kind !== 'js_error') continue;
      const key = normalizeErrorMessage(sig.message);
      if (!groups.has(key)) groups.set(key, new Set());
      groups.get(key)!.add(full.id);
    }
  }
  return [...groups.entries()]
    .map(([signature, ids]) => ({ signature, sessionIds: [...ids], count: ids.size }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}
```

- [ ] **Step 2: Render incidents on dashboard**

Modify `src/views/dashboard.ts` to accept and render an `Incident[]` block above the session rows. Modify `server.ts` `GET /` to compute and pass them.

- [ ] **Step 3: Commit**

```bash
git add src/incidents.ts src/views/dashboard.ts src/server.ts
git commit -m "feat: error signature clustering on dashboard"
```

---

## Self-review notes

- **Spec §1 (thesis, cost/latency, core assumption):** covered by the overall architecture + Task 15 smoke test validates the core assumption.
- **Spec §2 (non-goals):** honored — no summaries, no chatbot, no embeddings, no replay player in this plan.
- **Spec §3 (architecture):** Tasks 2, 7, 9, 10, 11, 12, 13 map 1:1 to the architecture diagram's components.
- **Spec §4 (components table):** each row has a corresponding task.
- **Spec §5 (data shapes):** Signal (Task 3), SessionScore (Task 9), SessionRecord (Task 10).
- **Spec §6 (scorer formula):** Task 9 implements exactly this formula with the cap and tests the weights.
- **Spec §7 (signal definitions):** Tasks 4, 5, 6 implement each signal with the specified thresholds.
- **Spec §8 (dashboard):** Task 12 ships the ranked list, auto-refresh, top-50, no-pagination, bucket dots.
- **Spec §9 (detail page + LLM):** Task 13 ships the grounded explainer with the exact prompt constraints.
- **Spec §10 (V3/V4 roadmap):** non-scope; the plan preserves raw signals + static HTML dashboard to keep those roads open.
- **Spec §11 (mockup):** Task 12 matches it.
- **Spec §12 (stack):** used throughout.
- **Spec §13 (build order, 8 steps):** this plan's Tasks 2, 7, 9, 10, 11, 12, 13, 15, (16 stretch) map to the 8 steps.
- **Spec §14 (risks):** dead-click noise is addressable by dropping the signal (Task 6 weight / removing from scorer); rage-click threshold is tunable in Task 6 constants; LLM hallucination is constrained by Task 13 prompt; auto-refresh is ack'd as a known tradeoff in Task 12.
- **Spec §15 (success criteria):** Task 15 validates all four criteria directly.

Type consistency: `SessionScore`, `SessionRecord`, `Signal`, `RawEvent`, `IndexEntry` used with the same shapes across tasks. `createStorage` + `generateSessionId` exported consistently. Scorer named `score` everywhere.
