# pi-poolside

A [pi](https://pi.dev) provider plugin for the **Poolside inference API**
(`https://inference.poolside.ai/v1`).

It registers `poolside` as a first-class provider: the two Laguna ids from the
gateway's own `/v1/models` listing with their advertised limits and zero prices,
`/login` with a key check that generates no tokens, boolean thinking through
`chat_template_kwargs.enable_thinking`, `reasoning_content` preserved across
agent turns, a live listing overlay, and an error layer for the three failure
dialects this API actually produces — all measured, see
[`research/2026-09-26-live-verification.md`](research/2026-09-26-live-verification.md).

```
/plugin install pi-poolside     # or: pi install ./pi-poolside
/login poolside                 # or: export POOLSIDE_API_KEY=sky_…
```

## Models

Generated from `catalog.ts`, which is transcribed from the recorded listing
(`test/fixtures/listing.json`, measured **2026-09-26**; `test/catalog.test.ts`
fails if the two ever disagree).

| id | name | context | max output | tools | thinking | price |
|---|---|---|---|---|---|---|
| `poolside/laguna-xs-2.1` | Laguna XS 2.1 | 262 144 | 32 768 | yes | permitted | free |
| `poolside/laguna-s-2.1` | Laguna S 2.1 | 262 144 | 32 768 | yes | permitted | free |

- Numbers are the listing's `context_length` and `max_completion_tokens`, dated
  as measured — not probed, not estimated. There is no floor to mark.
- **Price is measured as zero**, not "unknown": every value in the listing's
  `pricing` object (`prompt`, `completion`, `request`, `image`,
  `input_cache_read`) is the string `"0"`, and both ids carry `is_free: true`.
  So `cost` is `{input: 0, output: 0, cacheRead: 0, cacheWrite: 0}` and pi will
  never invent a USD figure. Currency is USD by convention only; nothing here
  converts anything.
- Input modality is `text` for both (`input_modalities: ["text"]`).
- "thinking: permitted" is deliberate wording — see the trap below.

### Trap: the listing's field name is not the request field name

`GET /v1/models` calls the output cap **`max_completion_tokens`**. A request that
uses that name is rejected outright:

```
POST /v1/chat/completions  {…, "max_tokens": 8, "max_completion_tokens": 8}
→ 400 {"error":{"code":400,"type":"Bad Request",
       "message":"Invalid request: ['max_completion_tokens (8): Extra inputs are not permitted']"}}
```

The request field is **`max_tokens`** (documented range 1..262144, default
32768), and the plugin pins `compat.maxTokensField: "max_tokens"` explicitly
rather than letting pi auto-detect — auto-detection would agree with the listing
and break every request that carries a cap. pi's own bundled `nvidia` and
`openrouter` entries for these ids pin `max_tokens` too.

If you hand-write a `models.json` entry for this endpoint (see § Surfaces),
remember that the listing's name is a *description* field and `max_tokens` is
the wire field.

### Trap: thinking is a boolean, and "on" only means "permitted"

| what you send | what came back (measured 2026-09-26) |
|---|---|
| nothing | thinking on by default: 16 of a 16-token cap spent on reasoning, no answer, `finish_reason: length` |
| `chat_template_kwargs: {"enable_thinking": false}` | `reasoning_content: null`, `reasoning_tokens: 0`, `content: "Ok."` |
| `chat_template_kwargs: {"enable_thinking": true}` | `reasoning_tokens: 16` on one prompt, **`reasoning_tokens: 0`** on another |

Only `false` is deterministic. There is **no effort scale**: `reasoning_effort`
values produced non-monotonic reasoning-token counts (404/366/305 for
`minimal`/`low`/`high` in the recon), so the plugin sends no `reasoning_effort`
at all and does not pretend one exists.

The seven thinking levels pi knows therefore collapse to two here:

- **`off`** — sends `chat_template_kwargs: {"enable_thinking": false}`.
- **`low`** — the single "on" level; sends `true`. `minimal`, `medium`, `high`,
  `xhigh` and `max` are marked unsupported (`null` in `thinkingLevelMap`) and
  clamp **down** to `low`, so a request for `high` does not silently do nothing.

`off` is *not* mapped to `null` — that is pitfall T1, where a null `off` is
filtered out of the supported levels and then clamps upward into a thinking
request the user explicitly disabled. Both branches are asserted on the wire for
the whole catalog × all seven levels in `test/wire-format.test.ts`.

## How the compat flags are set (and why each one)

`inference.poolside.ai` matches none of pi-ai 0.87.1's auto-detection branches,
so the detected profile is a vanilla-OpenAI one that is wrong in four places.
Every flag is pinned explicitly:

| flag | auto-detected | pinned | evidence |
|---|---|---|---|
| `maxTokensField` | `max_completion_tokens` | **`max_tokens`** | the listing's name is rejected with `Extra inputs are not permitted` |
| `thinkingFormat` | `openai` | **`chat-template`** | `reasoning_effort` has no monotone effect; `chat_template_kwargs.enable_thinking` does |
| `chatTemplateKwargs` | `{}` | **`{enable_thinking: {$var: "thinking.enabled"}}`** | pure data, no hook: pi resolves it to `!!reasoningEffort`, and pi passes `reasoning: undefined` for `off` |
| `requiresReasoningContentOnAssistantMessages` | `false` (true only for DeepSeek) | **`true`** | the provider documents it as required for agentic workflows, and a real agent run was captured sending it back |
| `supportsDeveloperRole` | `true` (and pi emits `developer` whenever `reasoning` is set) | **`false`** | `system` is what every probe used; `developer` is unproven, and auto-detection would switch roles for every reasoning model |
| `supportsReasoningEffort` | `true` | **`false`** | the field has no measurable effect |
| `supportsStore` | `true` | **`false`** | would put `store: false` on every request for no documented reason |
| `supportsLongCacheRetention` | `true` | **`false`** | would add `prompt_cache_retention` / `prompt_cache_key`; no cache-control field is documented (the implicit cache is reported, not configured) |
| `supportsStrictMode` | `false` (pi 0.87 default) | `false` | pinned so a pi change cannot start sending strict tool schemas here |

`test/wire-format.test.ts` asserts all of this on the bytes, and asserts the
*absence* of `store`, `prompt_cache_retention`, `prompt_cache_key`,
`reasoning_effort`, `reasoning`, `thinking`, `store`, `priority`, `top_p` and
`top_k`.

## `reasoning_content` — sent because the provider requires it, and what that does *not* mean

Poolside's docs: *"For agentic workflows with Poolside models, preserve
`reasoning_content` from assistant responses when you include those responses in
follow-up requests. Dropping previous reasoning content can prevent the model
from reasoning in later steps."*

The echo is proved in a real run (`laguna-s-2.1`, two turns, bash tool used):
turn 2's outgoing body carried
`assistant.reasoning_content = "The user wants me to…"`, which is exactly the
thinking block pi had stored with signature `reasoning_content`.

**Be aware of what is *not* claimed.** The plugin was built to satisfy the
documented requirement; the *failure mode* the requirement describes did **not**
reproduce in this build. The paired experiment (identical second turn, with and
without the echo) gave 62 → 0 reasoning tokens on the first attempt and 25 → 96
on the second, and the automated harness reproduced it in 0 of 3 pairs. The flag
is set because the provider asks for the field, not because the penalty was
observed. Details and the experiment that would settle it:
[`research/2026-09-26-live-verification.md`](research/2026-09-26-live-verification.md) § 3.

## Surfaces — three states

Each row carries its own date and source, because they are not the same claim.

### 1. Checked and present

| surface | status | date | source |
|---|---|---|---|
| `POST /v1/chat/completions` | **200**, streaming, tools, usage on every chunk | 2026-09-26 | `research/raw/listing.txt`, `…/tool-call.txt`, `…/stream-usage.txt`; reproduced by `live/check.ts` A/C/D/E/G/H |
| `GET /v1/models` | **200**, two ids with full metadata | 2026-09-26 | `test/fixtures/listing.json` |
| `POST /v1/messages` (Anthropic shape) | **200** | 2026-09-26 | `research/raw/messages-surface.txt`; `live/check.ts` J |
| `POST /v1/responses` | **200** | 2026-09-26 | `research/raw/responses-surface.txt`; `live/check.ts` J |

### 2. Exists, deliberately not added — with the reason

| surface | why not |
|---|---|
| `POST /v1/messages` | Answers 200 with an Anthropic-shaped body (thinking blocks included), but it offers nothing this plugin needs: the completions route already carries tools, streaming and the documented thinking switch, and a second registered api surface doubles the wire matrix to keep honest. It was probed, priced (1 output token) and left unregistered. |
| `POST /v1/responses` | Same: 200 and functional, but the plugin's job is one working surface, and the thinking control documented for this provider is expressed in `chat_template_kwargs`, which belongs to the completions route. |
| `POST /v1/embeddings` | **404 `Model not found`** for every model id in the listing (`research/raw/embeddings-surface.txt`); no embedding model is advertised. Not a surface to add at all. |
| Poolside's own Pi page, `https://docs.poolside.ai/tools/pi.md` | This is the gap this plugin closes rather than a surface: the vendor's recommended setup is a hand-filled `~/.pi/agent/models.json` entry where *you* supply `reasoning`, `contextWindow` and `maxTokens`, with `"apiKey": "$POOLSIDE_API_KEY"` — the same env var this plugin uses, so both can coexist. It also documents a self-managed `https://<model-hostname>/v1` endpoint; this plugin points at the hosted endpoint by default and accepts `POOLSIDE_BASE_URL` for exactly that case (unprobed). |
| Poolside ids already inside pi — under other providers | pi 0.87.1 ships `poolside/laguna-xs-2.1` under **`nvidia`** (`integrate.api.nvidia.com`, `maxTokens: 16384`, `maxTokensField: "max_tokens"`) and both ids under **`openrouter`** (including a `:free` variant with `thinkingFormat: "openrouter"`), plus `poolside/laguna-s-2.1` under **`vercel-ai-gateway`** (Anthropic Messages). A native provider is still worth it: the direct free endpoint, the listing's real 262 144 window instead of 16 384 output cap, `chat_template_kwargs` thinking control, `/login`, and error messages that name the actual failure. |

### 3. Deliberately not investigated

| what | why |
|---|---|
| Non-chat modalities (vision, audio, embeddings, rerank) | The listing advertises `text` in and out for both ids and there is no embeddings or audio route (404, state 2). Nobody looked for a multimodal adapter and none is needed for a coding agent. |
| The `vercel-ai-gateway` Anthropic route for these ids | It exists in pi's manifest and uses a different base URL and key; not probed, not claimed. |
| Whether a self-managed Poolside deployment behaves like the hosted one | `POOLSIDE_BASE_URL` exists for it, but that path was never exercised. |

## What is verified live, and how

Full detail with raw evidence: [`research/2026-09-26-live-verification.md`](research/2026-09-26-live-verification.md).

| claim | method | how you can re-check |
|---|---|---|
| the two ids and their window/cap/features | `GET /v1/models`, recorded verbatim | `node live/probe.ts listing` |
| the listing's `max_completion_tokens` name is rejected | pre-inference 400, free | `node live/probe.ts max-completion-tokens-field` |
| the `max_tokens` ceiling is 262144 | pre-inference 400, free | `node live/probe.ts max-tokens-too-big` |
| `temperature` range 0..2 | pre-inference 400, free | `node live/probe.ts temperature-3` |
| 401 = no header, 403 = wrong key, 404 = unknown model | recorded bodies | `node live/probe.ts listing-noauth`, `badkey-chat`, `unknown-model` |
| the empty body is rejected *before* auth, so it is not a key check | paired real/bogus-key requests | `node live/probe.ts badkey-empty-body` |
| 502 HTML for an empty `Authorization` value | 4/4 deterministic | `node live/probe.ts listing-empty-auth` |
| wrong key on `GET /models` loses the body to a stream reset | `curl` and undici both | `node live/probe.ts listing-badkey` |
| thinking off/on via `chat_template_kwargs` | two tiny generations | `node live/check.ts` check E |
| the outgoing bytes (`max_tokens`, `enable_thinking`, no `developer` role) | pi-ai's real adapter, payload captured before send (free) | `node live/check.ts` check D |
| usage on every SSE chunk does not corrupt pi's totals | recorded stream replayed through pi's adapter | `node live/check.ts` check H |
| a tool call comes back well formed | one 256-token request | `node live/check.ts` check G |
| `reasoning_content` on the second request in a **real** agent run | `before_provider_request` hook + session JSONL | `pi -e <wire-hook> -p --model poolside/poolside/laguna-s-2.1 "…bash tool…"` |
| `/login`'s key check accepts a good key and rejects a bad one | 404 vs 403, both free | `node live/check.ts` check B |
| the error path in print mode | bogus key → one clarified line, exit 1 | `POOLSIDE_API_KEY=sky_bogus… pi -p …` |

Run the whole harness with `npm run live` after `set -a; . ./secret.env; set +a`
(or after `pi /login poolside`). It is paced 3 s apart, gated on a real key, and
never part of `npm test`. Set `POOLSIDE_LIVE_SKIP_COSTLY=1` to stop after the
free checks.

## Cost log

The key is free — the listing prices every field at `"0"` and sets
`is_free: true` — so the honest ledger is **tokens**, not dollars: **$0.00** is
spent, and it is the provider's own number rather than an estimate.

Every 2xx is itemised. Latest full harness run (22 requests):

| request | status | in | out | reasoning | cached |
|---|---|---|---|---|---|
| `GET /v1/models` | 200 | 0 | 0 | 0 | 0 |
| nine pre-inference rejections (401/403/404/400 × the traps) | 400–404 | 0 | 0 | 0 | 0 |
| `enable_thinking: false` | 200 | 46 | 1 | 0 | 32 |
| `enable_thinking: true` | 200 | 46 | 16 | 16 | 32 |
| 3 pairs, with `reasoning_content` | 200 | 90 each | 2/96/2 | 0/96/0 | 32/0/0 |
| 3 pairs, without | 200 | 77 each | 2/96/2 | 0/96/0 | 32/0/32 |
| tool round-trip | 200 | 153 | 32 | 0 | 16 |
| SSE stream | 200 | 46 | 2 | 0 | 32 |
| `/v1/messages`, `/v1/responses` | 200 | 14, 46 | 1, 1 | 0, 1 | 0, 32 |
| `/v1/embeddings` | 404 | 0 | 0 | 0 | 0 |
| **totals** | 13 × 2xx, 9 × free 4xx | **852** | **253** (209 reasoning) | | **240** |

Bound: every generative request uses `max_tokens ≤ 16` except the tool
round-trip (256) and the reasoning pairs (96); each request is paced 3 s apart;
the rejections that cost nothing were used wherever a rejection could answer the
question. Real `pi` runs (four print-mode runs and two two-turn agent runs) added
a few hundred tokens on top, from prompts whose sizes are visible in the session
JSONL.

## What remains unverified

Each line says how to check it — no untested claim is dressed up as a tested one.

- **The context-overflow wording.** Nothing was ever sent over the window (that
  is the one probe that costs real tokens if it is accepted instead of rejected).
  pi 0.87.1 already ships a Poolside-flavoured pattern
  (`pi-ai/dist/utils/overflow.js:56`, `/exceeds maximum allowed input length of N
  tokens/`), so compaction may already work; this plugin adds no overflow rewrite
  because none was measured. *Check:* send ~10× 262 144 tokens in one message and
  read the 4xx; if a 200 comes back it was billed.
- **429 / rate-limit behaviour.** No 429 was observed in any run, so no 429
  wording exists in the error layer. *Check:* burst requests and record the body.
- **The `reasoning_content` penalty.** See § above: the documented failure did
  not reproduce in this build. *Check:* 10+ paired turns, one variable.
- **Whether `enable_thinking: true` ever forces reasoning.** The plugin treats it
  as "permitted"; measured runs answered with 0 reasoning tokens under a
  tool-heavy system prompt. *Check:* a prompt that reliably triggers thinking.
- **`top_k` / `min_p`.** Documented in prose (defaults 20 / 0) but absent from
  the listing's `supported_sampling_parameters`, so they are never sent.
  *Check:* send each and see whether the output distribution changes at all.
- **Cache behaviour.** `prompt_tokens_details.cached_tokens` is non-zero
  (implicit cache), but no cache-control field was probed and `promptCache` is
  not declared, so pi never warms a cache and never sends a retention field.
  *Check:* two identical prompts, compare `cached_tokens`.
- **`POOLSIDE_BASE_URL` (self-managed endpoint / mirror).** The override exists
  and is documented by the vendor; the path was not exercised. Same for the
  `vercel-ai-gateway` route.
- **`/v1/messages` and `/v1/responses` semantics.** Both answer 200; thinking
  control, tools and streaming on those routes were not exercised.
- **Behaviour outside the free tier.** `is_free: true` is what the listing says
  today; nothing here would change if Poolside priced inference tomorrow except
  that `cost` would need to come from a real price list.

## Design notes

### Layout

```
index.ts       the only pi-runtime-coupled file: registers the provider, wires
               message_end / turn_end. Everything else loads under plain Node.
provider.ts    createProvider assembly, base URL, auth (including the
               zero-inference /login probe)
catalog.ts     the frozen listing + parseListing(), shared with discovery
models.ts      catalog → pi Model: compat flags, thinkingLevelMap
discovery.ts   additive, unknowns-only /v1/models overlay
errors.ts      three-dialect parsing, body recovery, clarifications
test/          160 offline tests, incl. the wire-format matrix and recorded fixtures
live/          check.ts (paced harness), probe.ts (one named probe at a time),
               make-error-fixtures.ts (regenerates the committed fixtures)
```

### Error layer, in two layers

`message_end` rewrites the finalized assistant message (so the transcript, the
next request and the display agree) into an actionable sentence:
**401 is a missing header, 403 is a wrong key, 404 is an unknown model id** —
which is this gateway's arrangement, not the usual one, so the wording is taken
from its own bodies rather than from another plugin. The
`max_completion_tokens` rejection and the empty-body rejection get their own
sentences because both are invisible from pi's side.

`turn_end` adds **one** persistent TUI note for the states a human must act on,
and is gated on `ctx.hasUI` — an entry appended after the errored assistant
message makes `pi -p` print nothing at all (pitfall P23). Verified: a bogus key
in print mode prints exactly one clarified line and exits 1.

`withBodyRecovery` is installed because it was measured to help: the 502 proxy
page arrives as a wall of HTML and the enveloped 400s as raw JSON. It is *not*
there because bodies are dropped — in the measured set none are (see the
corrections in the research log).

### Non-goals

- **No overflow rewrite.** Nothing measured an overflow rejection here; inventing
  wording would risk laundering a throttle into a compaction loop.
- **No `payload.ts` / hook-based request surgery.** The two request-shape
  decisions are expressed as pi data (`maxTokensField`, `thinkingFormat` +
  `chatTemplateKwargs`), which is testable on the wire without a hook. A
  `before_provider_request` hook exists only inside the test harness.
- **No streaming `usage` workaround.** pi already assigns per chunk
  (`openai-completions.js:362`), which is correct for this gateway's cumulative
  usage; the plugin leaves pi's accounting alone and pins the behaviour in a test.
- **No second api surface, no `filterModels`, no account gating.** Everything the
  listing offers is free, so there is nothing to gate.
- **No `promptCache` declaration.** Warm-up requests are extra billed requests;
  nothing here measured a cache-control field, so none is configured.

## Testing

```
npm run typecheck   # tsc against the installed pi types (see tsconfig.json for
                    # the symlink recipe — node_modules is machine-specific)
npm test            # 160 offline tests; test/no-network.ts preload makes any
                    # accidental dial-out throw
npm run live        # the paced live harness (needs a key; never part of npm test)
```

`test/fixtures/*.json` are generated from the recorded raw responses by
`node live/make-error-fixtures.ts` — never hand-transcribed, since a synthetic
fixture hides exactly the shape that needed handling.
