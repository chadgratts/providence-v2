// Shape of a raw event coming out of the browser agent.
// The agent emits:
//   - rrweb native events (types 0-6)
//   - type 50: fetch request/response (custom)
//   - type 51: session context (custom)
//   - type 52: uncaught JS error (custom, new in V2)
//   - type 53: unhandled promise rejection (custom, new in V2)
export type RawEvent = {
  type: number;
  timestamp: number;
  data: any;
};

// Signals are the structured evidence the preprocessor emits.
// Each variant carries ONLY its own evidence fields — no interpretive labels.
// Downstream consumers (scorer, views) branch on `kind`.
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
