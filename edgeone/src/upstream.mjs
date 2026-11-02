// dsh2api — upstream protocol layer for deepseek-harness (EdgeOne Makers).
// Protocol reverse-engineered from the live site on 2026-09-29 and
// re-verified live on 2026-11-02.
//
// Transport summary (recon §1):
//   - Base: https://deepseek-harness.edgeone.cool
//   - Isolation: header `makers-conversation-id: <uuid>` on every request.
//     A fresh UUID = a fresh anonymous workspace; reuse = persistence.
//     There is NO auth token and NO cookie anywhere in the protocol.
//   - Unary RPC: POST /api/{method} with a four-quadrant envelope
//       {type:"client-request", rpcId, method, payload}
//     answered by {type:"server-response", rpcId, result:{ok, value|error}}.
//     Business errors arrive as HTTP 200 with result.ok=false — the HTTP
//     status only distinguishes unknown methods (404) and CDN failures (5xx).
//   - SSE downlink: GET /api/events.mux (same conv header). Frames arrive as
//     `data: {type:"server-request", rpcId, method, payload}` — the payload
//     is a MuxFrame whose `method` is the frame kind ("session/event", …).
//     No heartbeat upstream; a stalled body is silence, not slowness.
//
// Every request here carries its OWN deadline (see timeBox): the upstream
// hangs occasionally (a stalled events.mux is silence, not slowness) and the
// magpie chat loop has no per-request timeout, so a missing one here shows up
// to the user as a dead UI.

import { RttRecorder, adaptiveTimeoutMs } from "./rtt.mjs";

export const BASE = "https://deepseek-harness.edgeone.cool";
export const PROVIDER = "dsh2api";

// One recorder per process, per RPC family (method name). Exposed for tests.
export const rtt = new RttRecorder();

// Deadlines (ms). Measured on the live upstream 2026-11-02: unary RPCs answer
// in 0.2–2s, one agent turn runs 2–35s, three turns plus setup finished in
// 41s. The budgets below are that reality with room, not guesses.
export const HANG_TEST_MS = 15_000;       // is a wedged conv still alive?
export const UNARY_TIMEOUT_MS = 20_000;   // one unary attempt incl. body parse
export const UNARY_BUDGET_MS = 60_000;    // one unary incl. retry backoffs
export const IDLE_TIMEOUT_MS = 40_000;    // no SSE line for this long
export const PROMPT_TIMEOUT_MS = 30_000;  // session.prompt submit (never retried)
export const HISTORY_TIMEOUT_MS = 20_000; // one session.history poll

// The SSE head is SLOW and flaky: measured 2026-11-02, five opens gave
// 2.5s / 3.2s / 5.8s and two never answered at all (EdgeOne dropped the
// connection). The tail is therefore given its own, SHORT budget: a missing
// tail costs only poll latency (session.history is authoritative and carries
// the same deltas), while waiting for it costs the user tens of seconds of
// silence before their prompt is even submitted.
export const MUX_HEAD_TIMEOUT_MS = 8_000;

// The site speaks to a Chrome 140 / Windows persona; a mismatched UA+CH
// triple is a stronger bot signal than a plain node UA (r5-spec §F2).
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const SEC_CH_UA = '"Google Chrome";v="140", "Not_A Brand";v="24", "Chromium";v="140"';

export function browserHeaders(extra = {}) {
  return {
    "user-agent": UA,
    "sec-ch-ua": SEC_CH_UA,
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    accept: "*/*",
    "accept-language": "en-US,en;q=0.9",
    origin: BASE,
    referer: BASE + "/",
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "cors",
    "sec-fetch-dest": "empty",
    ...extra,
  };
}

export class DshError extends Error {
  constructor(code, message, details) {
    super(details ? `dsh: ${code}: ${message} (${details})` : `dsh: ${code}: ${message}`);
    this.name = "DshError";
    this.code = code;
  }
  get isNotFound() { return this.code === "session-not-found"; }
  get isBusy() { return this.code === "agent-busy"; }
  get isModelUnavailable() { return this.code === "model-unavailable"; }
  // Transient: worth another attempt with fresh state. Live-verified shapes:
  // HTTP 200 + result.ok:false carries business codes (never retried); only
  // the CDN gateway's 5xx and transport failures land here.
  get isTransient() {
    return this.code === "bad-gateway" || this.code === "timeout" ||
      this.code === "dns-failure" || this.code === "connection-reset";
  }
}

// (TimeoutError is already exported at its declaration above.)

export const newConvId = () => crypto.randomUUID();

// ---------------------------------------------------------------------------
// deadlines
// ---------------------------------------------------------------------------

export function abortErr(reason = "aborted") {
  return new DOMException(reason instanceof Error ? reason.message : String(reason), "AbortError");
}

// The watchdog's abort reason: a typed, transient transport failure — NOT an
// AbortError (an outer client abort must stay distinguishable from our own
// deadline firing).
export class TimeoutError extends Error {
  constructor(ms) { super(`deadline ${typeof ms === "number" ? ms + "ms" : ms} exceeded`); this.name = "DshTimeout"; this.code = "timeout"; }
}
const up_Timeout = TimeoutError;

// sleep that rejects on abort (and never leaves a listener behind)
export function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? abortErr());
    const t = setTimeout(done, ms);
    const onAbort = () => { clearTimeout(t); reject(signal.reason ?? abortErr()); };
    function done() { signal?.removeEventListener("abort", onAbort); resolve(); }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// A fetch + `ms` deadline that also releases the response body. `fetch` and
// `ms` are both injectable so tests can arm a watchdog without real network.
// The deadline abort throws a DshError("timeout") — a transport failure the
// caller can classify as transient — while an OUTER abort keeps the caller's
// own reason (a client abort must never read as a retryable timeout).
export async function fetchTimed(url, init = {}, ms = UNARY_TIMEOUT_MS, fetchImpl = fetch, { bodyDeadline = true } = {}) {
  const ac = new AbortController();
  const outer = init.signal;
  const timer = setTimeout(() => ac.abort(new up_Timeout(ms)), ms);
  const onOuter = () => ac.abort(outer?.reason ?? abortErr());
  if (outer?.aborted) { clearTimeout(timer); throw outer.reason ?? abortErr(); }
  outer?.addEventListener("abort", onOuter, { once: true });
  try {
    const res = await fetchImpl(url, { ...init, signal: ac.signal });
    // The caller owns res.body; arm a body deadline too, because a response
    // whose head arrived but whose body stalls is exactly the hang we must
    // not sit on. abortSignal() keeps the signal alive for the body's life.
    // An OUTER abort that lands while the body is being consumed must wake
    // the parked reader with the client's own reason — same contract as the
    // fetch stage above, otherwise a client hang-up reads as our timeout.
    if (outer?.aborted) { clearTimeout(timer); throw outer.reason ?? abortErr(); }
    // Long-lived tails (events.mux) opt out of the body deadline: the tail is
    // EXPECTED to outlive any fixed budget (a turn runs up to 240s), and its
    // consumer runs the real watchdog (idle-gap + turn cap). Leaving the
    // deadline armed would kill every tail at `ms` — measured: the tail died
    // at exactly 25,014ms with a DshTimeout while the turn was still running,
    // which made the pump's own 40s idle watchdog dead code.
    if (!bodyDeadline) clearTimeout(timer);
    return withBodyDeadline(res, ac, timer, outer);
  } catch (e) {
    clearTimeout(timer);
    if (outer?.aborted) throw outer.reason ?? abortErr();
    if (e instanceof TimeoutError || e?.code === "timeout") throw e;
    // fetch implementations surface a deadline abort as AbortError — re-tag
    // it so callers never confuse our watchdog with a client abort.
    if (e?.name === "AbortError") throw new TimeoutError(ms);
    throw e;
  } finally {
    outer?.removeEventListener("abort", onOuter);
  }
}

// Arms the body deadline: when the timer fires, the response body's original
// controller errors — so a caller parked in res.json()/reader.read() wakes up
// with a TimeoutError instead of sitting on a stalled stream forever. The
// timer releases when the body settles (or is cancelled by the consumer).
function withBodyDeadline(res, ac, timer, outer) {
  if (!res.body) { clearTimeout(timer); return res; }
  let released = false;
  // onOuterAbort is hoisted so release() can unhook it: without this, every
  // normally-completed body left one abort listener pinned on the caller's
  // signal for the signal's remaining life (bounded, but pure waste on the
  // hot path — one fetch per turn).
  let onOuterAbort = null;
  const release = () => {
    if (released) return;
    released = true;
    clearTimeout(timer);
    if (onOuterAbort && outer) outer.removeEventListener("abort", onOuterAbort);
  };
  const original = res.body;
  // Wrap the underlying source so we can error it on deadline and observe
  // the consumer's cancel().
  const guarded = new ReadableStream({
    async start(ctrl) {
      const reader = original.getReader();
      const onAbort = () => {
        release();
        // The reason carries the distinction: watchdog firing set a
        // TimeoutError; an outer client abort set the caller's own reason.
        const err = ac.signal.reason instanceof Error ? ac.signal.reason : new TimeoutError("body");
        try { ctrl.error(err); } catch {}
        try { reader.cancel(err).catch(() => {}); } catch {}
      };
      ac.signal.addEventListener("abort", onAbort, { once: true });
      // Bridge an outer client abort into the inner controller for the whole
      // body lifetime (fetchTimed's own bridge ends at its finally). once:
      // the first abort settles the stream, after which the bridge is dead.
      onOuterAbort = () => ac.abort(outer?.reason ?? abortErr());
      if (outer?.aborted) { onOuterAbort(); return; }
      outer?.addEventListener("abort", onOuterAbort, { once: true });
      for (;;) {
        let chunk;
        try { chunk = await reader.read(); }
        catch (e) {
          release();
          try { ctrl.error(e); } catch {}
          return;
        }
        if (chunk.done) {
          release();
          try { ctrl.close(); } catch {}
          return;
        }
        ctrl.enqueue(chunk.value);
      }
    },
    cancel(reason) {
      release();
      try { original.cancel(reason).catch(() => {}); } catch {}
    },
  });
  return new Response(guarded, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
}

// ---------------------------------------------------------------------------
// unary RPC
// ---------------------------------------------------------------------------

// One unary RPC attempt. Returns the envelope's result.value; throws
// DshError (typed) or a transport Error.
async function rpcOnce(convId, method, body, signal, fetchImpl, timeoutMs) {
  const res = await fetchTimed(`${BASE}/api/${method}`, {
    method: "POST",
    headers: browserHeaders({ "content-type": "application/json", "makers-conversation-id": convId }),
    body,
    signal,
  }, timeoutMs, fetchImpl);
  if (res.status !== 200) {
    await res.body?.cancel().catch(() => {});
    // Unknown method → 404 (no JSON body); CDN 502/504 are retryable.
    throw new DshError(res.status >= 500 ? "bad-gateway" : `http-${res.status}`, `HTTP ${res.status} from ${method}`);
  }
  let env;
  try { env = await res.json(); }
  catch (e) {
    // Our own deadlines surface through the body reader — they are NOT
    // "unparseable response", they are the retryable timeout they always were.
    if (e instanceof TimeoutError || e?.code === "timeout" || e?.name === "AbortError") {
      await res.body?.cancel().catch(() => {});
      throw e;
    }
    await res.body?.cancel().catch(() => {});
    // A gateway error page (EdgeOne HTML on a 200) is a transport failure,
    // not a business answer — classify it as retryable.
    throw new DshError("bad-gateway", `${method}: unparseable response: ${String(e?.message ?? e).slice(0, 120)}`);
  }
  if (env?.type !== "server-response") throw new DshError("bad-envelope", `${method}: unexpected envelope type ${env?.type}`);
  if (env.rpcId !== undefined && env.rpcId === null) throw new DshError("bad-envelope", `${method}: missing rpcId echo`);
  if (!env.result) throw new DshError("bad-envelope", `${method}: missing result`);
  if (!env.result.ok) {
    const e = env.result.error ?? { code: "internal", message: "ok:false with no error object" };
    throw new DshError(e.code, e.message ?? "", typeof e.details === "string" ? e.details : undefined);
  }
  return env.result.value;
}

// One unary RPC. `retryable` ids (session.create / history / models …) get a
// bounded second attempt on transient failures only, with backoff;
// session.prompt is NEVER retried — a transport failure may still have queued
// the prompt and a double-queue corrupts the turn (proposal B §4.5).
//
// `budgetMs` caps the whole call including backoff, and `attempts` is the
// ceiling; both are injectable so tests do not sit through real backoff.
export async function rpc(convId, method, payload, {
  retryable = false, signal, fetchImpl = fetch,
  attempts = retryable ? 3 : 1, backoff = [0, 1000, 3000],
  budgetMs = UNARY_BUDGET_MS, timeoutMs,
} = {}) {
  const rpcId = crypto.randomUUID();
  const body = JSON.stringify({ type: "client-request", rpcId, method, payload: payload ?? {} });
  const deadline = Date.now() + budgetMs;
  const max = Math.max(1, Math.min(attempts, backoff.length));
  let lastErr;
  for (let i = 0; i < max; i++) {
    if (i > 0) {
      const wait = backoff[i];
      if (Date.now() + wait >= deadline) break; // no room left: surface lastErr
      await delay(wait, signal);
    }
    const room = deadline - Date.now();
    if (room <= 0) break;
    // Adaptive guard: a family with no explicit timeout reads max(floor,
    // 2×EMA, watermark) — slow-but-alive windows get patience, hung ones
    // still fail inside the retry budget (src/rtt.mjs).
    const per = timeoutMs ?? adaptiveTimeoutMs(rtt.snapshot(method), UNARY_TIMEOUT_MS);
    const t0 = Date.now();
    try {
      const v = await rpcOnce(convId, method, body, signal, fetchImpl, Math.min(per, room));
      rtt.recordSuccess(method, Date.now() - t0);
      return v;
    } catch (err) {
      // An outer abort is never ours to swallow or retry.
      if (err?.name === "AbortError") throw err;
      if (err instanceof TimeoutError || err?.code === "timeout") rtt.recordAbandoned(method, Date.now() - t0);
      lastErr = err;
      // A typed business answer (ok:false, or 404 for an unknown method) is a
      // semantic result — never retried. Only transient failures are
      // (TimeoutError from our watchdog, DshError bad-gateway, plain transport).
      const transient = !(err instanceof DshError) || err.isTransient;
      if (!transient || i === max - 1) throw err;
    }
  }
  throw lastErr ?? new DshError("timeout", `${method}: budget ${budgetMs}ms exhausted`);
}

export async function createSession(convId, agentPreset = "makers", opts) {
  const v = await rpc(convId, "session.create", agentPreset ? { agentPreset } : {}, { ...opts, retryable: true });
  return { sessionId: v.sessionId, agentPreset: v.agentPreset };
}

export async function selectModel(convId, sessionId, provider, model, opts) {
  await rpc(convId, "session.selectModel", { sessionId, provider, model, ...(opts?.reasoningEffort ? { reasoningEffort: opts.reasoningEffort } : {}) }, { ...opts, retryable: true });
}

export async function prompt(convId, sessionId, text, opts) {
  await rpc(convId, "session.prompt", {
    sessionId,
    mode: "queue",
    content: [{ type: "text", text }],
  }, { ...opts, retryable: false, timeoutMs: PROMPT_TIMEOUT_MS });
}

export async function cancel(convId, sessionId, opts) {
  await rpc(convId, "session.cancel", { sessionId }, { ...opts, retryable: true, attempts: 2, budgetMs: 15_000 });
}

export async function history(convId, sessionId, { beforeSeq, max } = {}, opts) {
  const payload = { sessionId };
  if (beforeSeq > 0) payload.beforeSeq = beforeSeq;
  if (max > 0) payload.maxMessages = max;
  const v = await rpc(convId, "session.history", payload, { ...opts, retryable: true, timeoutMs: HISTORY_TIMEOUT_MS });
  return { events: v.events ?? [], hasMore: !!v.hasMore };
}

export async function llmModels(convId, opts) {
  const v = await rpc(convId, "llm.models", {}, { ...opts, retryable: true });
  return { groups: v.groups ?? [], failures: v.failures };
}

// Cheap liveness/capacity probe for a conversation: does it still answer a
// unary RPC? A conversation that has been reaped by the upstream says
// session-not-found here, so a pooled session can be validated before it is
// reused (the alternative — discovering it mid-turn — costs the user a turn).
export async function probeConversation(convId, opts = {}) {
  await rpc(convId, "llm.models", {}, { ...opts, retryable: false, timeoutMs: opts.timeoutMs ?? HANG_TEST_MS, budgetMs: opts.timeoutMs ?? HANG_TEST_MS });
  return true;
}

// ---------------------------------------------------------------------------
// SSE downlink
// ---------------------------------------------------------------------------

// Open the events.mux SSE tail for one conversation. Returns the raw
// Response — the caller owns the body and MUST read/close it (a stalled
// body is silence upstream; the caller runs the idle watchdog).
// `timeoutMs` bounds ONLY the response head: the tail's body deliberately
// carries no deadline (see fetchTimed) — the pump's idle-gap watchdog and
// turn cap govern it instead.
export async function openEventsMux(convId, { signal, fetchImpl = fetch, timeoutMs = MUX_HEAD_TIMEOUT_MS } = {}) {
  const res = await fetchTimed(`${BASE}/api/events.mux`, {
    method: "GET",
    headers: browserHeaders({ "makers-conversation-id": convId }),
    signal,
  }, timeoutMs, fetchImpl, { bodyDeadline: false });
  if (res.status !== 200) {
    await res.body?.cancel().catch(() => {});
    throw new DshError(res.status >= 500 ? "bad-gateway" : `http-${res.status}`, `HTTP ${res.status} from events.mux`);
  }
  return res;
}

// Parse one SSE `data:` line into a MuxFrame ({kind, sessionId, seq, event}).
// Returns null for comments/keep-alives/corrupt frames (dropped, never fatal).
export function parseMuxFrame(line) {
  if (!line.startsWith("data: ")) return null;
  let env;
  try { env = JSON.parse(line.slice(6)); } catch { return null; }
  if (env?.type !== "server-request" || typeof env.method !== "string") return null;
  const p = env.payload ?? {};
  if (env.method === "session/event") {
    const ev = p.event ?? {};
    return { kind: "event", sessionId: p.sessionId, seq: ev.seq ?? -1, event: { type: ev.type, seq: ev.seq, time: ev.time, data: ev.data } };
  }
  if (env.method === "session/subscribed") return { kind: "subscribed", sessionId: p.sessionId, lastSeq: p.lastSeq ?? -1 };
  if (env.method === "stream/error") return { kind: "stream-error", error: p.error };
  return { kind: env.method, sessionId: p.sessionId }; // session/queue, projections, … — not consumed
}
