// dsh2api — model catalog.
//
// The upstream catalog is discovered live from `llm.models` (two provider
// groups: edgeone-makers + deepseek-official), but a STATIC table is
// mandatory in `config` — magpie shows it before anyone activates the
// provider, and an empty table reads as "0 models" (HOOKS §3 / GUIDE §3).
//
// Live-verified 2026-11-02 via llm.models:
//   edgeone-makers:    @makers/hy3, @makers/hy3-preview, @makers/deepseek-v4-pro,
//                      @makers/deepseek-v4-flash, @makers/minimax-m3,
//                      @makers/minimax-m2.7, @makers/kimi-k2.6
//   deepseek-official: deepseek-v4-flash, deepseek-v4-pro
//
// One id derivation for BOTH the static table and the live catalog, so a
// model id always means the same upstream route.

import { TEXT_ONLY } from "./chat.mjs";

// group id → local id prefix rule. edgeone-makers models are published
// as "@makers/<name>"; the local id drops that prefix. The official group
// would collide with the makers ids, so it gets an "-official" suffix.
export function localId(groupId, upstreamId) {
  const base = String(upstreamId ?? "").replace(/^@makers\//, "");
  if (groupId === "edgeone-makers") return base;
  if (groupId === "deepseek-official") return base.endsWith("-official") ? base : `${base}-official`;
  return `${groupId}-${base}`;
}

// [groupId, upstreamId, displayName]
const CATALOG = [
  ["edgeone-makers", "@makers/deepseek-v4-flash", "DeepSeek V4 Flash"],
  ["edgeone-makers", "@makers/deepseek-v4-pro", "DeepSeek V4 Pro"],
  ["edgeone-makers", "@makers/hy3", "Hunyuan 3"],
  ["edgeone-makers", "@makers/hy3-preview", "Hunyuan 3 Preview"],
  ["edgeone-makers", "@makers/minimax-m3", "MiniMax M3"],
  ["edgeone-makers", "@makers/minimax-m2.7", "MiniMax M2.7"],
  ["edgeone-makers", "@makers/kimi-k2.6", "Kimi K2.6"],
  ["deepseek-official", "deepseek-v4-flash", "DeepSeek V4 Flash (official)"],
  ["deepseek-official", "deepseek-v4-pro", "DeepSeek V4 Pro (official)"],
];

export const STATIC_MODELS = CATALOG.map(([groupId, upstreamId, name]) => ({
  id: localId(groupId, upstreamId),
  name,
  provider: groupId,
  model: upstreamId,
}));

// The harness runs an agentic loop with sandbox tools (file writes, shell).
// The plugin teaches the external-tool protocol instead (fenced tool_call
// blocks), so toolcall stays on; attachment stays off and image input is
// explicitly false — omitting it means "vendor unstated", and magpie then
// votes with models.dev, which would mark image-capable models as taking
// images (silent-failure #5 in the skill).
// free: the upstream has NO billing surface at all (no account, no credits,
// no rate fields in llm.models — live-probed 2026-11-02): the vendor serves
// everything at no cost. `free: true` feeds magpie's Free-first routing;
// the "剩余额度未知" on its single anonymous account is cosmetic — there is
// nothing to order within one account, and a fabricated balance would only
// pollute the balance trend chart.
export function toStaticModel(m) {
  return {
    id: m.id,
    name: m.name,
    attachment: false,
    tool_call: true,
    free: true,
    modalities: { input: ["text"], output: ["text"] },
    capabilities: { reasoning: false, attachment: false, toolcall: true, input: { ...TEXT_ONLY } },
  };
}

export function toDynamicModel(m) {
  return {
    id: m.id,
    name: m.name,
    attachment: false,
    free: true,
    capabilities: { reasoning: false, attachment: false, toolcall: true, input: { ...TEXT_ONLY } },
  };
}

// id → { provider, model } routing table for the chat handler.
export function buildModelMap(list = STATIC_MODELS) {
  const map = {};
  for (const m of list) map[m.id] = { provider: m.provider, model: m.model };
  return map;
}

// Normalize one upstream llm.models group into local-model records.
export function fromUpstreamGroup(group) {
  const groupId = group?.id;
  if (!groupId) return [];
  return (group.models ?? [])
    .filter((m) => m?.id)
    .map((m) => ({
      id: localId(groupId, m.id),
      name: m.name ?? String(m.id).replace(/^@makers\//, ""),
      provider: groupId,
      model: m.id,
    }));
}

// The live catalog, cached: the chat path must not probe the upstream on
// every request, but a model added upstream must become routable soon.
// TTL 10 minutes; a probe failure keeps the previous snapshot.
let cache = { at: 0, list: STATIC_MODELS };
const TTL_MS = 10 * 60_000;

// The last upstream probe's outcome, so the card can say "upstream
// unreachable" without probing on every render (a usage hook that hits
// the network stalls the whole quota page).
let probe = { ok: null, at: 0, error: "" };

export function cachedModels() {
  return cache.list;
}

export function setCachedModels(list) {
  if (Array.isArray(list) && list.length) cache = { at: Date.now(), list };
  probe = { ok: true, at: Date.now(), error: "" };
  return cache.list;
}

export function recordProbeFailure(err) {
  probe = { ok: false, at: Date.now(), error: String(err?.message ?? err ?? "") };
  return probe;
}

export function probeState() {
  return probe;
}

export function cacheFresh() {
  return Date.now() - cache.at < TTL_MS;
}
