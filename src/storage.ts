import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { Signal, RawEvent } from './types.ts';
import type { SessionScore } from './scorer.ts';

// The complete persisted shape of a session after capture + scoring.
// Stored as JSON at data/sessions/<id>.json.
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

// What the index file stores — same as SessionRecord minus the `signals` array.
// Keeping `signals` out of the index keeps the index small and fast to scan
// for the dashboard. Full record (with signals) is fetched on detail-page load.
export type IndexEntry = Omit<SessionRecord, 'signals'>;

// `createStorage(dataDir)` returns an object with every filesystem operation
// the server needs. The rest of the codebase should never import `fs` directly.
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
      // Missing or malformed — treat as empty. This is correct on first run.
      return [];
    }
  }

  async function writeIndex(entries: IndexEntry[]) {
    await ensureDirs();
    await fs.writeFile(indexPath, JSON.stringify(entries, null, 2));
  }

  async function saveSession(record: SessionRecord, rawEvents: RawEvent[]) {
    await ensureDirs();
    // Full record with signals — what the detail page loads.
    await fs.writeFile(
      join(sessionsDir, `${record.id}.json`),
      JSON.stringify(record, null, 2),
    );
    // Raw rrweb events — separate file, big, only needed for debugging / replay.
    await fs.writeFile(
      join(sessionsDir, `${record.id}.events.json`),
      JSON.stringify(rawEvents),
    );
    // Update the index. Re-reads, filters out any prior entry with same id,
    // appends new entry, writes back. O(n) per save; fine for a wedge.
    const index = await readIndex();
    const { signals, ...entry } = record;
    const filtered = index.filter(e => e.id !== record.id);
    filtered.push(entry);
    await writeIndex(filtered);
  }

  async function listSessions(): Promise<IndexEntry[]> {
    const index = await readIndex();
    // Highest score first; recency breaks ties.
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

// Short hex id. Matches the spec's `session-8a2f` style for dashboard rows.
export function generateSessionId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 8);
}
