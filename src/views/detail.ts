import type { SessionRecord } from '../storage.ts';
import type { Signal } from '../types.ts';
import { explainSession } from '../llm.ts';

function esc(s: string): string {
  return s.replace(/[&<>"']/g, c =>
    c === '&' ? '&amp;' :
    c === '<' ? '&lt;' :
    c === '>' ? '&gt;' :
    c === '"' ? '&quot;' : '&#39;');
}

const SIGNAL_ICON: Record<Signal['kind'], string> = {
  js_error: '💥',
  unhandled_rejection: '⚠️',
  rage_click: '⚡',
  dead_click: '💤',
  failed_request: '🔌',
};

// Format timestamp relative to session start so the timeline reads naturally.
// "+2.3s" is more meaningful than "22:49:13.817" when scanning evidence.
function relTs(ts: number, sessionStart: number): string {
  const sec = (ts - sessionStart) / 1000;
  return sec < 10
    ? `+${sec.toFixed(2)}s`
    : sec < 60
      ? `+${sec.toFixed(1)}s`
      : `+${Math.floor(sec / 60)}m${Math.floor(sec % 60)}s`;
}

// One-line human summary of a single signal. Deliberately terse — the
// detail page is about scanning, not reading paragraphs.
function signalSummary(s: Signal): string {
  switch (s.kind) {
    case 'js_error':
      return `${esc(s.message)}${s.url ? ` — ${esc(s.url)}` : ''}`;
    case 'unhandled_rejection':
      return esc(s.reason);
    case 'rage_click':
      return `target #${esc(s.targetId)} — ${s.count} clicks in ${s.spanMs}ms`;
    case 'dead_click':
      return `target #${esc(s.targetId)} — no DOM reaction within 300ms`;
    case 'failed_request':
      return `${esc(s.method)} ${esc(s.url)} → ${s.status}`;
  }
}

export async function renderDetail(record: SessionRecord): Promise<string> {
  const explanation = await explainSession(record);

  const timeline = record.signals.length
    ? record.signals
        .map(s => `
          <div class="signal kind-${s.kind}">
            <span class="ts">${relTs(s.ts, record.startedAt)}</span>
            <span class="icon">${SIGNAL_ICON[s.kind]}</span>
            <span class="kind">${s.kind}</span>
            <span class="summary">${signalSummary(s)}</span>
          </div>`)
        .join('')
    : '<div class="empty">No signals extracted from this session.</div>';

  const durationSec = Math.round(record.durationMs / 1000);
  const bucketColor = record.score.bucket === 'high' ? '#b42318'
                    : record.score.bucket === 'med'  ? '#b54708'
                    :                                   '#855c00';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>session-${esc(record.id)}</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: ui-monospace, 'SF Mono', Menlo, monospace;
      max-width: 960px; margin: 0 auto; padding: 40px 20px;
      color: #1a1a1a; background: #fafaf7;
    }
    a { color: #444; }
    .back { font-size: 12px; color: #888; margin-bottom: 20px; display: inline-block; }
    header { border-bottom: 1px solid #ddd; padding-bottom: 16px; margin-bottom: 24px; }
    h1 {
      font-size: 16px; font-weight: 600; margin: 0 0 6px 0;
      display: flex; align-items: baseline; gap: 14px;
    }
    .score-badge {
      font-size: 20px; font-weight: 700; color: ${bucketColor};
      font-variant-numeric: tabular-nums;
    }
    .bucket {
      font-size: 11px; text-transform: uppercase; letter-spacing: 1px;
      padding: 2px 8px; border-radius: 3px; background: #f0f0f0; color: #555;
    }
    .meta { color: #888; font-size: 12px; line-height: 1.6; }
    .meta span + span::before { content: " · "; color: #ccc; }
    .section-label {
      font-size: 11px; text-transform: uppercase; color: #888;
      letter-spacing: 1px; margin-bottom: 10px;
    }
    .section { margin: 28px 0; }
    .signal {
      display: grid;
      grid-template-columns: 70px 24px 140px 1fr;
      gap: 12px;
      padding: 8px 10px;
      border-bottom: 1px solid #eee;
      font-size: 13px;
      align-items: start;
    }
    .signal .ts {
      color: #aaa; text-align: right;
      font-variant-numeric: tabular-nums;
    }
    .signal .icon { font-size: 14px; }
    .signal .kind {
      color: #666; font-size: 11px;
      text-transform: uppercase; letter-spacing: 0.5px;
      padding-top: 2px;
    }
    .signal .summary { color: #222; word-break: break-word; }
    .kind-js_error .summary { color: #b42318; }
    .kind-unhandled_rejection .summary { color: #b54708; }
    .kind-rage_click .kind { color: #b54708; font-weight: 700; }
    .kind-failed_request .summary { color: #b54708; }

    .explainer {
      background: #fffcf0;
      border-left: 3px solid #c9a227;
      padding: 16px 20px;
      font-family: Georgia, 'Times New Roman', serif;
      font-size: 14px;
      line-height: 1.6;
      color: #333;
      white-space: pre-wrap;
      border-radius: 0 4px 4px 0;
    }
    .explainer-label {
      display: flex; align-items: center; gap: 6px;
      font-size: 11px; text-transform: uppercase; color: #888;
      letter-spacing: 1px; margin-bottom: 10px;
    }
    .empty { color: #aaa; padding: 20px; text-align: center; }
  </style>
</head>
<body>
  <a class="back" href="/">&larr; back to sessions</a>
  <header>
    <h1>
      <span>session-${esc(record.id)}</span>
      <span class="score-badge">${record.score.score}</span>
      <span class="bucket">${esc(record.score.bucket)}</span>
    </h1>
    <div class="meta">
      <span>${esc(record.url || '(no url)')}</span>
      <span>${durationSec}s</span>
      <span>${record.rawEventCount} raw events</span>
      <span>${record.signals.length} signals</span>
    </div>
  </header>

  <div class="section">
    <div class="section-label">Evidence — ${record.signals.length} signal${record.signals.length === 1 ? '' : 's'}</div>
    ${timeline}
  </div>

  <div class="section">
    <div class="explainer-label">🤖 Explainer (AI, grounded in signals above)</div>
    <div class="explainer">${esc(explanation)}</div>
  </div>
</body>
</html>`;
}
