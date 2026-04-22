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
// detail page is about scanning, not reading paragraphs. Target node ids
// are intentionally omitted; the replay player shows which element was
// clicked with far more fidelity than a numeric id ever could.
function signalSummary(s: Signal): string {
  switch (s.kind) {
    case 'js_error':
      return `${esc(s.message)}${s.url ? ` — ${esc(s.url)}` : ''}`;
    case 'unhandled_rejection':
      return esc(s.reason);
    case 'rage_click':
      return `${s.count} clicks in ${s.spanMs}ms`;
    case 'dead_click':
      return `no DOM reaction within 300ms`;
    case 'failed_request':
      return `${esc(s.method)} ${esc(s.url)} → ${s.status}`;
  }
}

export async function renderDetail(record: SessionRecord): Promise<string> {
  const explanation = await explainSession(record);

  // Each signal row gets a `data-ts` attribute carrying the signal's offset
  // from session start (ms). The inline script uses this for click-to-seek.
  const timeline = record.signals.length
    ? record.signals
        .map(s => `
          <div class="signal kind-${s.kind}" data-ts="${s.ts - record.startedAt}">
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
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/rrweb-player@2.0.0-alpha.11/dist/style.css">
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: ui-monospace, 'SF Mono', Menlo, monospace;
      max-width: 1400px; margin: 0 auto; padding: 40px 20px;
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

    /* Zone 2: signals sidebar + player, side by side */
    .investigate {
      display: grid;
      grid-template-columns: 25% 1fr;
      gap: 20px;
      margin-bottom: 28px;
    }
    .sidebar {
      max-height: 600px; overflow-y: auto;
      border-right: 1px solid #eee; padding-right: 14px;
    }
    .section-label {
      font-size: 11px; text-transform: uppercase; color: #888;
      letter-spacing: 1px; margin-bottom: 10px;
    }
    .signal {
      display: grid;
      grid-template-columns: 60px 20px 1fr;
      gap: 8px;
      padding: 8px 10px;
      border-bottom: 1px solid #eee;
      font-size: 12px;
      align-items: start;
      cursor: pointer;
      transition: background 80ms;
      border-radius: 3px;
    }
    .signal:hover { background: #f0efe9; }
    .signal.active { background: #fff4d6; }
    .signal .ts { color: #aaa; text-align: right; font-variant-numeric: tabular-nums; }
    .signal .icon { font-size: 13px; }
    .signal .kind {
      grid-column: 3; color: #666; font-size: 10px;
      text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 2px;
    }
    .signal .summary {
      grid-column: 3; color: #222; word-break: break-word; font-size: 12px;
    }
    .kind-js_error .summary { color: #b42318; }
    .kind-unhandled_rejection .summary { color: #b54708; }
    .kind-rage_click .kind { color: #b54708; font-weight: 700; }
    .kind-failed_request .summary { color: #b54708; }

    #replay-player {
      min-height: 500px;
      background: #111;
      border-radius: 6px;
      display: flex; align-items: center; justify-content: center;
      color: #888; font-size: 13px;
    }
    .player-loading::before { content: "Loading replay…"; }

    /* Zone 3: full-width explainer */
    .explainer-block { margin-top: 8px; }
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

    @media (max-width: 1100px) {
      .investigate { grid-template-columns: 1fr; }
      .sidebar { max-height: none; border-right: 0; padding-right: 0; }
    }
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

  <div class="investigate">
    <aside class="sidebar" id="signal-sidebar">
      <div class="section-label">Evidence — ${record.signals.length} signal${record.signals.length === 1 ? '' : 's'}</div>
      ${timeline}
    </aside>
    <div id="replay-player" class="player-loading"></div>
  </div>

  <div class="explainer-block">
    <div class="explainer-label">🤖 Explainer (AI, grounded in signals above)</div>
    <div class="explainer">${esc(explanation)}</div>
  </div>

  <script type="module">
    import rrwebPlayer from 'https://cdn.jsdelivr.net/npm/rrweb-player@2.0.0-alpha.11/+esm';

    const sessionId = ${JSON.stringify(record.id)};
    const container = document.getElementById('replay-player');
    const sidebar = document.getElementById('signal-sidebar');

    let player = null;

    try {
      const res = await fetch(\`/sessions/\${sessionId}/events\`);
      const events = await res.json();
      container.classList.remove('player-loading');
      container.innerHTML = '';
      player = new rrwebPlayer({
        target: container,
        props: {
          events,
          autoPlay: false,
          showController: true,
          width: container.clientWidth,
          height: 480,
        },
      });
    } catch (err) {
      container.classList.remove('player-loading');
      container.textContent = 'Replay failed to load: ' + (err && err.message ? err.message : err);
    }

    // Click-to-seek: delegated handler on the sidebar. Each .signal row
    // carries data-ts = offset from session start (ms). player.goto() seeks
    // to that offset. Also toggles an .active highlight on the clicked row.
    sidebar.addEventListener('click', (e) => {
      const row = e.target.closest('.signal[data-ts]');
      if (!row || !player) return;
      const ts = Number(row.dataset.ts);
      if (!Number.isFinite(ts)) return;
      player.goto(ts);
      sidebar.querySelectorAll('.signal.active').forEach(el => el.classList.remove('active'));
      row.classList.add('active');
    });
  </script>
</body>
</html>`;
}
