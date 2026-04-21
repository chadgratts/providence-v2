import 'dotenv/config';
import express from 'express';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { preprocess } from './extractors/index.ts';
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

// Dashboard — ranked list of sessions by severity.
app.get('/', async (_req, res) => {
  const sessions = await storage.listSessions();
  res.set('Content-Type', 'text/html').send(renderDashboard(sessions));
});

// Session detail — signal timeline + grounded LLM explainer.
app.get('/sessions/:id', async (req, res) => {
  const record = await storage.getSession(req.params.id);
  if (!record) return res.status(404).send('Not found');
  res.set('Content-Type', 'text/html').send(await renderDetail(record));
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  console.log(`Providence V2 at http://localhost:${port}`);
  console.log(`  Dashboard: http://localhost:${port}/`);
  console.log(`  Lab page:  http://localhost:${port}/app.html`);
});
