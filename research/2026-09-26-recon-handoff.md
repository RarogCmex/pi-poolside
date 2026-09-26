# poolside — measured reconnaissance (handoff to the build)

`https://inference.poolside.ai/v1`, key `sky_...`, **free** (in exchange for
training data) — so probes are cheap, but they still get bounded and itemised.
Env var name: **`POOLSIDE_API_KEY`** (that is what Poolside's own pi page uses —
see "Docs" below, and match it).

Behind the endpoint: Baseten (`server: gunicorn`, `vary: Authorization,
X-Baseten-Client`). pi-ai does have a `baseten` thinking format, but URL
detection will not pick it up here — treat the compat flags as ours to set.

## The `/models` listing is a real catalog source (rare — use it)

`GET /v1/models` (needs the key; without one: **401 plain text** `No Authorization
header provided`) returns **2** models with rich metadata, all measured today:

| id | context_length | max_completion_tokens (listing field) | supported_features | input/output modalities | supported_sampling_parameters |
|---|---|---|---|---|---|
| `poolside/laguna-xs-2.1` | 262144 | 32768 | `["tools","reasoning"]` | text/text | `["temperature"]` |
| `poolside/laguna-s-2.1` | 262144 | 32768 | `["tools","reasoning"]` | text/text | `["temperature"]` |

Also present per model: `name`, `description`, `quantization` (`fp8`),
`hugging_face_id`, `is_free: true`, and a `pricing` object whose every value is
the string `"0"` (`prompt`, `completion`, `request`, `image`,
`input_cache_read`). So the catalog's numbers can be **sourced from the listing**
(frozen with a date) instead of probed — do that, and let the discovery overlay
read the same fields rather than inventing a merge policy.

**Trap in that listing**: the field is *named* `max_completion_tokens`, but that is
not the request field this API accepts (see below). Say so explicitly in the
README; anyone copying the listing field name gets a 400.

## Request shape — measured

- **`max_tokens` is the field**, documented range 1..262144 and enforced:
  `max_tokens: 99999999` → **400** (free) `Invalid request: ['max_tokens
  (99999999): Input should be less than or equal to 262144']` — the cap is
  *disclosed by a rejection*, so nothing needs buying.
- **`max_completion_tokens` is not a valid request field**: sending it *alongside*
  `max_tokens` → `400 ... ['max_completion_tokens (500): Extra inputs are not
  permitted']`. Pin `compat.maxTokensField: "max_tokens"` explicitly — do not rely
  on autodetect.
- `max_tokens: 8` is honoured (8 output tokens, `finish_reason: length`).
- `temperature` 0..2 (default 1.0); `temperature: 3` → **400** free, `Validation:
  Temperature must be between 0 and 2, got 3`. The listing advertises only
  `temperature` as a sampling parameter, though `top_p: 0.5` was accepted (200) —
  acceptance is not evidence (L3); send only what is documented.
- Streaming works; `reasoning_content` deltas arrive **before** `content`, and
  **every chunk carries `usage`** (docs confirm `stream_options.include_usage:
  false` does *not* suppress it). Verify pi's accounting does not double-count.
- Tools work: 200, `finish_reason: "tool_calls"`, well-formed tool call with JSON
  arguments.
- No rate limit hit in a burst of 8 requests — no 429 observed.

## Thinking: on by default, off is boolean, `reasoning_effort` is a mirage

- **On by default**, and it is most of the output: `max_tokens: 64` with "say ok"
  produced `completion_tokens: 64`, of which `reasoning_tokens: 64` — i.e. **no
  answer at all**, just reasoning, `finish_reason: length`. Same failure shape as
  pitfalls T26, but here the reasoning is in a proper `reasoning_content` field
  (not inline `<think>`), so pi displays it correctly.
- **Off works, as documented**: `chat_template_kwargs: {enable_thinking: false}` →
  measured `reasoning_tokens: 0`, `reasoning_content: null`, `finish_reason: stop`,
  2 output tokens.
- **`reasoning_effort` produces no observable effect**: same prompt, 900-token cap,
  n=1 — none: 644 reasoning tokens; `"minimal"`: 404; `"low"`: 366; `"high"`: **305**.
  Non-monotonic, so it is run-to-run variance, not an effort scale. `"none"` did
  switch thinking off, but the documented switch is `enable_thinking` — use that
  and record this as "acceptance is not effect" (L3).
  → Conclusion to design around: **thinking here is boolean**. Decide explicitly
  what the plugin does with pi's seven levels (all non-off levels will mean "on")
  and write that decision down instead of exposing a scale that does not exist.
- **pi-internals fact you will need** (verified in the installed dist):
  `compat.chatTemplateKwargs` is consumed **only** in the
  `thinkingFormat === "chat-template"` branch (`pi-ai/dist/api/openai-completions.js:645-650`,
  which additionally requires `model.reasoning`), and the value can be driven by
  the `{$var: "thinking.enabled"}` mechanism (`resolveChatTemplateKwargValue`
  returns `!!reasoningEffort`). So `thinkingFormat: "chat-template"` +
  `chatTemplateKwargs: {enable_thinking: {$var: "thinking.enabled"}}` expresses
  on/off in pure data — verify it on the wire before believing it.

## The requirement pi already has a flag for: preserve reasoning

Poolside's docs are explicit: in agentic workflows you must send `reasoning_content`
back on assistant messages, or the model may stop reasoning in later steps
(`docs.poolside.ai` → API examples → "Preserve reasoning in agentic workflows").

pi has exactly this as a compat flag — `requiresReasoningContentOnAssistantMessages`
(`pi-ai/dist/types.d.ts:548`; applied at `openai-completions.js:1044`; autodetected
`true` only for DeepSeek, so it is `false` here unless we set it). Set it per model
and prove with a wire-format test that the assistant message on the *second*
request carries `reasoning_content`.

## Errors: two dialects, and one of them the SDK will drop

| case | status | body (verbatim) | survives the SDK? |
|---|---|---|---|
| no `Authorization` header | **401** | plain text `No Authorization header provided` | **no** |
| wrong key | **403** | `{"error":"please check the api-key you provided"}` — `error` is a **string** | **no** |
| unknown model | **404** | `{"error":"please check the model you provided"}` — string again | **no** |
| range violations | **400** | `{"error":{"code":400,"message":"Invalid request: [...]: Input should be less than or equal to 262144","type":"Bad Request"}}` | yes (enveloped) |

So body recovery is warranted here on *measured* grounds (not by analogy with
another gateway), and the recorded fixtures must include the **string-`error`**
shape — a synthetic enveloped fixture would hide exactly the case that needs the
wrapper (this mistake cost the seekai build a correction; see its
`test/errors.test.ts` history). Note also **401 vs 403 is not "missing header vs
bad key"** — 403 is the wrong key, so do not copy Sarvam's 401/403 wording.

## Docs (Lane B, free)

- `https://docs.poolside.ai/llms.txt` — real machine-readable index (17 561 bytes).
- `https://docs.poolside.ai/tools/pi.md` — **Poolside's own Pi page**. It recommends
  a `~/.pi/agent/models.json` provider entry with `"apiKey": "$POOLSIDE_API_KEY"`
  and asks the reader to fill in `reasoning`, `contextWindow`, `maxTokens` *by
  hand*. That is the gap this plugin closes — say so in the README (and note the
  env var matches, so the two coexist).
- `https://docs.poolside.ai/api/openai-api-examples.md`, `/get-started/supported-models.md`.
- Worth recording under "the road others took": **pi already ships poolside model
  ids** in its bundled manifest, but under the **`nvidia`** provider (base URL
  `integrate.api.nvidia.com`, and with `contextWindow: 131072` — half the real
  262144) and under **`openrouter`** (`poolside/laguna-s-2.1:free`, `thinkingFormat:
  "openrouter"`). A native provider is still worth it: the direct free endpoint,
  correct limits, `chat_template_kwargs` thinking control, `/login`, and error
  clarity. Document the overlap instead of ignoring it.

## Constraints

1. The key is free, but "free" is not a licence to be sloppy: bound bodies, itemise
   every 2xx, and prefer the free rejections this API kindly provides
   (`max_tokens`, `temperature`, unknown model, bad key — all reject pre-inference).
2. Nothing in this file needs re-measuring. Everything not measured here and not
   documented must be marked `unverified` with how to check it.
3. Expect the catalog to be *thin but certain* (two models, listing-sourced
   numbers) — resist padding it.
