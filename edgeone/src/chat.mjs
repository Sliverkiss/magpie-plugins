// dsh2api — chat adaptation: an OpenAI chat completion rides upstream
// sessions (create → selectModel → prompt → SSE tail), with a per-request
// conversation reused across turns when it is still warm (prompt cache:
// live-verified 2026-11-02, turn 2 on the same session cost 213 input
// tokens with 1536 cacheRead where a fresh session costs 1728).
//
// The upstream is an AGENT harness, not a chat API: every turn is an
// agentic loop with sandbox tools (file writes, shell). Ported from the
// reference Go gateway (internal/toolbridge, proposal B §6):
//   - composePrompt: tool manifest + tool_choice fidelity lines + advisory
//     system block + one-line-per-message TRANSCRIPT with continuation
//     flattening (a client-supplied newline can never mint a protocol line).
//   - FencedParser: incremental, streaming-safe parser for fenced
//     ```tool_call blocks — partial backtick runs at delta boundaries are
//     withheld, plain fences pass through byte-identical, malformed/overflow
//     tool fences degrade to verbatim text (never a fabricated call).
//   - tool_choice: "required"/function forms are instructed in the prompt,
//     and a required-but-plain-text reply is converted to a synthetic
//     tool_call on the FIRST tool (never silent spin).
//
// Stream discipline: the SSE Response is returned immediately with a
// ReadableStream body; the upstream turn is pumped in the background and
// cancelled via the outer signal (client disconnect / magpie abort) or the
// stream's own cancel(). Bun note: stream.cancel() rejection is async and
// uncatchable by sync try/catch — every cancel/close here is best-effort.

import * as up from "./upstream.mjs";

const HISTORY_POLL_MS = 1_500;
// While the events.mux head is still pending, poll history at this cadence so
// a slow or never-landing head (measured 2026-11-02: 2.5–5.8s, ~40% never
// answer) cannot silence a turn that is already generating. The seq filter
// merges the poll stream with the tail losslessly once the head lands.
const OPEN_SLICE_MS = 2_000;
// SSE heartbeat cadence for the client-facing stream (see sseResponse).
// Injectable via deps.heartbeatMs so tests do not sit through real 15s gaps.
const SSE_HEARTBEAT_MS = 15_000;
const MAX_PROMPT_BYTES = 192 * 1024;

// Turn liveness. A flat total cap is the wrong shape here: the upstream is an
// AGENT harness (it runs sandbox tools), so one turn can legitimately work
// for minutes — a flat 240s cap used to cut valid turns in half. Two bounds
// instead:
//   TURN_IDLE_MS     — no new upstream event for this long ⇒ the turn is dead
//   TURN_ABSOLUTE_MS — the last-resort ceiling, whatever else happens
// A turn that keeps producing events therefore runs as long as it needs (up
// to the ceiling), while a wedged turn dies after 5 minutes of silence.
const TURN_IDLE_MS = 300_000;
const TURN_ABSOLUTE_MS = 900_000;
export const TURN_BUDGET_MS = TURN_ABSOLUTE_MS;

// Session reuse: after a turn ends, the conversation is parked here instead
// of being cancelled. A follow-up request may ride the warm session only when
// a fingerprint proves it is the NEXT turn of THAT conversation: the parked
// fingerprint covers the exact message context the session has already seen
// (normalized) plus the assistant echo we returned, and the new request's
// messages-minus-its-trailing-fresh-tail must hash to it. Any divergence
// (edited history, interleaved chats, other tools) rehashes differently and
// gets a fresh session, which is always correct. Live-verified 2026-11-02:
// turn 2 on the same session cost 213 input tokens with 1536 cacheRead where
// a fresh session costs 1728.
const SESSION_TTL_MS = 10 * 60_000;
const SESSION_POOL_MAX = 4;
const parked = new Map(); // convId → { sessionId, at, provider, model, fp, lastSeq }
let parkedSweeper = null;
function parkSession(convId, entry) {
  parked.set(convId, { ...entry, at: Date.now() });
  if (parked.size > SESSION_POOL_MAX) {
    let oldestKey = null, oldest = Infinity;
    for (const [k, v] of parked) if (v.at < oldest) { oldest = v.at; oldestKey = k; }
    if (oldestKey) parked.delete(oldestKey);
  }
  if (!parkedSweeper) {
    parkedSweeper = setInterval(() => {
      const now = Date.now();
      for (const [k, v] of parked) if (now - v.at > SESSION_TTL_MS) parked.delete(k);
      if (!parked.size && parkedSweeper) { clearInterval(parkedSweeper); parkedSweeper = null; }
    }, 60_000);
    if (parkedSweeper.unref) parkedSweeper.unref();
  }
}
function takeParkedSession(provider, model, fpPrefix) {
  for (const [convId, v] of parked) {
    if (Date.now() - v.at > SESSION_TTL_MS) { parked.delete(convId); continue; }
    if (v.provider === provider && v.model === model && v.fp === fpPrefix) {
      parked.delete(convId);
      return { convId, sessionId: v.sessionId, lastSeq: v.lastSeq ?? -1 };
    }
  }
  return null;
}
function dropParked(convId) { if (convId) parked.delete(convId); }
// Test hook: the pool is module state, and a test that wants a cold start must
// not inherit one from the test before it. Never used by the request path.
export function _clearParkedSessions() {
  parked.clear();
  warm.clear();
  warmEpoch++;
  if (parkedSweeper) { clearInterval(parkedSweeper); parkedSweeper = null; }
}
// Test hook: how many conversations are parked right now (capacity check).
export function parkedCount() { return parked.size; }
// Test hook: total prewarm leases across models.
export function warmCount() {
  let n = 0;
  for (const q of warm.values()) n += q.length;
  return n;
}
// Test hook: wait for every in-flight background warm fill to settle.
export async function _drainWarm() { await Promise.allSettled([...warmInflight]); }

// Prewarm pool (mirrors the reference Go gateway's warm design, plugin
// scale): sessions pre-created per model in the BACKGROUND so a cold request
// skips session.create — the flakiest call in the chain (EdgeOne 502s, up to
// 3 attempts inline). Taken warm leases are still validated with a cheap
// selectModel before use; a dead one (reaped upstream) drops to the inline
// create — the same fallback the parked pool rides. Failures to FILL are
// silent: the request path must never depend on the warm pool.
const WARM_PER_MODEL = 2;
const WARM_TTL_MS = 10 * 60_000; // lazy eviction on take (upstream reaps idle convs)
const WARM_TOTAL_MAX = 6;
const warm = new Map(); // "provider/model" → [{ convId, sessionId, at }]
const warming = new Set(); // keys with a create in flight
const warmInflight = new Set(); // in-flight fill promises (test drain)
let warmEpoch = 0; // bumped by _clearParkedSessions so an in-flight fill from
                   // a cleared epoch never pushes into the fresh pool

function warmKey(provider, model) { return `${provider}/${model}`; }

function takeWarmSession(provider, model) {
  const q = warm.get(warmKey(provider, model));
  while (q?.length) {
    const e = q.shift();
    if (Date.now() - e.at <= WARM_TTL_MS) return e;
  }
  return null;
}

function replenishWarm(provider, model, fetchImpl) {
  const key = warmKey(provider, model);
  if (warming.has(key)) return;
  let total = 0;
  for (const q of warm.values()) total += q.length;
  if ((warm.get(key)?.length ?? 0) >= WARM_PER_MODEL || total >= WARM_TOTAL_MAX) return;
  warming.add(key);
  const epoch = warmEpoch;
  const fill = (async () => {
    const convId = up.newConvId();
    // Tight budgets: a hanging warm create must not pin the set for a minute.
    const s = await up.createSession(convId, "makers", { fetchImpl, attempts: 2, timeoutMs: 8_000, budgetMs: 18_000, backoff: [0, 2_000] });
    await up.selectModel(convId, s.sessionId, provider, model, { fetchImpl, attempts: 2, timeoutMs: 8_000, budgetMs: 18_000, backoff: [0, 2_000] });
    if (epoch !== warmEpoch) return; // pool was cleared mid-fill: drop the lease
    const q = warm.get(key) ?? [];
    q.push({ convId, sessionId: s.sessionId, at: Date.now() });
    warm.set(key, q);
  })().catch(() => {}).finally(() => { warming.delete(key); warmInflight.delete(fill); });
  warmInflight.add(fill);
}

// Normalized JSON of the conversation state an upstream session has seen.
// Tolerant to key order/whitespace (re-marshaled), strict to content. 64-bit
// FNV over the canonical text: collisions across a ≤4-entry pool are
// negligible, and a collision could only ride a session with an identical
// normalized transcript anyway.
function fnv1a64(s) {
  let h = 0xcbf29ce484222325n;
  const P = 0x100000001b3n;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.codePointAt(i));
    h = (h * P) & 0xffffffffffffffffn;
  }
  return h.toString(16);
}
function normMessage(m) {
  const out = { role: m.role ?? "user", content: textOf(m.content) };
  if (m.tool_call_id !== undefined) out.tool_call_id = m.tool_call_id;
  if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
    out.tool_calls = m.tool_calls.map((tc) => ({
      id: tc.id ?? "",
      name: tc.function?.name ?? "",
      arguments: compactJSON(tc.function?.arguments ?? "{}"),
    }));
  }
  return out;
}
function contextFingerprint(req, messages) {
  return fnv1a64(JSON.stringify({
    messages: (messages ?? []).map(normMessage),
    tools: (Array.isArray(req.tools) ? req.tools : []).map((t) => ({
      name: t?.function?.name ?? t?.name ?? "",
      description: t?.function?.description ?? "",
      parameters: t?.function?.parameters ?? null,
    })).filter((t) => t.name || t.description || t.parameters),
    tool_choice: typeof req.tool_choice === "string" ? req.tool_choice : (req.tool_choice ? "fn" : null),
    parallel: req.parallel_tool_calls === false ? false : null,
  }));
}

export const TEXT_ONLY = { text: true, image: false, audio: false, video: false, pdf: false };

// ---------------------------------------------------------------------------
// prompt composition (toolbridge/compose.go §6.2)
// ---------------------------------------------------------------------------

const MANIFEST_HEAD = `You are being accessed through an OpenAI-compatible API gateway. You also have
access to these EXTERNAL client-side tools, executed by the caller:

<tools>
`;
const MANIFEST_TAIL = `
</tools>

Tool-call protocol: when you call an EXTERNAL tool, reply with ONLY fenced
blocks of the form below, and nothing else in your reply:

\`\`\`tool_call
{"name": "<tool name>", "arguments": {<json object>}}
\`\`\`

You cannot execute external tools yourself. Caller-supplied results appear as
\`tool result (<name>): <json>\` lines in the next message's TRANSCRIPT section.
One block per call; multiple calls in one reply = multiple blocks, in order.
`;

const NO_TOOLS_ADVISORY = [
  "You are being accessed through an OpenAI-compatible API gateway.",
  "Answer the user's request DIRECTLY as plain assistant text.",
  "Do NOT create files, run shell commands, or use any workspace tools.",
].join(" ");

// Fenced-protocol reminder for REUSED sessions: the manifest was taught on
// the first turn of the conversation; on later turns the model still needs
// to see that external tools exist and how to call them (its own sandbox
// tools otherwise crowd the protocol out).
const REUSE_PROTOCOL_REMINDER = `Reminder: EXTERNAL client-side tools from the first message are still available and are called ONLY with fenced blocks of the form

\`\`\`tool_call
{"name": "<tool name>", "arguments": {<json object>}}
\`\`\`

Caller-supplied results appear as \`tool result (<name>): <json>\` lines in the next message's TRANSCRIPT section.`;

function flattenContinuations(s) {
  s = String(s ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return s.includes("\n") ? s.replace(/\n/g, "\n  ") : s;
}

function compactJSON(s) {
  try { return JSON.stringify(JSON.parse(s)); } catch { return String(s ?? ""); }
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((p) => p && (p.type === "text" || typeof p.text === "string"))
      .map((p) => p.text)
      .join("\n");
  }
  return content == null ? "" : String(content);
}

const toolChoiceNone = (req) => req.tool_choice === "none";

function manifestFor(req) {
  const tools = Array.isArray(req.tools) ? req.tools : [];
  if (!tools.length || toolChoiceNone(req)) return "";
  const compact = tools.map((t) => {
    const f = t?.function ?? {};
    const out = { name: f.name ?? t?.name ?? "tool" };
    if (f.description) out.description = f.description;
    if (f.parameters) out.parameters = f.parameters;
    return out;
  });
  return MANIFEST_HEAD + JSON.stringify(compact) + MANIFEST_TAIL;
}

function choiceLines(req) {
  if (!Array.isArray(req.tools) || !req.tools.length || toolChoiceNone(req)) return [];
  const lines = [];
  const tc = req.tool_choice;
  if (tc === "required") lines.push("You MUST call at least one of the tools above in this reply. Do not answer in plain text.");
  else if (tc && typeof tc === "object" && tc.type === "function" && tc.function?.name) {
    lines.push(`You MUST call the function \`${tc.function.name}\` now — reply with its single fenced tool_call block and nothing else.`);
  }
  if (req.parallel_tool_calls === false) lines.push("Call AT MOST ONE tool in this reply — emit a single fenced block.");
  return lines;
}

function systemAdvisory(req) {
  const parts = (req.messages ?? [])
    .filter((m) => (m.role === "system" || m.role === "developer") && textOf(m.content))
    .map((m) => textOf(m.content));
  return parts.length ? "System guidance (advisory): " + parts.join(" ") : "";
}

function effectiveMaxTokens(req) {
  if (Number.isFinite(req.max_completion_tokens) && req.max_completion_tokens > 0) return req.max_completion_tokens;
  if (Number.isFinite(req.max_tokens) && req.max_tokens > 0) return req.max_tokens;
  return 0;
}

export function composePrompt(req) {
  const b = [];
  const hasTools = Array.isArray(req.tools) && req.tools.length && !toolChoiceNone(req);
  const manifest = manifestFor(req);
  if (manifest) { b.push(manifest); b.push(""); }
  const maxTok = effectiveMaxTokens(req);
  if (maxTok > 0) b.push(`RESPONSE LIMIT: your reply must not exceed approximately ${maxTok} tokens. Stop before the limit.\n`);
  for (const line of choiceLines(req)) b.push(line + "\n");
  const sys = systemAdvisory(req);
  if (sys) b.push(sys);
  if (!hasTools && !sys) b.push(NO_TOOLS_ADVISORY);
  b.push("TRANSCRIPT:\n");
  b.push(...transcriptLines(req.messages ?? []));
  const prompt = b.join("\n");
  if (prompt.length > MAX_PROMPT_BYTES) {
    throw Object.assign(
      new Error(`prompt too long: ${prompt.length} bytes exceeds the ${MAX_PROMPT_BYTES} byte limit`),
      { status: 400, code: "invalid_request_error" },
    );
  }
  return prompt;
}

// One transcript line per message, in order. System/developer messages are
// folded into the advisory block and never appear as transcript lines. The
// tool_call_id → name map is built over the WHOLE list so a tail slice (used
// by the continuation form) still names its tool results correctly.
function transcriptLines(messages, nameScope = messages) {
  const names = new Map(); // tool_call_id → function name
  for (const m of nameScope) {
    if ((m.role ?? "user") !== "assistant") continue;
    for (const tc of m.tool_calls ?? []) names.set(tc.id, tc?.function?.name ?? "tool");
  }
  const b = [];
  for (const m of messages) {
    const role = m.role ?? "user";
    if (role === "system" || role === "developer") continue; // already in advisory
    if (role === "assistant") {
      const t = textOf(m.content);
      if (t) b.push(`- assistant: ${flattenContinuations(t)}`);
      for (const tc of m.tool_calls ?? []) {
        const f = tc?.function ?? {};
        b.push(`- assistant (tool call): ${f.name ?? "tool"}(${flattenContinuations(compactJSON(f.arguments ?? "{}"))})`);
      }
    } else if (role === "tool") {
      const name = names.get(m.tool_call_id) ?? m.name ?? m.tool_call_id ?? "tool";
      b.push(`- tool result (${name}): ${flattenContinuations(textOf(m.content))}`);
    } else {
      b.push(`- user: ${flattenContinuations(textOf(m.content))}`);
    }
  }
  return b;
}

// The prompt for a REUSED session: only what the session has not seen yet.
// Resending the whole transcript would duplicate context the harness already
// holds and defeat the prompt cache this path exists for.
export function composeContinuationPrompt(req, freshMessages) {
  const b = [];
  const hasTools = Array.isArray(req.tools) && req.tools.length && !toolChoiceNone(req);
  if (hasTools) b.push(REUSE_PROTOCOL_REMINDER + "\n");
  const maxTok = effectiveMaxTokens(req);
  if (maxTok > 0) b.push(`RESPONSE LIMIT: your reply must not exceed approximately ${maxTok} tokens. Stop before the limit.\n`);
  for (const line of choiceLines(req)) b.push(line + "\n");
  const sys = systemAdvisory(req);
  if (sys) b.push(sys);
  if (!hasTools && !sys) b.push(NO_TOOLS_ADVISORY);
  b.push("NEW TURNS:\n");
  // The name map spans the WHOLE transcript (the tool_call may sit in the
  // already-seen prefix while its result is in the fresh tail); only the
  // fresh tail is rendered.
  b.push(...transcriptLines(freshMessages, req.messages ?? []));
  const prompt = b.join("\n");
  if (prompt.length > MAX_PROMPT_BYTES) {
    throw Object.assign(
      new Error(`prompt too long: ${prompt.length} bytes exceeds the ${MAX_PROMPT_BYTES} byte limit`),
      { status: 400, code: "invalid_request_error" },
    );
  }
  return prompt;
}

// A request can ride a warm upstream session only when it looks like the
// NEXT turn of that conversation: the transcript ends with a run of new
// user/tool messages and everything before them is byte-equivalent (after
// normalization) to what the session already saw. Everything else — edited
// history, an inserted system message, a different tool set — fails the
// fingerprint and gets a fresh session, which is always correct.
export function continuationTail(req) {
  const msgs = req.messages ?? [];
  const fresh = [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role === "user" || m.role === "tool") fresh.unshift(m);
    else break;
  }
  // The tail must be a proper append: at least one new message, and the
  // remainder must be non-empty (a fresh-only transcript is turn 1).
  const continuation = fresh.length > 0 && fresh.length < msgs.length;
  return { fresh, continuation, prior: continuation ? msgs.slice(0, msgs.length - fresh.length) : null };
}

// ---------------------------------------------------------------------------
// FencedParser (toolbridge/fenced.go §6.3) — incremental streaming parser
// ---------------------------------------------------------------------------

const FENCE = "```";
const INFO = "tool_call";
const FULL_HEADER = FENCE + INFO;
// Single-fence body cap. The Go reference used 64KB, but a legitimate
// write-file tool call can carry far more than that as its argument, and the
// overflow path degrades the WHOLE fence to verbatim text — i.e. a real
// tool call silently becomes prose. 256KB keeps the memory bound (one fence
// buffer per in-flight request) while covering realistic tool payloads.
const MAX_FENCE_BODY = 256 * 1024;

export class FencedParser {
  #state = "outside";       // outside | header | toolBody | plainBody
  #pending = "";            // withheld partial prefix / fence header
  #body = "";               // toolBody accumulator (leading \n included)
  #atLineStart = true;
  #plainTail = "";
  #plainMidLine = false;

  // Feed one text delta → { text, calls: [{name, arguments}] }
  feed(delta) {
    let out = "";
    const calls = [];
    let buf = delta;
    if (this.#state !== "toolBody") {
      buf = this.#pending + delta;
      this.#pending = "";
    }
    while (buf.length > 0) {
      if (this.#state === "outside") buf = this.#feedOutside((s) => (out += s), buf);
      else if (this.#state === "header") buf = this.#feedHeader((s) => (out += s), buf);
      else if (this.#state === "toolBody") buf = this.#feedToolBody((s) => (out += s), calls, buf);
      else buf = this.#feedPlainBody((s) => (out += s), buf);
    }
    return { text: out, calls };
  }

  finish() {
    if (this.#state === "toolBody") {
      // Unterminated closer at end of stream completes the call. Malformed
      // body degrades to verbatim text (never a fabricated call) — this is
      // the §6.3 contract; the Go reference's Finish() drops the body on
      // this path, which we deliberately do not copy.
      const idx = closingFenceIndex(this.#body, true);
      if (idx >= 0) {
        const body = this.#body.slice(0, idx);
        const call = parseToolBody(body);
        this.#pending = ""; this.#body = ""; this.#state = "outside";
        if (call) return { text: "", calls: [call] };
        return { text: FULL_HEADER + body + FENCE, calls: [] };
      }
      const out = this.#pending + this.#body;
      this.#pending = ""; this.#body = ""; this.#state = "outside";
      return { text: out, calls: [] };
    }
    if (this.#state === "plainBody") {
      const out = this.#plainTail;
      this.#plainTail = ""; this.#plainMidLine = false; this.#state = "outside";
      return { text: out, calls: [] };
    }
    // outside or header: pending holds a withheld partial prefix / header.
    const out = this.#pending;
    this.#pending = ""; this.#state = "outside";
    return { text: out, calls: [] };
  }

  #feedOutside(emit, buf) {
    const entryLineStart = this.#atLineStart;
    let atLineStart = entryLineStart;
    let out = "";
    let i = 0;
    for (; i < buf.length; i++) {
      if (atLineStart && buf.startsWith(FENCE, i)) {
        this.#state = "header";
        this.#pending = FENCE;
        this.#atLineStart = false;
        emit(out);
        return buf.slice(i + FENCE.length);
      }
      const c = buf[i];
      out += c;
      atLineStart = c === "\n";
    }
    // Withhold a trailing 1–2 backtick run (it may still grow into a fence
    // opener at a line start). Runs of 3+ can only be a fence if already
    // matched above, so they pass through as text.
    let r = 0;
    while (r < FENCE.length && r < buf.length && buf[buf.length - 1 - r] === "`") r++;
    if (r > 0 && r < FENCE.length) {
      const held = buf.slice(buf.length - r);
      this.#pending = held;
      this.#atLineStart = buf.length === r ? entryLineStart : buf[buf.length - r - 1] === "\n";
      emit(out.slice(0, out.length - held.length));
      return "";
    }
    this.#atLineStart = atLineStart;
    emit(out);
    return "";
  }

  #feedHeader(emit, buf) {
    const nl = buf.search(/[\r\n]/);
    const line = nl < 0 ? buf : buf.slice(0, nl);
    const rest = nl < 0 ? "" : buf.slice(nl);
    const header = this.#pending + line;
    if (isHeaderPrefix(header) && nl < 0) {
      this.#pending = header;
      return "";
    }
    if (header === FULL_HEADER && nl >= 0) {
      this.#pending = FULL_HEADER;
      this.#state = "toolBody";
      this.#body = "";
      return rest;
    }
    emit(header);
    this.#pending = "";
    this.#state = "plainBody";
    this.#plainTail = "";
    this.#plainMidLine = nl < 0;
    return rest;
  }

  #feedToolBody(emit, calls, buf) {
    this.#body += buf;
    if (this.#body.length > MAX_FENCE_BODY) {
      const held = this.#body.slice(0, this.#body.length - buf.length);
      const rest = this.#body.slice(this.#body.length - buf.length);
      emit(this.#pending + held);
      this.#pending = ""; this.#body = ""; this.#state = "outside";
      this.#atLineStart = false;
      return rest;
    }
    const idx = closingFenceIndex(this.#body, false);
    if (idx >= 0) {
      const body = this.#body.slice(0, idx);
      const after = this.#body.slice(idx + FENCE.length);
      this.#pending = ""; this.#body = ""; this.#state = "outside";
      this.#atLineStart = false;
      const call = parseToolBody(body);
      if (call) calls.push(call);
      else emit(FULL_HEADER + body + FENCE); // malformed → verbatim
      return after;
    }
    return "";
  }

  #feedPlainBody(emit, buf) {
    let work = this.#plainTail + buf;
    this.#plainTail = "";
    let lineStart = !this.#plainMidLine;
    this.#plainMidLine = false;
    for (;;) {
      const nl = work.indexOf("\n");
      if (nl < 0) {
        if (lineStart && isCloserCandidate(work)) this.#plainTail = work;
        else { emit(work); this.#plainMidLine = true; }
        return "";
      }
      const line = work.slice(0, nl);
      emit(line + "\n");
      if (lineStart && line.replace(/\r$/, "") === FENCE) {
        this.#state = "outside";
        this.#atLineStart = false;
        return work.slice(nl + 1);
      }
      work = work.slice(nl + 1);
      lineStart = true;
    }
  }
}

function isHeaderPrefix(s) {
  return s.length <= FULL_HEADER.length && FULL_HEADER.startsWith(s);
}

function isCloserCandidate(s) {
  return (s.length < FENCE.length && FENCE.startsWith(s)) || s === FENCE;
}

function closingFenceIndex(body, allowEnd) {
  let from = 0;
  for (;;) {
    let i;
    if (from <= 0) i = 0;
    else {
      const j = body.indexOf("\n", from);
      if (j < 0) return -1;
      i = j + 1;
    }
    if (i >= body.length) return -1;
    if (body.startsWith(FENCE, i)) {
      const rest = body.slice(i + FENCE.length).replace(/^\r$/, "");
      if ((rest === "" && allowEnd) || rest.startsWith("\n")) return i;
    }
    from = i + 1;
  }
}

function parseToolBody(body) {
  let raw;
  try { raw = JSON.parse(body); } catch { return null; }
  if (!raw || typeof raw.name !== "string" || !raw.name) return null;
  let args = "{}";
  if (raw.arguments !== undefined) {
    try { args = typeof raw.arguments === "string" ? compactJSON(raw.arguments) : JSON.stringify(raw.arguments); }
    catch { return null; }
  }
  return { name: raw.name, arguments: args };
}

const toOpenAIToolCall = (c, i) => ({
  index: i,
  id: `call_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`,
  type: "function",
  function: { name: c.name, arguments: c.arguments },
});

// tool_choice "required"/{function} promised a tool call; the model answered
// in plain text instead. Convert the first tool's identity into a synthetic
// empty-arguments call rather than spinning: the client gets a well-formed
// tool_calls turn it can execute and resubmit, and the transcript keeps the
// model's actual text for the next round.
function coerceRequiredCalls(calls, plainText, req, sawFence) {
  const tc = req.tool_choice;
  const required = tc === "required" ||
    (tc && typeof tc === "object" && tc.type === "function" && tc.function?.name);
  if (!required || calls.length || sawFence) return { calls, coerced: null };
  const tools = Array.isArray(req.tools) ? req.tools : [];
  if (!tools.length) return { calls, coerced: null };
  const wanted = tc?.function?.name;
  const pick = wanted
    ? tools.find((t) => (t?.function?.name ?? t?.name) === wanted)
    : tools[0];
  if (!pick) return { calls, coerced: null };
  const name = pick?.function?.name ?? pick?.name ?? "tool";
  const coerced = { name, arguments: "{}" };
  return { calls: [coerced], coerced: { name, plainText } };
}

// ---------------------------------------------------------------------------
// turn driver: yields SessionEvents for one prompt until turn/end.
//
// The tail is opened in PARALLEL with model selection (handleChat may pass an
// already-started open as `muxP`) and the prompt is submitted without waiting
// for it — the mux head takes seconds and fails often (see MUX_HEAD_TIMEOUT_
// MS). Whatever the tail's subscription point shows it will never deliver is
// backfilled from session.history, which is authoritative (recon §7.3); when
// the stream idles or ends, the same polling carries the rest. The whole
// loop is bounded by turnMs.
// ---------------------------------------------------------------------------

function turnPump({ convId, sessionId, outerSignal, turnMs = TURN_ABSOLUTE_MS, idleMs = TURN_IDLE_MS, fetchImpl = fetch, lastSeq = -1, onEnd, muxP, openSliceMs = OPEN_SLICE_MS }) {
  const ac = new AbortController();
  const onOuterAbort = () => ac.abort(outerSignal?.reason);
  outerSignal?.addEventListener("abort", onOuterAbort, { once: true });

  const queue = [];
  let notify = null;
  let error = null;
  let ended = false;
  let readySettled = false;
  let resolveReady;
  // `ready` is advisory only (nothing gates on it since the prompt stopped
  // waiting for the mux head), so it must never REJECT: a promise nobody
  // awaits, rejected at turn end, is an unhandled rejection.
  const ready = new Promise((res) => { resolveReady = res; });
  const settleReady = () => { if (!readySettled) { readySettled = true; resolveReady(true); } };

  const wake = () => { const n = notify; notify = null; n?.(); };
  const push = (ev) => { queue.push(ev); wake(); };
  const finish = (err) => {
    if (ended) return;
    error = err ?? null;
    ended = true;
    settleReady();
    wake();
  };

  const teardown = () => {
    outerSignal?.removeEventListener("abort", onOuterAbort);
    ac.abort();
  };

  const handle = { events: null, ready, cancel: teardown, completed: false, lastSeq };

  const pump = (async () => {
    let reader = null;
    let sseBody = null;
    let done = false;
    let sseDead = false;

    const closeSse = () => {
      try { reader?.releaseLock(); } catch {}
      try { sseBody?.cancel().catch(() => {}); } catch {}
    };

    // One authoritative history poll: dispatch every event newer than
    // handle.lastSeq, in seq order. Returns true when turn/end was among
    // them. A TRANSIENT failure (gateway flake, our own watchdog) is NOT a
    // dead turn — the turn keeps running upstream — so it returns false and
    // the caller simply polls again; only a semantic DshError (session
    // reaped upstream) throws and fails the turn.
    // Liveness bounds for this turn: silence past idleMs means the upstream
    // turn is wedged; the absolute ceiling bounds the whole thing. A turn that
    // keeps producing events is never cut short.
    const absoluteDeadline = Date.now() + turnMs;
    let lastProgressAt = Date.now();
    const turnDeadline = () => Math.min(absoluteDeadline, lastProgressAt + idleMs);
    const timeoutErr = () => new up.DshError("turn-timeout",
      Date.now() >= absoluteDeadline
        ? `turn exceeded the absolute ${turnMs}ms ceiling`
        : `no upstream event for ${idleMs}ms`);

    const pollHistory = async () => {
      let h;
      try {
        h = await up.history(convId, sessionId, { max: 200 }, { signal: ac.signal, fetchImpl });
      } catch (e) {
        if (ac.signal.aborted) throw ac.signal.reason ?? up.abortErr();
        if (e instanceof up.DshError && !e.isTransient) throw e;
        return false;
      }
      const fresh = h.events
        .map((e) => e.event ?? e)
        .filter((e) => typeof e?.seq === "number" && e.seq > handle.lastSeq)
        .sort((a, b) => a.seq - b.seq);
      for (const ev of fresh) {
        handle.lastSeq = ev.seq;
        push({ type: ev.type, data: ev.data });
        lastProgressAt = Date.now(); // the turn is alive — reset the idle bound
        if (ev.type === "turn/end") done = true;
      }
      return done;
    };

    // Every exit runs the finally below — including the early ones — so the
    // outer abort listener, the mux body and `ready` are never left dangling.
    try {
      if (outerSignal?.aborted) return finish(outerSignal.reason ?? up.abortErr());

      // The tail: usually one handleChat started in parallel with model
      // selection (muxP), else opened here. It settles to a live body or to
      // null (head would not open / aborted mid-open) — never a rejected
      // promise. A null tail is NOT a failure: history polling answers
      // exactly the same events, just with poll latency. Only a history
      // failure can fail the turn.
      const tailSettledP = Promise.resolve(muxP ?? up.openEventsMux(convId, { signal: ac.signal, fetchImpl }))
        .then((r) => r, () => null);
      let tailAttached = false;
      const attachTail = async () => {
        if (tailAttached) return;
        tailAttached = true;
        const res = await tailSettledP;
        if (ac.signal.aborted) return finish(ac.signal.reason ?? up.abortErr()); // client aborted the open
        if (res?.body) { sseBody = res.body; reader = sseBody.getReader(); }
        else sseDead = true;
        settleReady();
      };

      const decoder = new TextDecoder();
      let buf = "";

      // One SSE line, or null when the stream ended/stalled (idle watchdog).
      // The read also races the abort signal: a body whose fetch
      // implementation never propagated the abort (fakes, some proxies) must
      // still not park us forever.
      const readLine = async () => {
        for (;;) {
          const nl = buf.indexOf("\n");
          if (nl >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); return line; }
          let timer = null;
          let onAbort = null;
          let chunk;
          try {
            chunk = await Promise.race([
              reader.read(),
              new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("idle")), up.IDLE_TIMEOUT_MS); }),
              new Promise((_, rej) => {
                onAbort = () => rej(ac.signal.reason ?? up.abortErr());
                ac.signal.addEventListener("abort", onAbort, { once: true });
              }),
            ]);
          } finally {
            if (timer) clearTimeout(timer);
            if (onAbort) ac.signal.removeEventListener("abort", onAbort);
          }
          if (chunk.done) return null;
          buf += decoder.decode(chunk.value, { stream: true });
        }
      };

      while (!done && Date.now() < turnDeadline()) {
        if (ac.signal.aborted) return finish(ac.signal.reason ?? up.abortErr());

        if (!tailAttached) {
          // Head still pending: give it one slice, then feed the client from
          // history anyway — a head that takes seconds (or never lands) must
          // not silence a turn that is already generating. When the head
          // finally lands, the seq filter merges both sources losslessly.
          const landed = await Promise.race([
            tailSettledP.then(() => true),
            up.delay(openSliceMs, ac.signal).then(() => false, () => false),
          ]);
          if (ac.signal.aborted) return finish(ac.signal.reason ?? up.abortErr());
          if (!landed) {
            await pollHistory();
            if (done) return finish(null);
            continue;
          }
          await attachTail();
        }

        let line = null;
        if (!sseDead) {
          try {
            line = await readLine();
          } catch {
            sseDead = true; // idle watchdog or stream error → history fallback
            try { reader?.cancel().catch(() => {}); } catch {}
          }
          if (line === null && !sseDead) {
            sseDead = true; // stream ended cleanly
            try { reader?.cancel().catch(() => {}); } catch {}
          }
        }

        if (sseDead) {
          // session.history is the authoritative backfill. Poll until
          // turn/end; transient poll failures are retried, not fatal. The
          // cadence backs off while the upstream stays silent (it sends no
          // heartbeat, so a thinking/tool-running turn looks idle) — polling
          // it every 1.5s for minutes is needless load on the harness.
          let emptyPolls = 0;
          while (!done && Date.now() < turnDeadline()) {
            if (ac.signal.aborted) return finish(ac.signal.reason ?? up.abortErr());
            const before = handle.lastSeq;
            if (await pollHistory()) break;
            emptyPolls = handle.lastSeq === before ? emptyPolls + 1 : 0;
            const wait = Math.min(HISTORY_POLL_MS * 2, HISTORY_POLL_MS * (1 + emptyPolls));
            await up.delay(wait, ac.signal);
          }
          if (!done) throw timeoutErr();
          return finish(null);
        }

        const frame = up.parseMuxFrame(line.trimEnd());
        if (!frame) continue;
        if (frame.kind === "subscribed") {
          if (frame.sessionId === sessionId && frame.lastSeq > handle.lastSeq) {
            // The subscription point is also the set of events the tail will
            // NEVER deliver live. When the tail lost its race with the prompt
            // (it opens in parallel with model selection), the turn's first
            // chunks sit in that missed range — backfill them from history
            // now or the answer text starts mid-sentence.
            await pollHistory();
            if (done) return finish(null);
          }
          continue;
        }
        if (frame.kind === "stream-error") {
          throw new up.DshError(frame.error?.code ?? "stream-error", frame.error?.message ?? "events.mux stream error");
        }
        if (frame.kind !== "event" || frame.sessionId !== sessionId) continue;
        const ev = frame.event;
        if (typeof ev.seq !== "number" || ev.seq <= handle.lastSeq) continue;
        handle.lastSeq = ev.seq;
        push({ type: ev.type, data: ev.data });
        lastProgressAt = Date.now(); // the turn is alive — reset the idle bound
        if (ev.type === "turn/end") done = true;
      }
      if (!done) throw timeoutErr();
      finish(null);
    } catch (e) {
      finish(ac.signal.aborted ? ac.signal.reason ?? up.abortErr() : e);
    } finally {
      settleReady(); // never leave `ready` pending on an early exit
      closeSse();
      teardown();
      handle.completed = done;
      onEnd?.(done);
    }
  })();
  // The pump surfaces every failure through the iterable; swallow the
  // promise rejection so an abandoned pump never becomes unhandled.
  pump.catch(() => {});

  handle.events = {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (queue.length) yield queue.shift();
        if (ended) { if (error) throw error; return; }
        await new Promise((r) => { notify = r; });
      }
    },
  };
  return handle;
}

// ---------------------------------------------------------------------------
// chunk → OpenAI mapping
// ---------------------------------------------------------------------------

function chunkDeltas(data) {
  const c = data?.chunk;
  if (!c) return { deltas: [], usage: null };
  if (c.type === "text-delta" && typeof c.text === "string") return { deltas: [c.text], usage: null };
  if (c.type === "usage" && c.usage) {
    return {
      deltas: [],
      usage: {
        prompt_tokens: c.usage.inputTokens ?? 0,
        completion_tokens: c.usage.outputTokens ?? 0,
        total_tokens: (c.usage.inputTokens ?? 0) + (c.usage.outputTokens ?? 0),
      },
    };
  }
  return { deltas: [], usage: null };
}

// ---------------------------------------------------------------------------
// public entry: handle one OpenAI chat completion request
//
// modelMap: { [pluginModelId]: { provider, model } } upstream routing.
// deps (all optional) exist for tests: fetchImpl, now, sessionId...

export async function handleChat({ body, modelMap, signal, deps = {} }) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  let req;
  try { req = JSON.parse(String(body ?? "{}")); }
  catch { throw Object.assign(new Error("request body is not valid JSON"), { status: 400 }); }

  const wanted = req.model;
  const route = modelMap[wanted];
  if (!route) {
    // Model-level errors are 404 — 401 would kill the whole account in
    // magpie's failover (silent-failure #2).
    throw Object.assign(new Error(`model not found: ${wanted}`), { status: 404 });
  }
  const { fresh, continuation, prior } = continuationTail(req);
  // Fingerprint = the normalized prefix the warm session must already have
  // seen. Only an exact match lets a request ride a parked session.
  const fp = continuation ? contextFingerprint(req, prior) : null;
  const stream = !!req.stream;

  const ac = new AbortController();
  const onOuterAbort = () => ac.abort(signal?.reason);
  if (signal?.aborted) throw abortedErr(signal);
  signal?.addEventListener("abort", onOuterAbort, { once: true });

  let sessionId = null;
  let convId = null;
  let turnEnded = false;
  let cleaned = false;
  let parkedSeq = -1; // last upstream event seq the session has durably seen
  let detachAttempt = null; // per-attempt ac<->pumpAc unhook, see the turn loop
  const cleanup = () => {
    // Always detach from the caller's signal — the host reuses one signal
    // object across the request's life and an accumulated listener list is
    // the classic plugin leak. Idempotent: cleanup runs from several exits.
    signal?.removeEventListener("abort", onOuterAbort);
    detachAttempt?.();
    if (turnEnded) return; // finishTurn() already parked the conversation
    if (cleaned) return;
    cleaned = true;
    // Client abort / error path: stop the upstream turn so the sandbox is
    // not left running, then drop the conversation from the pool.
    if (sessionId && convId) up.cancel(convId, sessionId, { fetchImpl }).catch(() => {});
    dropParked(convId);
    ac.abort();
  };
  // Successful completion: park the warm conversation (prompt-cache reuse on
  // the next request) instead of cancelling it. The parked fingerprint
  // includes the assistant echo we return, because the next request's
  // transcript carries it while the session produced it itself.
  const finishTurn = (echo, pump) => {
    turnEnded = true;
    parkSession(convId, {
      sessionId, provider: route.provider, model: route.model,
      lastSeq: pump ? pump.lastSeq : parkedSeq,
      fp: contextFingerprint(req, [...(req.messages ?? []), echo]),
    });
  };

  // Startup: a parked warm session with a matching context fingerprint rides
  // the prompt cache; anything else (no hit, a stale/reaped session, any
  // selectModel failure) falls back to a cold start with the FULL transcript,
  // which is always correct. session.create is the flaky call (EdgeOne 502s):
  // up to 3 attempts, fresh conversation id per attempt (a half-created conv
  // may be wedged upstream), linear backoff.
  //
  // The SSE tail opens in PARALLEL with selectModel — measured live
  // (2026-11-02) the mux head takes 2.5–5.8s and never answers at all in
  // ~40% of attempts, so a prompt that waits on it waits up to the head
  // budget before it is even SUBMITTED. The pump instead submits the prompt
  // immediately and backfills from session.history whatever the tail's
  // subscription point shows it missed.
  const startTail = () => {
    const p = up.openEventsMux(convId, { signal: ac.signal, fetchImpl });
    p.catch(() => {}); // a lost race must never surface as unhandled
    return p;
  };
  const dropTail = (p) => p?.then((r) => { r?.body?.cancel().catch(() => {}); }, () => {});

  let promptText = continuation ? composeContinuationPrompt(req, fresh) : composePrompt(req);
  let tailP = null;
  if (continuation) {
    const hit = takeParkedSession(route.provider, route.model, fp);
    if (hit) {
      convId = hit.convId;
      sessionId = hit.sessionId;
      parkedSeq = hit.lastSeq;
      tailP = startTail();
      try {
        await up.selectModel(convId, sessionId, route.provider, route.model, { signal: ac.signal, fetchImpl });
      } catch (e) {
        dropParked(convId);
        dropTail(tailP);
        if (ac.signal.aborted) { cleanup(); throw abortedErr(signal); }
        // Best-effort reuse: ANY failure of the warm path (session reaped,
        // conversation rotated, gateway flake) drops to a cold start.
        sessionId = null; convId = null; parkedSeq = -1; tailP = null;
        promptText = composePrompt(req);
      }
    }
  }
  // Lifecycle self-heal (edgeone2api's shape): the upstream reaps idle
  // conversations (~20min); `session not found` between taking a session and
  // the prompt landing is a lifecycle event, NOT an error — drop the dead
  // session and retry ONCE on a fresh one with the FULL transcript. Never
  // after the client has seen bytes (a stream's role chunk is already out by
  // then), and never on a client abort.
  let retriedNotFound = false;
  for (;;) {
    if (!sessionId) {
      // Prewarm lease first: skips session.create entirely (the flaky call).
      // The lease is validated with a real selectModel — a reaped session
      // fails here and falls through to the inline create below.
      const w = takeWarmSession(route.provider, route.model);
      if (w) {
        convId = w.convId;
        sessionId = w.sessionId;
        tailP = startTail();
        try {
          await up.selectModel(convId, sessionId, route.provider, route.model, { signal: ac.signal, fetchImpl });
        } catch (e) {
          dropTail(tailP);
          dropParked(convId);
          if (ac.signal.aborted) { cleanup(); throw abortedErr(signal); }
          sessionId = null; convId = null; tailP = null;
        }
      }
    }
    if (!sessionId) {
      let lastErr;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (ac.signal.aborted) { cleanup(); throw abortedErr(signal); }
        if (attempt > 0) await up.delay(1000 * attempt, ac.signal).catch(() => {});
        convId = up.newConvId();
        try {
          const s = await up.createSession(convId, "makers", { signal: ac.signal, fetchImpl });
          sessionId = s.sessionId;
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          if (ac.signal.aborted) { cleanup(); throw abortedErr(signal); }
          if (e instanceof up.DshError && !e.isTransient) { cleanup(); throw mapError(e); }
        }
      }
      if (!sessionId) { cleanup(); throw mapError(lastErr); }
      tailP = startTail();
      try {
        await up.selectModel(convId, sessionId, route.provider, route.model, { signal: ac.signal, fetchImpl });
      } catch (e) {
        cleanup();
        throw mapError(e);
      }
    }
    // Keep the pool topped up for this model in the background — both after a
    // warm take and after an inline create (fire-and-forget, silent on failure).
    // Tests that count upstream calls pass warm:false — a background fill would
    // otherwise race their assertions.
    if (deps?.warm !== false) replenishWarm(route.provider, route.model, fetchImpl);

    // Per-attempt pump controller: a retry stops the orphaned pump through
    // pumpAc without killing ac (which owns the whole request).
    const pumpAc = new AbortController();
    const onAcAbort = () => pumpAc.abort(ac.signal.reason);
    if (ac.signal.aborted) { cleanup(); throw abortedErr(signal); }
    ac.signal.addEventListener("abort", onAcAbort);
    detachAttempt = () => ac.signal.removeEventListener("abort", onAcAbort);
    try {
      const pump = turnPump({
        convId, sessionId, outerSignal: pumpAc.signal, fetchImpl, lastSeq: parkedSeq, muxP: tailP,
        openSliceMs: deps.openSliceMs,
        // ONLY a completed upstream turn lets the conversation off the hook;
        // on abort/error cleanup() still cancels the session upstream.
        onEnd: (completed) => { if (completed) turnEnded = true; },
      });
      await up.prompt(convId, sessionId, promptText, { signal: ac.signal, fetchImpl });

      if (stream) return sseResponse({ pump, req, cleanup, finishTurn, signal: ac.signal, heartbeatMs: deps.heartbeatMs });
      return await jsonResponse({ pump, req, cleanup, finishTurn, signal: ac.signal });
    } catch (e) {
      detachAttempt = null;
      pumpAc.abort(up.abortErr("turn retry"));
      if (e instanceof up.DshError && e.isNotFound && !retriedNotFound && !ac.signal.aborted) {
        retriedNotFound = true;
        dropParked(convId);
        dropTail(tailP);
        convId = null; sessionId = null; parkedSeq = -1; tailP = null;
        // A fresh session has seen nothing: the prompt must be the FULL
        // transcript, not the NEW-TURNS slice a parked continuation sends.
        promptText = composePrompt(req);
        continue;
      }
      cleanup();
      throw mapError(e);
    }
  }
}


function abortedErr(signal) {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  return new DOMException("client aborted", "AbortError");
}

async function jsonResponse({ pump, req, cleanup, finishTurn, signal }) {
  const parser = new FencedParser();
  let text = "";
  let usage = null;
  const calls = [];
  let sawFence = false;
  let failed = false;
  try {
    for await (const ev of pump.events) {
      if (signal.aborted) break;
      if (ev.type === "assistant/chunk") {
        const { deltas, usage: u } = chunkDeltas(ev.data);
        for (const d of deltas) {
          if (d.includes("```")) sawFence = true;
          const r = parser.feed(d);
          text += r.text;
          for (const c of r.calls) calls.push(c);
        }
        if (u) usage = u;
      } else if (ev.type === "assistant/message") {
        if (ev.data?.usage) {
          usage = {
            prompt_tokens: ev.data.usage.inputTokens ?? 0,
            completion_tokens: ev.data.usage.outputTokens ?? 0,
            total_tokens: (ev.data.usage.inputTokens ?? 0) + (ev.data.usage.outputTokens ?? 0),
          };
        }
      }
    }
    if (signal.aborted) throw signal.reason ?? up.abortErr("client aborted");
    const fin = parser.finish();
    text += fin.text;
    for (const c of fin.calls) calls.push(c);
  } catch (e) {
    failed = true;
    // Aborted or failed: the turn did not complete — cancel upstream and
    // never park. cleanup() before the throw so the throw path is self-contained.
    cleanup();
    throw e;
  }
  if (failed) throw new Error("unreachable");
  const { calls: finalCalls } = coerceRequiredCalls(calls, text, req, sawFence || calls.length > 0);
  const msg = { role: "assistant", content: text || null };
  if (finalCalls.length) {
    msg.tool_calls = finalCalls.map((c, i) => toOpenAIToolCall(c, i)).map(({ index, ...rest }) => rest);
  }
  const payload = {
    id: `chatcmpl-${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: req.model,
    choices: [{ index: 0, message: msg, finish_reason: finalCalls.length ? "tool_calls" : "stop" }],
    ...(usage ? { usage } : {}),
  };
  // Park BEFORE any cleanup: finishTurn marks the turn ended so cleanup()
  // detaches the listener without cancelling the (now idle, reusable) session.
  // The fingerprint for the NEXT request is our own messages plus the assistant
  // echo we are returning (the client re-sends it as the transcript prefix).
  finishTurn(msg, pump);
  cleanup();
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

function sseResponse({ pump, req, cleanup, finishTurn, signal, heartbeatMs = SSE_HEARTBEAT_MS }) {
  const id = `chatcmpl-${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);
  const encoder = new TextEncoder();
  const chunkOf = (delta, finish = null, usage = undefined) => ({
    id, object: "chat.completion.chunk", created, model: req.model,
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(usage ? { usage } : {}),
  });

  const includeUsage = req.stream_options?.include_usage === true;

  const readable = new ReadableStream({
    async start(controller) {
      // SSE heartbeat (`: ping` comment — every parser ignores it): the
      // upstream goes silent while its agent runs sandbox tools, and a
      // client-facing stream with no bytes for 10s+ invites middle proxies
      // to cut it (diaoxiaoniu/DSH2API R5 F3). Sent only when the stream
      // has been quiet for a while; real deltas reset the clock.
      let lastWrite = Date.now();
      const send = (obj) => { lastWrite = Date.now(); controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`)); };
      const done = () => { lastWrite = Date.now(); controller.enqueue(encoder.encode("data: [DONE]\n\n")); };
      const beat = setInterval(() => {
        if (Date.now() - lastWrite < heartbeatMs) return;
        lastWrite = Date.now();
        try { controller.enqueue(encoder.encode(": ping\n\n")); } catch {}
      }, Math.max(20, Math.min(5_000, Math.floor(heartbeatMs / 3))));
      const parser = new FencedParser();
      const calls = [];
      let usage = null;
      let sawFence = false;
      let text = "";
      try {
        send(chunkOf({ role: "assistant" }));
        for await (const ev of pump.events) {
          if (signal.aborted) break;
          if (ev.type !== "assistant/chunk") continue;
          const { deltas, usage: u } = chunkDeltas(ev.data);
          if (u) usage = u;
          for (const d of deltas) {
            if (d.includes("```")) sawFence = true;
            const r = parser.feed(d);
            if (r.text) { text += r.text; send(chunkOf({ content: r.text })); }
            for (const c of r.calls) calls.push(c);
          }
        }
        const fin = parser.finish();
        if (fin.text) { text += fin.text; send(chunkOf({ content: fin.text })); }
        for (const c of fin.calls) calls.push(c);
        if (signal?.aborted) {
          // Client aborted mid-stream: the turn was never completed, so the
          // conversation must NOT be parked (cleanup will cancel it). Close
          // the stream the way a killed request should look — no error frame.
          throw signal.reason ?? up.abortErr("client aborted");
        }
        const { calls: finalCalls } = coerceRequiredCalls(calls, "", req, sawFence || calls.length > 0);
        // Mint each tool_call id exactly once and reuse it below: the chunks
        // the client sees and the assistant echo we park (whose shape the next
        // request's fingerprint is computed over) must carry the SAME ids —
        // the client re-sends them in its transcript, so a second mint here
        // would make every streaming tool turn miss the parked session.
        const streamed = finalCalls.map((c, i) => toOpenAIToolCall(c, i));
        for (const tc of streamed) {
          send(chunkOf({ tool_calls: [tc], content: null }));
        }
        send(chunkOf({}, streamed.length ? "tool_calls" : "stop"));
        if (includeUsage && usage) send(chunkOf({}, null, usage));
        done();
        // Park BEFORE cleanup (finishTurn marks the turn ended so the
        // cleanup below only detaches the listener). The echo the client
        // re-sends as the transcript prefix is the text + tool calls we just
        // streamed, so the next request's fingerprint matches.
        finishTurn({ role: "assistant", content: text || null, ...(streamed.length ? { tool_calls: streamed.map(({ index, ...rest }) => rest) } : {}) }, pump);
      } catch (e) {
        if (signal?.aborted) {
          cleanup();
          try { controller.close(); } catch {} // aborted: no error frame, no park
          return;
        }
        const err = mapError(e);
        controller.enqueue(encoder.encode(
          `data: ${JSON.stringify({ error: { message: err.message, type: "server_error", code: err.status ?? 502 } })}\n\n`,
        ));
        done();
      } finally {
        clearInterval(beat);
        cleanup();
        try { controller.close(); } catch {}
      }
    },
    cancel() { cleanup(); },
  });

  return new Response(readable, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

function mapError(e) {
  if (e?.status) return e;
  if (e instanceof up.DshError) {
    if (e.isModelUnavailable) return Object.assign(new Error(e.message), { status: 404 });
    if (e.isBusy) return Object.assign(new Error(e.message), { status: 503 });
    return Object.assign(new Error(e.message), { status: 502 });
  }
  if (e?.name === "AbortError") return Object.assign(new Error("client aborted"), { status: 499 });
  return Object.assign(new Error(e?.message ?? "upstream error"), { status: 502 });
}
