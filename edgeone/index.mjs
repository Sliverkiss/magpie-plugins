// magpie-edgeone — magpie provider plugin for DeepSeek Harness (EdgeOne Makers).
// Provider id stays "dsh2api" (the routing key; see README).
//
// The upstream (https://deepseek-harness.edgeone.cool) is an ANONYMOUS
// agent harness: no auth token, no cookie, no account. Isolation is by
// `makers-conversation-id` header, and every chat completion here mints a
// fresh conversation + session.
//
// magpie contract consequences (verified against host-2fffa1445f27.js):
//   - "Install and use" = one keyless api-type sign-in. The host's apiKey()
//     dispatch calls authorize() directly and requires the terminal
//     {type:"success"} object — callback is never invoked for api type.
//     `keyless: true` is the host's own flag (methods() mapping, line 1999)
//     that lets the method render without a key field.
//   - options() only calls loader() when a stored record exists — the
//     keyless sign-in writes {type:"api", key:"anonymous"}, which is that
//     record. expires:0 is never renewed; refresh() is a no-op probe.
//   - balance must be a bare "N 积分" string for keysSum; this upstream has
//     no credits, so usage returns plan/user/error only (never balance).
//   - No usage windows: windows[] would degrade the provider's keys card
//     from folded to spread layout (subs.every(!windows && !plan)), and
//     there is no quota to show anyway.
//   - checkin: no check-in activity exists upstream → "inactive" (a valid
//     outcome, never throws).
//
// Entry file exports ONE plugin function; test-only helpers go in _internal.

import * as up from "./src/upstream.mjs";
import { handleChat, _clearParkedSessions, parkedCount, warmCount } from "./src/chat.mjs";
import {
  STATIC_MODELS, toStaticModel, toDynamicModel, buildModelMap, fromUpstreamGroup,
  cachedModels, setCachedModels, cacheFresh, probeState, recordProbeFailure,
} from "./src/models.mjs";

const PROVIDER = "dsh2api";

export const Dsh2apiPlugin = async () => ({
  config: async (cfg) => {
    cfg.provider ??= {};
    cfg.provider[PROVIDER] ??= {
      name: "深寻沙盒 DeepSeek Harness",
      npm: "@ai-sdk/openai-compatible",
      api: `${up.BASE}/v1`,
      models: Object.fromEntries(STATIC_MODELS.map((m) => [m.id, toStaticModel(m)])),
    };
  },

  auth: {
    provider: PROVIDER,
    maxConcurrency: 4,
    refreshLead: 5 * 60_000,

    methods: [{
      type: "api",
      label: "启用 DeepSeek Harness（匿名，无需密钥）",
      keyless: true,
      async authorize() {
        // api-type dispatch calls authorize() directly and wants the
        // terminal object; failure must throw (never {type:"failed"}).
        // GUIDE 铁律：authorize() 必须立刻返回，网络探测挪出去（转圈 =
        // 用户以为卡死）。上游约 40% 的请求会挂起，之前在这里做 llm.models
        // 活体探测，登录按钮就无限转圈。可达性由 provider.models（17s 预
        // 算，失败回退静态表）和 usage 的 probeState（不打网络）呈现。
        // The stored record only needs to exist (options() gates loader on
        // it) and be distinguishable. uid is a random marker — settle()
        // dedupes repeat activations on identical accountId+uid, and a
        // fresh uid per activation would mint duplicate accounts, so we
        // keep accountId empty and let the fixed key be the identity.
        return { type: "success", key: "anonymous", expires: 0 };
      },
    }],

    // Nothing to renew: expires:0 accounts are never renewed by the host,
    // and there are no credentials to refresh.
    async refresh() {
      return undefined;
    },

    async loader(getAuth) {
      const auth = await getAuth();
      if (!auth) return {}; // not signed in → magpie's standard handling

      return {
        baseURL: `${up.BASE}/v1`,
        // apiKey is only a presence marker for sdkHeaders; the upstream
        // speaks no bearer auth — handleChat signs nothing.
        apiKey: "anonymous",
        headers: {},
        // magpie sends POST {baseURL}/chat/completions with a JSON string
        // body here. Everything else (/v1/models, gateway) is answered by
        // magpie itself from provider.models — we never see other paths.
        async fetch(input, init) {
          try {
            return await handleChat({
              // The SDK sends a JSON string, but a byte body is legal too —
              // decode it instead of stringifying it into mojibake.
              body: typeof init?.body === "string"
                ? init.body
                : (init?.body ? new TextDecoder().decode(init.body) : init?.body),
              // The routing table follows the live catalog when it is
              // fresh; otherwise the static table (which is always
              // routable). Never empty — an empty table means every
              // request 404s on "model not found".
              modelMap: buildModelMap(cacheFresh() ? cachedModels() : STATIC_MODELS),
              signal: init?.signal,
            });
          } catch (err) {
            const status = err?.status ?? 502;
            return new Response(
              JSON.stringify({ error: { message: err.message ?? "upstream error", type: status === 404 ? "invalid_request_error" : "server_error", code: status } }),
              { status, headers: { "content-type": "application/json" } },
            );
          }
        },
      };
    },

    // No quota/credits exist upstream. Return identity only — never
    // balance (keysSum needs a bare number string and there is no number),
    // never windows or plan (either one would spread the keys card layout,
    // and there is nothing worth spreading). No network here either: a
    // usage hook that probes stalls the whole quota page; liveness comes
    // from authorize() / provider.models(), which feed the probe cache.
    async usage(getAuth) {
      const auth = await getAuth();
      if (!auth) return { error: "未启用" };
      const p = probeState();
      if (p.ok === false) {
        return { user: "匿名会话", error: `上游不可达：${p.error.slice(0, 120)}` };
      }
      return { user: "匿名会话" };
    },

    // No check-in activity exists upstream → the valid "inactive" outcome.
    async checkin() {
      return { outcome: "inactive", message: "该平台无签到活动（匿名按量免费）" };
    },
  },

  // Dynamic per-account catalog: probe the live llm.models so new upstream
  // models appear without a plugin update. Three-state degradation:
  //   interface fails     → fall back to the static table (never empty)
  //   entry missing fields → skip that entry (don't guess)
  //   sign-in expired      → impossible here (no credentials)
  provider: {
    id: PROVIDER,
    async models() {
      // The host gives provider.models 20s before it gives up on the list.
      // Two attempts at 8s each plus backoff stay inside it; a failure here
      // falls through to the snapshot below (never an empty table).
      const probeOpts = { attempts: 2, timeoutMs: 8_000, budgetMs: 17_000, backoff: [0, 2_000] };
      try {
        const convId = up.newConvId();
        const { groups } = await up.llmModels(convId, probeOpts);
        const list = [];
        for (const g of groups) list.push(...fromUpstreamGroup(g));
        if (!list.length) throw new Error("empty catalog");
        setCachedModels(list);
        return Object.fromEntries(list.map((m) => [m.id, toDynamicModel(m)]));
      } catch (e) {
        // Fall back to the snapshot, never to an empty table: an empty
        // provider.models means the provider shows "0 models". The failure
        // also lands in the probe cache so the card can say "unreachable".
        recordProbeFailure(e);
        const list = cachedModels();
        return Object.fromEntries(list.map((m) => [m.id, toDynamicModel(m)]));
      }
    },
  },
});

export const _internal = {
  PROVIDER, BASE: up.BASE, STATIC_MODELS, buildModelMap, fromUpstreamGroup,
  localId: (g, u) => fromUpstreamGroup({ id: g, models: [{ id: u }] })[0]?.id,
  handleChat, _clearParkedSessions, parkedCount, warmCount, up,
};
