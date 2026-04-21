import 'dotenv/config';
import express from 'express';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { preprocess } from './extractors/index.ts';
import { score } from './scorer.ts';
import { createStorage, generateSessionId, type SessionRecord } from './storage.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, '..', 'data');
const publicDir = join(__dirname, '..', 'public');

const storage = createStorage(dataDir);
const app = express();
app.use(express.json({ limit: '50mb' }));

// Serve the browser agent + lab page from /public at their file paths
// (e.g. /agent.js, /app.html). We deliberately do NOT set { index: 'app.html' },
// because we want GET / to be the dashboard, not the lab.
app.use(express.static(publicDir));

// Core pipeline: raw events in → stored SessionRecord + score out.
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

// Dashboard — STUB. Task 12 replaces this with a pretty ranked list.
app.get('/', async (_req, res) => {
  const sessions = await storage.listSessions();
  const rows = sessions.map(s =>
    `<li><a href="/sessions/${s.id}">session-${s.id}</a> — score ${s.score.score} (${s.score.bucket}) — ${s.score.topReasons.join(' · ') || 'no signals'}</li>`
  ).join('\n');
  res.set('Content-Type', 'text/html').send(`<!DOCTYPE html>
<html><head><title>Providence V2 (stub)</title></head>
<body style="font-family:ui-monospace,monospace;max-width:900px;margin:40px auto;padding:0 20px">
  <h1>Providence V2 — sessions (stub)</h1>
  <p style="color:#888">Dashboard stub — Task 12 will make this pretty. Lab page: <a href="/app.html">/app.html</a></p>
  <ol>${rows || '<p>No sessions captured yet. Visit <a href="/app.html">/app.html</a>, click some buttons, then click "Stop &amp; Send".</p>'}</ol>
</body></html>`);
});

// Session detail — STUB. Task 13 replaces this with a timeline + LLM explainer.
app.get('/sessions/:id', async (req, res) => {
  const record = await storage.getSession(req.params.id);
  if (!record) return res.status(404).send('Not found');
  res.set('Content-Type', 'text/html').send(`<!DOCTYPE html>
<html><head><title>session-${record.id} (stub)</title></head>
<body style="font-family:ui-monospace,monospace;max-width:900px;margin:40px auto;padding:0 20px">
  <p><a href="/">&larr; back</a></p>
  <h1>session-${record.id} (stub)</h1>
  <p style="color:#888">Detail stub — Task 13 will add a signal timeline + LLM explainer.</p>
  <pre style="background:#f5f5f5;padding:16px;border-radius:6px;overflow:auto">${
    JSON.stringify(record, null, 2)
  }</pre>
</body></html>`);
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  console.log(`Providence V2 at http://localhost:${port}`);
  console.log(`  Dashboard: http://localhost:${port}/`);
  console.log(`  Lab page:  http://localhost:${port}/app.html`);
});
