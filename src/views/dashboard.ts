import type { IndexEntry } from '../storage.ts';

const BUCKET_DOT: Record<string, string> = {
  high: '🔴',
  med: '🟠',
  low: '🟡',
};

// Minimal HTML-escape for interpolating untrusted strings (session ids, URLs,
// reasons). Prevents a malicious URL or userAgent from breaking the layout.
function esc(s: string): string {
  return s.replace(/[&<>"']/g, c =>
    c === '&' ? '&amp;' :
    c === '<' ? '&lt;' :
    c === '>' ? '&gt;' :
    c === '"' ? '&quot;' : '&#39;');
}

// Relative time formatter. Scannable at a glance — "2m ago" reads faster
// than "2026-04-21T00:42:13.817Z" when you're sweeping a list.
function relTime(ts: number, now = Date.now()): string {
  const diff = now - ts;
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

  const total = sessions.length;
  const highCount = sessions.filter(s => s.score.bucket === 'high').length;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="refresh" content="10">
  <title>Providence V2 — Sessions</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: ui-monospace, 'SF Mono', Menlo, monospace;
      max-width: 1000px; margin: 0 auto; padding: 40px 20px;
      color: #1a1a1a; background: #fafaf7;
    }
    header { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 24px; }
    h1 { font-size: 15px; font-weight: 600; margin: 0; letter-spacing: 0.5px; }
    .meta { color: #888; font-size: 12px; }
    .row {
      display: grid;
      grid-template-columns: 28px 56px 130px 1fr 90px;
      gap: 14px;
      padding: 12px 10px;
      border-bottom: 1px solid #eee;
      text-decoration: none;
      color: inherit;
      align-items: center;
      transition: background 80ms;
    }
    .row:hover { background: #f0efe9; }
    .dot { font-size: 14px; }
    .score { font-size: 20px; font-weight: 700; text-align: right; tabular-nums: true; font-variant-numeric: tabular-nums; }
    .bucket-high .score { color: #b42318; }
    .bucket-med  .score { color: #b54708; }
    .bucket-low  .score { color: #855c00; }
    .id { color: #666; font-size: 12px; }
    .reasons {
      color: #222;
      font-size: 13px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .when { color: #999; font-size: 12px; text-align: right; }
    .empty {
      padding: 60px 20px;
      text-align: center;
      color: #888;
      border: 1px dashed #ddd;
      border-radius: 6px;
    }
    .empty a { color: #333; }
  </style>
</head>
<body>
  <header>
    <h1>Providence V2 — sessions needing attention</h1>
    <span class="meta">${total} total · ${highCount} high · auto-refresh 10s</span>
  </header>
  ${rows || `<div class="empty">
    No sessions captured yet.<br>
    Visit <a href="/app.html">/app.html</a>, click the demo buttons, then press "Stop &amp; Send".
  </div>`}
</body>
</html>`;
}
