# Poolside provider — live verification log (2026-09-26)

Everything below was measured against `https://inference.poolside.ai/v1` on
2026-09-26 with the free key from `secret.env`, by this build, unless a line says
otherwise. Raw bodies for the free probes are in `research/raw/` (gitignored;
regenerate with `node live/probe.ts <name>`), and the committed fixtures are
generated from them by `live/make-error-fixtures.ts`.

The recon handoff (`research/2026-09-26-recon-handoff.md`) was **not** re-measured
as a whole. Where this build checked one of its claims and got a different
answer, the difference is recorded under "Where the recon was wrong" at the end.

## Cost

The key is free: the listing prices every field of both models at the string
`"0"` and sets `is_free: true`. Money spent: **$0.00**. What is itemised instead
is tokens, per request, including the requests that were expected to be free —
a 2xx is a billed call whatever the prediction was (pitfalls L35).

Third full harness run (`npm run live`, 22 requests):

| check | request | status | billed | in | out | reasoning | cached |
|---|---|---|---|---|---|---|---|
| A | `GET /v1/models` | 200 | yes | 0 | 0 | 0 | 0 |
| B | `POST {}` (real key) | 400 | no | 0 | 0 | 0 | 0 |
| B | `POST {}` (bogus key) | 400 | no | 0 | 0 | 0 | 0 |
| B | `POST unknown model` (real key) | 404 | no | 0 | 0 | 0 | 0 |
| B | `POST unknown model` (bogus key) | 403 | no | 0 | 0 | 0 | 0 |
| B | `GET /v1/models` (no `Authorization` header) | 401 | no | 0 | 0 | 0 | 0 |
| C | `POST` `max_tokens` + `max_completion_tokens` | 400 | no | 0 | 0 | 0 | 0 |
| C | `POST` `max_tokens: 99999999` | 400 | no | 0 | 0 | 0 | 0 |
| C | `POST` `temperature: 3` | 400 | no | 0 | 0 | 0 | 0 |
| E | `POST` `enable_thinking: false` | 200 | yes | 46 | 1 | 0 | 32 |
| E | `POST` `enable_thinking: true` | 200 | yes | 46 | 16 | 16 | 32 |
| F | pair 1: with `reasoning_content` | 200 | yes | 90 | 2 | 0 | 32 |
| F | pair 1: without | 200 | yes | 77 | 2 | 0 | 32 |
| F | pair 2: with | 200 | yes | 90 | 96 | 96 | 0 |
| F | pair 2: without | 200 | yes | 77 | 96 | 96 | 0 |
| F | pair 3: with | 200 | yes | 90 | 2 | 0 | 0 |
| F | pair 3: without | 200 | yes | 77 | 2 | 0 | 32 |
| G | tool round-trip | 200 | yes | 153 | 32 | 0 | 16 |
| H | SSE stream (recorded, replayed through pi's adapter) | 200 | yes | 46 | 2 | 0 | 32 |
| J | `POST /v1/messages` | 200 | yes | 14 | 1 | 0 | 0 |
| J | `POST /v1/responses` | 200 | yes | 46 | 1 | 1 | 32 |
| J | `POST /v1/embeddings` | 404 | no | 0 | 0 | 0 | 0 |

Totals for that run: 22 requests, 13 answered 2xx, 9 rejected pre-inference
(free); **input 852, output 253 (of which 209 reasoning), cache reads 240**.

A later run of the same harness (the one quoted in the README cost log) totalled
**output 556, of which 515 reasoning, cache reads 336** with the identical
22-request shape: the reasoning-pair rows and `enable_thinking: true` vary
because the model decides whether to think. Both runs are itemised above; the
numbers differ, the *bound* does not.

Two earlier full runs, plus the exploratory probes behind `research/raw/`, are
not itemised row by row here; they were bounded the same way (`max_tokens ≤ 16`
except the 256-token tool probe and the 96-token pairs) and their totals are of
the same order. The full set of exploratory probes is in `live/probe.ts` and can
be re-run one at a time.

## The five claims this build had to prove

### 1. `maxTokensField: "max_tokens"` — the listing's field name is not a request field

```
POST /v1/chat/completions  {"max_tokens": 8, "max_completion_tokens": 8}
-> 400 {"error":{"code":400,"type":"Bad Request",
        "message":"Invalid request: ['max_completion_tokens (8): Extra inputs are not permitted']"}}
```

Both fields together are rejected; `max_tokens` alone is honoured
(`max_tokens: 8` → `finish_reason: "length"`, and `max_tokens: 99999999` →
`400 ... less than or equal to 262144`). Free: both are pre-inference rejections.
Corroboration that this is a family property rather than an endpoint quirk: pi's
bundled `nvidia` and `openrouter` entries for the same two ids both pin
`maxTokensField: "max_tokens"` (`pi-ai/dist/providers/data/{nvidia,openrouter}.json`).

### 2. Thinking is boolean, and it goes out as `chat_template_kwargs.enable_thinking`

| request | result |
|---|---|
| no thinking field | thinking on (recon) |
| `chat_template_kwargs: {enable_thinking: false}` | `reasoning_content: null`, `reasoning_tokens: 0`, `content: "Ok."`, `finish_reason: stop` |
| `chat_template_kwargs: {enable_thinking: true}` | `reasoning_tokens: 16` of a 16-token cap, `content: null` |
| `reasoning_effort: "none"` *(no `enable_thinking`)* | thinking off — the only effort value with an observable effect; the recon measured `minimal`/`low`/`high` as non-monotonic (404/366/305 reasoning tokens), i.e. noise |
| `enable_thinking: true` + a system message + `"say ok"`, 200-token cap | **`reasoning_tokens: 0`**, `content: "ok"` |

The last row matters: **`enable_thinking: true` permits thinking, it does not
force it.** Only `false` is deterministic (0 reasoning tokens every time it was
measured). Any UI that presents the non-off levels as "more thinking" would be
promising something this provider does not do.

The vendor documents the switch verbatim: *"Poolside-hosted inference enables
thinking by default. To turn it off for a request, set
`chat_template_kwargs.enable_thinking` to `false`"*
(<https://docs.poolside.ai/api/openai-api-examples.md>, § "Turn off thinking").

Because there is no scale, the plugin exposes exactly two levels — `off` and
`low` — and everything else pi can request clamps down to `low`. Asserted on the
wire over the whole catalog × all seven levels in `test/wire-format.test.ts`.

### 3. `reasoning_content` on the second request — proved in a real agent run

The vendor requires it: *"For agentic workflows with Poolside models, preserve
`reasoning_content` from assistant responses when you include those responses in
follow-up requests. Dropping previous reasoning content can prevent the model
from reasoning in later steps."*

This build ran a real multi-turn agent run and captured the outgoing body with a
`before_provider_request` hook (a temporary extension in `/tmp`, not part of the
plugin):

```
pi -p --model poolside/poolside/laguna-s-2.1 \
   "Think it through, then use the bash tool to verify: 17*23*3."

turn 1 request:  roles [system, user]
                 chat_template_kwargs {"enable_thinking": true}, max_tokens 32768
turn 2 request:  roles [system, user, assistant, tool]
                 assistant.reasoning_content = "The user wants me to"   <-- the echo
```

and the session JSONL for the same run shows where it came from:

```
assistant kinds ['thinking','toolCall'] reasoning_tokens 29 stop toolUse
  thinkingSignature: "reasoning_content"
  thinking text: "The user wants me to calculate 17 * 23 * 3 and verify it using bash, …"
```

So the chain is verified end to end: the gateway's `reasoning_content` → pi's
thinking block (signature `reasoning_content`) → the next request's
`assistant.reasoning_content`.

**The *effect* behind the requirement did not reproduce.** The paired experiment
(same second turn, with and without the echo) was run twice:

- first attempt: 62 reasoning tokens with the echo, 0 without — a textbook
  confirmation;
- second attempt, same prompts: 25 with the echo, **96** without (the silent arm
  hit its `max_tokens` cap); the harness run reproduced `0/3` pairs in the
  documented direction.

So the field is sent because the provider documents that it must be, and because
sending it is accepted (200, always) — **not** because this build reproduced the
failure it prevents. That is stated as such in the README rather than smoothed
over. To settle it: 10+ pairs, one variable, fixed prompt, fixed cap — affordable
on a free key, and the harness is already shaped for it (`live/check.ts` check F).

### 4. The error layer: three dialects, and what the SDK really does with them

| case | status | body | bare message pi sees | with `withBodyRecovery` |
|---|---|---|---|---|
| no `Authorization` header at all | 401 | `No Authorization header provided` (text/plain) | `401 No Authorization header provided` | unchanged |
| wrong key | 403 | `{"error":"please check the api-key you provided"}` | `403 "please check the api-key you provided"` (quoted) | unquoted |
| unknown model | 404 | `{"error":"please check the model you provided"}` | `404 "please check the model you provided"` | unquoted |
| `{}` body | 400 | `{"error":"Invalid request body"}` | `400 "Invalid request body"` | unquoted |
| `max_tokens` over cap | 400 | enveloped `{code,message,type}` | `400: {"code":400,"message":"…","type":"Bad Request"}` | the message alone |
| `temperature: 3` | 400 | enveloped | as above | the message alone |
| `Authorization: Bearer ` (empty value) | **502** | HTML `<title>502 Server Error</title>` (front proxy) | the whole HTML document | one readable line |
| wrong key on `GET /models` | 403 | **no body arrives** — server resets the stream | `403 status code (no body)` | unchanged |

All rows are recorded bytes; the bare/recovered pair for every one of them is a
test in `test/errors.test.ts`.

`withBodyRecovery` is therefore justified by **measured readability**, not by a
lost body: nothing in the measured set is dropped outright (see the corrections
below). What it buys — verified, not assumed:

- the 502 HTML page becomes
  `502 502 Server Error — Error: Server Error — The server encountered a temporary error and could not complete your request. Please try again in 30 seconds.`;
- the enveloped 400s lose their raw JSON envelope;
- the string dialect loses the SDK's quotation marks, so one parser reads both.

**Validation order** (this is the trap that shapes `/login`):

| request | real key | bogus key |
|---|---|---|
| `{}` | 400 `Invalid request body` | **400 `Invalid request body`** |
| structurally valid, unknown model | 404 | **403** |
| structurally valid, `max_tokens` over cap | 400 range error | **403** |
| structurally valid, real model | 200 | **403** |

The body is parsed first, then the key, then the model id and the ranges. The
generic "POST an empty body and read a 400 as proof the key authenticated" recipe
— which the plugin skill suggests and the recon repeated — **accepts a wrong key
here**. `probeKey` sends a structurally valid request for an id that cannot exist
instead: 404 = key accepted (free), 401/403 = not. Both are pre-inference.

### 5. The catalog comes from the listing

`GET /v1/models` returns, for each of the two ids: `context_length`, 
`max_completion_tokens`, `input_modalities`, `output_modalities`,
`supported_features`, `quantization`, `hugging_face_id`, `description`,
`is_free`, and a `pricing` object whose five values are all `"0"`. The catalog is
transcribed from that body and `test/catalog.test.ts` asserts every number
against the recorded fixture, so it cannot drift silently. The same
`parseListing()` feeds the discovery overlay: a new id gets its own advertised
window, cap, modalities and features, and a frozen id is never re-described.

## Streaming usage, measured

Every content chunk carries a **cumulative** `usage` (and with
`stream_options.include_usage`, the closing delta carries none at all). The
gateway's own docs confirm it: *"Poolside-hosted inference includes a running
token usage total on every chunk and the completed total on the final chunk.
Setting `stream_options.include_usage` to `false` does not suppress these
totals."* pi-ai assigns rather than accumulates (`openai-completions.js:362`), so
the last cumulative value wins — asserted with the recorded streams in
`test/usage.test.ts` and reproduced live in `live/check.ts` check H.

Also observed, and not asked for: `prompt_tokens_details.cached_tokens` is
non-zero (32 of 46 on a repeated prompt, 7104 in a pi agent run), i.e. the
gateway has an implicit prompt cache. It is priced `0` in the listing
(`input_cache_read: "0"`), and no cache-control field is documented, so the
plugin sends none.

## Real pi runs

| what | command | result |
|---|---|---|
| install | `pi install /path/to/pi-poolside` | `Installed` |
| picker | `pi --list-models \| grep poolside` | `poolside poolside/laguna-s-2.1 262.1K 32.8K yes no` and the xs row |
| plain print | `pi -p --model poolside/poolside/laguna-xs-2.1 --thinking off "Reply with exactly: poolside ok"` | `poolside ok` |
| default thinking | same without `--thinking off` | `poolside ok` |
| agent run with tools | `pi -p --model poolside/poolside/laguna-xs-2.1 "Run the bash command: echo 21*2. Then reply with just the number."` | `42`, two requests, second one `roles [system,user,assistant,tool]` |
| reasoning echo | `pi -p --model poolside/poolside/laguna-s-2.1 "Think it through, then use the bash tool to verify: 17*23*3…"` | `1173`, turn 2 carried a non-empty `assistant.reasoning_content` |
| error path (print mode) | `POOLSIDE_API_KEY=sky_bogus… pi -p --model poolside/poolside/laguna-xs-2.1 "say ok"` | exactly one line, the clarified 403, exit code 1 |
| error path, unregistered id | `pi -p --model poolside/poolside/does-not-exist "say ok"` | pi's own warning + the clarified 404, exit code 1 |

The wire bodies in the two agent runs were captured with a temporary
`before_provider_request` hook. It confirmed for a real pi process:
`max_tokens: 32768`, `chat_template_kwargs: {enable_thinking: true}`,
`stream_options: {include_usage: true}`, and the absence of
`max_completion_tokens`, `reasoning_effort`, `reasoning`, `store` and
`prompt_cache_retention`.

## Where the recon handoff was wrong

1. **`nvidia` context window.** The handoff says pi's bundled `nvidia` entry for
   `poolside/laguna-xs-2.1` has `contextWindow: 131072` — "half the real 262144".
   In the installed pi 0.87.1 (`pi-ai/dist/providers/data/nvidia.json`) it is
   **262144** with `maxTokens: 16384` and `maxTokensField: "max_tokens"`. So pi's
   bundled numbers are not stale about the window; the handoff's claim is. (The
   installed `openrouter` entries do carry 262144 too, plus a *1 048 576* window
   for the paid `laguna-s-2.1` — larger than the direct endpoint's 262144.)
2. **"Survives the SDK? no" for three of four error rows.** Measured on pi-ai
   0.87.1: the plain-text 401 survives verbatim, and both string-`error` bodies
   survive (quoted). Only the JSON *envelope* is ugly, and the HTML 502 page is
   unreadable. Body recovery is justified — for those reasons, not for a dropped
   body.
3. **The empty-body key check.** The handoff (following the plugin skill's
   generic recipe) implies a `400` on an empty body proves the key. Measured: a
   bogus key gets the same `400 Invalid request body`. See § "Validation order".
4. **`reasoning_content` preservation as a *requirement to implement*.** The
   requirement is real and documented, and the echo is now proved — but the
   handoff's framing ("otherwise the model stops thinking on the following
   steps") was not reproducible here in either direction (§ 3).
5. **Minor**: the handoff's table lists `quantization: fp8` for both ids; the
   listing says `fp8` for `laguna-xs-2.1` and **`fp4`** for `laguna-s-2.1`.

Everything else the handoff measured was confirmed: the two ids and their
metadata, the `max_tokens` field and its 1..262144 range, the
`max_completion_tokens` rejection, `temperature` 0..2, the 401/403/404/400
dialects, thinking on by default and boolean off, the reasoning field name, the
`chat_template_kwargs` pi-internals seam, `tools/pi.md` recommending a
hand-filled `models.json` with `POOLSIDE_API_KEY`, and pi shipping poolside ids
under `nvidia`/`openrouter`.

## What was not measured

- **Any context-overflow rejection.** No oversized prompt was ever sent (that is
  the one probe that costs real money when it is *accepted*). pi 0.87.1 already
  ships a Poolside-flavoured overflow pattern
  (`utils/overflow.js:56`, `/exceeds maximum allowed input length of N tokens/`),
  so if that is the wording, compaction fires with no help from this plugin — but
  the wording is unverified. The probe: send a body ~10× over 262144 tokens and
  read the rejection; it must come back 4xx, or it was billed. There is no
  overflow rewrite in this plugin, deliberately.
- **429 / rate limits.** None observed in any run (including the bursts in the
  exploratory probes), so no 429 wording is invented for the clarification layer.
- **Cache behaviour as a feature.** `cached_tokens` was observed non-zero, but no
  cache-control field was probed and none is sent; `promptCache` is not declared,
  so pi never warms a cache.
- **`top_k` / `min_p`.** Documented in the prose of the API page (defaults 20 and
  0) but *not* in the listing's `supported_sampling_parameters`, which says
  `["temperature"]` only. Not sent, not probed.
- **The `vercel-ai-gateway` route and self-managed endpoints.** pi ships poolside
  ids under `vercel-ai-gateway` (Anthropic Messages) as well; that route and the
  self-hosted endpoint that `tools/pi.md` describes were not probed.
- **`/v1/messages` and `/v1/responses` semantics.** Both answered 200 (billed, 1
  output token each) and `usage` shapes were read for the ledger, but nothing
  further: thinking control, tool calls and streaming on those routes were not
  exercised. They are not registered by this plugin.
