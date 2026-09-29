/**
 * Catalog → pi `Model` conversion for the Poolside inference API, plus the
 * compat flags that make pi speak the gateway's dialect.
 *
 * `inference.poolside.ai` matches none of pi-ai 0.87.1's URL auto-detection
 * branches, so the auto-detected profile is a vanilla-OpenAI one that is wrong
 * here in four measured ways — each pinned below with the evidence that
 * motivated it:
 *
 * | flag | auto-detected | what this plugin pins | why (all measured 2026-09-26) |
 * |---|---|---|---|
 * | `maxTokensField` | `max_completion_tokens` | `max_tokens` | sending the listing's field name is rejected: `Extra inputs are not permitted` |
 * | `thinkingFormat` | `openai` (i.e. `reasoning_effort`) | `chat-template` | `reasoning_effort` has no effect; `chat_template_kwargs.enable_thinking` does |
 * | `requiresReasoningContentOnAssistantMessages` | `false` (true only for DeepSeek) | `true` | the provider documents the echo as required for agentic workflows, and a real agent run was captured sending it back. The *penalty* it warns about was NOT reproduced here — see README § `reasoning_content` |
 * | `supportsDeveloperRole` | `true` (and pi emits `developer` whenever `reasoning` is set) | `false` | no probe has ever seen this gateway accept `developer`; `system` works |
 *
 * `supportsReasoningEffort`, `supportsStore` and `supportsLongCacheRetention`
 * are pinned `false` because each one would otherwise put an unproven request
 * field on the wire for every single request. Three more are pinned `false`
 * without a measurement behind them — `requiresToolResultName`,
 * `requiresAssistantAfterToolResult` and `requiresThinkingAsText` — because the
 * gateway is OpenAI-shaped and none of the three workarounds was ever needed in
 * a probe; they are pinned so a pi default change cannot turn them on silently.
 */

import type { Model, ModelCost, OpenAICompletionsCompat } from "@earendil-works/pi-ai";
import { CATALOG, type CatalogEntry, type GatewayApi } from "./catalog.ts";

export type { GatewayApi } from "./catalog.ts";

export const PROVIDER_ID = "poolside";
export const DEFAULT_BASE_URL = "https://inference.poolside.ai/v1";

/**
 * **Decision 1 — the output cap is sent as `max_tokens`.**
 *
 * `GET /v1/models` names the cap `max_completion_tokens`, and pi-ai's
 * auto-detection would agree with the listing (`detectCompat` returns
 * `max_completion_tokens` for any host that is not chutes/DeepSeek/Moonshot/
 * Cloudflare/Together — `api/openai-completions.js:1246-1252`). Both are wrong
 * for *this* API: the listing's field name is not a request field.
 *
 * Measured (`research/raw/max-completion-tokens-field.txt`), free because it is
 * a pre-inference rejection:
 *
 * ```
 * POST /v1/chat/completions  {…, "max_tokens": 8, "max_completion_tokens": 8}
 * -> 400 {"error":{"code":400,"type":"Bad Request",
 *        "message":"Invalid request: ['max_completion_tokens (8): Extra inputs are not permitted']"}}
 * ```
 *
 * and `max_tokens` alone is honoured (`max_tokens: 8` → 8 output tokens,
 * `finish_reason: "length"` in the recon). The extra corroboration that this is
 * a general property of the model family rather than of this endpoint: pi's own
 * bundled NVIDIA and OpenRouter entries for the same two Laguna ids both pin
 * `maxTokensField: "max_tokens"` (`pi-ai/dist/providers/data/nvidia.json`).
 *
 * This is the one field where a wrong guess is *not* silently tolerated: the
 * gateway rejects the request outright, so getting it right is the difference
 * between a working plugin and every compaction call failing.
 */
export const MAX_TOKENS_FIELD: NonNullable<OpenAICompletionsCompat["maxTokensField"]> =
  "max_tokens";

/**
 * **Decision 2 — thinking is a boolean, expressed as data.**
 *
 * Measured facts (`research/raw/gen-thinking-*.txt`):
 *
 * | request | result |
 * |---|---|
 * | (no thinking field) | `reasoning_content` present, `reasoning_tokens: 16` of a 16-token cap — thinking is **on by default** and can consume the whole answer |
 * | `chat_template_kwargs: {enable_thinking: false}` | `reasoning_content: null`, `reasoning_tokens: 0`, `content: "Ok."`, `finish_reason: "stop"` |
 * | `chat_template_kwargs: {enable_thinking: true}` | thinking on |
 * | `reasoning_effort: "none"` | thinking off — but `"minimal"`/`"low"`/`"high"` were *non-monotonic* in the recon (644/404/366/305 reasoning tokens), so this is a disable token, not a scale |
 *
 * The provider's own documentation names the switch: *"Poolside-hosted inference
 * enables thinking by default. To turn it off for a request, set
 * `chat_template_kwargs.enable_thinking` to `false`"*
 * (<https://docs.poolside.ai/api/openai-api-examples.md>, § "Turn off thinking").
 *
 * ## What pi's seven levels mean here
 *
 * There is no effort scale, so **the plugin does not show one**. `thinkingLevelMap`
 * keeps exactly two levels: `off` and `low`. Everything between them is set to
 * `null`, which in pi's vocabulary means "this level does not exist" — the
 * picker hides it and `clampThinkingLevel` moves a request for `medium`,
 * `high`, `xhigh` or `max` *down* to `low`, which is the single "thinking on"
 * state this model has. `off` is deliberately **not** mapped to `null`: a null
 * `off` is filtered out of the supported levels, and `off` then clamps *upward*
 * to a reasoning level — silently billing thinking the user asked to disable.
 *
 * The wire expression is pure data, no hook:
 *
 * ```
 * thinkingFormat: "chat-template"
 * chatTemplateKwargs: { enable_thinking: { $var: "thinking.enabled" } }
 * ```
 *
 * pi-ai resolves `{$var: "thinking.enabled"}` to `!!reasoningEffort`, and
 * `streamSimple` sets `reasoningEffort = clampedReasoning === "off" ? undefined :
 * clampedReasoning` (in pi-ai's `api/openai-completions.js`; pi-ai is an unpinned
 * peer, so cite the symbol rather than the offset) — so `off` becomes the
 * literal `false` and any other level becomes `true`. Both branches are asserted
 * byte-for-byte in `test/wire-format.test.ts` across the whole catalog and all
 * seven levels.
 *
 * `low` carries an explicit string so the map is complete for the levels pi can
 * still reach — an *omitted* entry keeps the level supported and falls back to
 * pi's internal name; the `chat-template` branch never sends it, but a
 * future change of `thinkingFormat` cannot silently leak `"medium"` onto the
 * wire.
 */
export const THINKING_LEVEL_MAP = {
  // `off` is intentionally absent: supported, and resolved by the $var below.
  minimal: null,
  low: "low",
  medium: null,
  high: null,
  xhigh: null,
  max: null,
} as const;

/** The single "thinking on" level this model exposes; every other level clamps here. */
export const THINKING_ON_LEVEL = "low";

/** The literal request field the switch is expressed through, for tests and docs. */
export const THINKING_FIELD = "chat_template_kwargs.enable_thinking";

/**
 * Compatibility flags for the completions surface. Every line below is pinned
 * for a reason stated next to it; the four that differ from auto-detection are
 * discussed above.
 */
export const CHAT_COMPAT: OpenAICompletionsCompat = {
  // Decision 1: the listing's field name is not a request field.
  maxTokensField: MAX_TOKENS_FIELD,
  // Decision 2: boolean thinking through chat_template_kwargs.
  thinkingFormat: "chat-template",
  chatTemplateKwargs: { enable_thinking: { $var: "thinking.enabled" } },
  // Measured: `reasoning_effort` values have no monotone effect, and the
  // documented switch is `enable_thinking`. Sending the field at all would be a
  // claim the plugin cannot support.
  supportsReasoningEffort: false,
  // Decision 3: the gateway requires the previous turn's `reasoning_content`
  // back. pi only applies this when `model.reasoning` is true (:1044-1047).
  requiresReasoningContentOnAssistantMessages: true,
  // Auto-detects true, which would make pi-ai emit the `developer` role for
  // every reasoning model (:896). Measured working: `system`.
  supportsDeveloperRole: false,
  // Auto-detects true → pi would send `store: false` on every request (:584).
  // Nothing documents `store` here; do not claim it either way.
  supportsStore: false,
  // Auto-detects true → `--cache-retention long` would put
  // `prompt_cache_retention: "24h"` / `prompt_cache_key` on the wire (:576-579).
  // The gateway *does* report implicit cache reads (`prompt_tokens_details
  // .cached_tokens`, measured 32/46 on a repeated prompt) but documents no
  // retention control, so no retention field is sent.
  supportsLongCacheRetention: false,
  // pi 0.87 already defaults this false for an OpenAI-compatible host it does
  // not recognise; pinned explicitly so a pi default change cannot start sending
  // strict tool schemas here.
  supportsStrictMode: false,
  // Measured: usage arrives in the stream (and even without `stream_options`).
  supportsUsageInStreaming: true,
  supportsFinishReason: true,
  requiresToolResultName: false,
  requiresAssistantAfterToolResult: false,
  requiresThinkingAsText: false,
  supportsOpenAIGrammarTools: false,
};

/**
 * Zero, and measured as zero: the listing prices both models at `"0"` for
 * `prompt`, `completion`, `request`, `image` and `input_cache_read`. `cacheRead`
 * is priced at 0 even though cache reads really happen (see above) — that is the
 * listing's number, not a missing one.
 */
const ZERO_COST: ModelCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export type PoolsideModel = Model<GatewayApi>;

export function entryToModel(entry: CatalogEntry, baseUrl: string): PoolsideModel {
  return {
    id: entry.id,
    name: entry.name,
    api: "openai-completions",
    provider: PROVIDER_ID,
    baseUrl,
    reasoning: entry.reasoning,
    input: entry.input,
    cost: { ...ZERO_COST },
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens,
    thinkingLevelMap: { ...THINKING_LEVEL_MAP },
    compat: { ...CHAT_COMPAT },
  } satisfies Model<"openai-completions">;
}

export function buildModels(baseUrl: string): PoolsideModel[] {
  return CATALOG.map((entry) => entryToModel(entry, baseUrl));
}
