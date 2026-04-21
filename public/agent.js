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

// Send events to /capture. Uses sendBeacon on unload for reliability,
// and regular fetch when the user clicks "Stop & Send".
// The `sent` guard prevents double-posting when both the Stop button AND
// beforeunload fire for the same session (click Stop → navigate away).
let sent = false;
async function sendEvents() {
  if (sent) return;
  sent = true;
  const payload = JSON.stringify(events);
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
