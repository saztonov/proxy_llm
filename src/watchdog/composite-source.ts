import type { ActiveSource } from './ticker.js';

/** Один watchdog над живыми запросами нескольких контуров. */
export function combineActiveSources(...sources: ActiveSource[]): ActiveSource {
  return {
    snapshot: () => sources.flatMap((s) => s.snapshot()),
    abort: (requestId) => {
      for (const s of sources) s.abort(requestId);
    },
  };
}
