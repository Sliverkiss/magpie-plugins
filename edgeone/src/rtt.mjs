// dsh2api — adaptive RPC timeouts from round-trip EMAs.
//
// Design borrowed from diaoxiaoniu/DSH2API internal/rtt (itself R3 of its
// audit series): fixed deadlines are the wrong shape for an upstream whose
// latency swings 4× between healthy and degraded windows — a fixed 20s cap
// "kills" slow-but-alive requests exactly when the upstream needs patience,
// and retry ladders turn one slow window into several wasted attempts.
//
// Rules that make the signal trustworthy (kept verbatim from the reference):
//   - Only SUCCESSFUL calls are recorded: a timeout says nothing about the
//     RTT distribution it never completed, and failures arrive in bursts
//     that would poison the EMA exactly when adaptation matters.
//   - The degraded-window blind spot (no successes → EMA frozen at the old
//     level) is covered by a watermark: the duration of the most recently
//     ABANDONED attempt. A success clears it — the window recovered.
//   - The guard never narrows below the family's floor (the measured
//     healthy-weather default), and never exceeds the cap (a hung upstream
//     must still fail within the retry budget).

const ALPHA = 0.3; // tracks a 4× swing within ~4 observations, ignores single outliers

export const RTT_CAP_MS = 45_000;

export class RttRecorder {
  #ema = new Map();    // family → ms
  #mark = new Map();   // family → abandoned-attempt duration (ms)

  recordSuccess(family, ms) {
    const prev = this.#ema.get(family);
    this.#ema.set(family, prev === undefined ? ms : ALPHA * ms + (1 - ALPHA) * prev);
    this.#mark.delete(family);
  }

  recordAbandoned(family, ms) {
    this.#mark.set(family, ms);
  }

  // ema: latest success EMA (undefined before the first observation).
  // mark: duration of the last abandoned attempt (undefined if the last call succeeded).
  snapshot(family) {
    return { ema: this.#ema.get(family), mark: this.#mark.get(family) };
  }
}

// The guard: max(floor, 2×EMA, min(watermark, CAP)) capped at CAP. A pure
// function of the snapshot so tests can pin every branch.
export function adaptiveTimeoutMs(snap, floorMs, capMs = RTT_CAP_MS) {
  let ms = floorMs;
  if (snap?.ema !== undefined) ms = Math.max(ms, 2 * snap.ema);
  if (snap?.mark !== undefined) ms = Math.max(ms, Math.min(snap.mark, capMs));
  return Math.min(ms, capMs);
}
