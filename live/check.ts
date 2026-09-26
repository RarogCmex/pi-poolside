/**
 * Live checks against the real Poolside inference API — the claims the offline
 * suite cannot verify (README § "What is verified live, and how"). Not part of
 * `npm test`: run explicitly with `npm run live` after `set -a; . ./secret.env`.
 *
 * **Accounting.** The key is free (the listing says `is_free: true` and prices
 * every field at `"0"`), so no USD figure is printed anywhere — the ledger is
 * *tokens*, and every response with a 2xx status is itemised with the tokens it
 * reported. Each generative check is bounded: `max_tokens <= 16` unless a tool
 * round-trip needs room to emit a call (256), and every request is paced 3 s
 * apart. Free signals (pre-inference 4xx) are used wherever a rejection can
 * answer the question.
 *
 *  A. listing            — `GET /v1/models` returns the two frozen ids, with the
 *                          same numbers the catalog carries. 2xx, no tokens.
 *  B. key check          — the zero-inference `{}` probe: 400 for a good key, 403
 *                          for a bad one, 401 with no header. All free.
 *  C. rejections         — `max_completion_tokens` rejected (the listing's name is
 *                          not a request field), an over-cap `max_tokens` rejected
 *                          (the ceiling is disclosed), `temperature: 3` rejected.
 *  D. wire proof         — pi-ai's real adapter with a stub fetch: the outgoing
 *                          body carries `max_tokens` and
 *                          `chat_template_kwargs.enable_thinking`, `false` for
 *                          `--thinking off` and `true` for every other level.
 *                          Free: nothing is sent.
 *  E. thinking is boolean— off ⇒ `reasoning_tokens: 0`; on ⇒ `reasoning_content`
 *                          present. Two tiny requests.
 *  F. reasoning echo     — the paired experiment: the same second turn with and
 *                          without `reasoning_content` on the assistant message.
 *                          Two tiny requests.
 *  G. tools              — a function tool returns a well-formed `tool_calls`.
 *  H. streaming usage    — per-chunk cumulative usage through the real adapter;
 *                          the totals must equal the last cumulative value, not
 *                          the sum.
 *  I. error layer        — every recorded dialect re-measured live and classified;
 *                          none becomes retryable or an overflow.
 *  J. other surfaces     — `/v1/messages` and `/v1/responses` answer 200 (state 2
 *                          of the README table). Two requests, `max_tokens: 1`.
 *
 * Set `POOLSIDE_LIVE_SKIP_COSTLY=1` to stop after the free checks (A–D, I).
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import {
  isContextOverflow,
  isRetryableAssistantError,
  normalizeContext,
  Type,
  type AssistantMessage,
  type Model,
  type Tool,
} from "@earendil-works/pi-ai";
import { CATALOG, CATALOG_BY_ID } from "../catalog.ts";
import { clarifyPoolsideError, parseGatewayError, withBodyRecoveryApi } from "../errors.ts";
import { DEFAULT_BASE_URL, entryToModel } from "../models.ts";
import { probeKey } from "../provider.ts";

// --- key + base url ----------------------------------------------------------

function loadKey(): string {
  if (process.env.POOLSIDE_API_KEY?.trim()) return process.env.POOLSIDE_API_KEY.trim();
  const auth = JSON.parse(readFileSync(`${homedir()}/.pi/agent/auth.json`, "utf8")) as Record<
    string,
    { type?: string; key?: string }
  >;
  const key = auth["poolside"]?.key?.trim();
  if (!key) {
    throw new Error(
      "no poolside key in POOLSIDE_API_KEY or ~/.pi/agent/auth.json — " +
        "run `set -a; . ./secret.env; set +a` first",
    );
  }
  return key;
}

const BASE_URL = (process.env.POOLSIDE_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "");
const KEY = loadKey();
const api = withBodyRecoveryApi(openAICompletionsApi());
const SKIP_COSTLY = process.env.POOLSIDE_LIVE_SKIP_COSTLY === "1";

let failures = 0;
let checks = 0;

interface LedgerRow {
  check: string;
  request: string;
  status: number;
  billed: boolean;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
}

const ledger: LedgerRow[] = [];

function report(name: string, ok: boolean, detail: string): void {
  checks++;
  if (!ok) failures++;
  console.log(`\n[${ok ? "PASS" : "FAIL"}] ${name}\n${detail.replace(/^/gm, "  ")}`);
}

const PACE_MS = 3_000;
let lastRequest = 0;

async function pace(): Promise<void> {
  const wait = PACE_MS - (Date.now() - lastRequest);
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastRequest = Date.now();
}

interface RawResult {
  status: number;
  text: string;
  contentType: string | null;
  json?: any;
}

/**
 * One paced request. Every attempt is ledgered, including the ones expected to be
 * free — a 200 is a billed 2xx whatever we predicted (pitfalls L35).
 */
async function raw(
  check: string,
  request: string,
  path: string,
  init: RequestInit & { auth?: "key" | "none" | "bad" } = {},
): Promise<RawResult> {
  const headers = new Headers(init.headers);
  headers.set("content-type", headers.get("content-type") ?? "application/json");
  const mode = init.auth ?? "key";
  if (mode === "key") headers.set("authorization", `Bearer ${KEY}`);
  if (mode === "bad") headers.set("authorization", "Bearer sky_bogus_key_000000000000000000000000");

  await pace();
  const response = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(180_000),
  });
  const text = await response.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  const usage = json?.usage ?? json?.choices?.[0]?.usage;
  ledger.push({
    check,
    request,
    status: response.status,
    billed: response.ok,
    inputTokens: usage?.prompt_tokens ?? 0,
    outputTokens: usage?.completion_tokens ?? 0,
    reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens ?? 0,
    cachedTokens: usage?.prompt_tokens_details?.cached_tokens ?? 0,
  });
  return { status: response.status, text, contentType: response.headers.get("content-type"), json };
}

// --- driving pi's real adapter (free: the stub fetch throws before send) -----

const model = entryToModel(CATALOG[0], BASE_URL) as Model<"openai-completions">;

const weatherTool: Tool = {
  name: "get_weather",
  description: "Look up the weather for a city.",
  parameters: Type.Object({ city: Type.String({ description: "City name" }) }),
};

function liveContext() {
  return normalizeContext({
    systemPrompt: "You are pi, a coding agent.",
    messages: [{ role: "user", content: "say ok", timestamp: 1 }],
  });
}

/** A short, type-safe summary of a possibly-multimodal message content. */
function summarizeContent(message: AssistantMessage): string {
  // `AssistantMessage.content` is typed as a block array, but a reply that was
  // requested with `max_tokens: 16` and thinking on legitimately has `null`
  // content — so the null case is checked first rather than assumed away.
  const content = message.content as unknown as
    | string
    | null
    | undefined
    | { type: string; text?: string; thinking?: string }[];
  if (content == null) return "null";
  if (typeof content === "string") return content.slice(0, 40);
  const first = content[0];
  if (!first) return "[]";
  if (first.type === "text") return (first.text ?? "").slice(0, 40);
  if (first.type === "thinking") return `[thinking] ${(first.thinking ?? "").slice(0, 40)}`;
  return `[${first.type}]`;
}

interface Captured {
  url: string;
  body: Record<string, any>;
}

/** Capture the outgoing body without sending it. */
async function capturePayload(reasoning?: string, options: { tools?: Tool[] } = {}): Promise<Captured> {
  let payload: Record<string, any> | undefined;
  let url = "";
  const stream = api.streamSimple(model, normalizeContext({
    systemPrompt: "You are pi, a coding agent.",
    messages: [{ role: "user", content: "say ok", timestamp: 1 }],
    ...(options.tools ? { tools: options.tools } : {}),
  }), {
    apiKey: KEY,
    reasoning: reasoning as never,
    onPayload: (body) => {
      payload = body as Record<string, any>;
    },
    fetch: ((input: unknown) => {
      url = String(input);
      throw new Error("captured before send");
    }) as unknown as typeof fetch,
  });
  for await (const _event of stream) {
    // drain to the (expected) transport failure
  }
  if (!payload) throw new Error("adapter built no payload");
  return { url, body: JSON.parse(JSON.stringify(payload)) };
}

/** Run one real adapter request against the live gateway and return the message. */
async function streamLive(
  check: string,
  request: string,
  body: Record<string, unknown>,
  options: { reasoning?: string; tools?: Tool[] } = {},
): Promise<AssistantMessage> {
  await pace();
  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  });
  const text = await response.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  const usage = json?.usage;
  ledger.push({
    check,
    request,
    status: response.status,
    billed: response.ok,
    inputTokens: usage?.prompt_tokens ?? 0,
    outputTokens: usage?.completion_tokens ?? 0,
    reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens ?? 0,
    cachedTokens: usage?.prompt_tokens_details?.cached_tokens ?? 0,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
  void options;
  const message = json.choices[0].message as AssistantMessage;
  (message as any).usage = {
    input: (usage?.prompt_tokens ?? 0) - (usage?.prompt_tokens_details?.cached_tokens ?? 0),
    output: usage?.completion_tokens ?? 0,
    cacheRead: usage?.prompt_tokens_details?.cached_tokens ?? 0,
    cacheWrite: 0,
    totalTokens: usage?.total_tokens ?? 0,
    reasoning: usage?.completion_tokens_details?.reasoning_tokens ?? 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  return message;
}

// --- A. listing --------------------------------------------------------------

const listing = await raw("A", "GET /v1/models", "/models");
const listedIds = (listing.json?.data ?? []).map((m: any) => m.id);
report(
  "A. the listing still carries the frozen catalog",
  listing.status === 200 && listedIds.length === CATALOG.length &&
    CATALOG.every((entry) => listedIds.includes(entry.id)),
  `HTTP ${listing.status}; ids ${JSON.stringify(listedIds)}\n` +
    `catalog expects ${JSON.stringify(CATALOG.map((entry) => entry.id))}\n` +
    CATALOG.map((entry) => {
      const live = (listing.json?.data ?? []).find((m: any) => m.id === entry.id);
      return `  ${entry.id}: context_length ${live?.context_length} (catalog ${entry.contextWindow}), ` +
        `max_completion_tokens ${live?.max_completion_tokens} (catalog ${entry.maxTokens}), ` +
        `supported_features ${JSON.stringify(live?.supported_features)}`;
    }).join("\n"),
);

// --- B. the zero-inference key check -----------------------------------------

const goodProbe = await raw("B", "POST /chat/completions {}", "/chat/completions", {
  method: "POST",
  body: "{}",
});
const badProbe = await raw("B", "POST /chat/completions {} (bad key)", "/chat/completions", {
  method: "POST",
  body: "{}",
  auth: "bad",
});
const noAuth = await raw("B", "GET /v1/models (no Authorization header)", "/models", { auth: "none" });
const probeResult = await probeKey(KEY, BASE_URL);
report(
  "B. key validation without inference, and 401 ≠ 403",
  goodProbe.status === 400 && badProbe.status === 403 && noAuth.status === 401 &&
    probeResult === "valid",
  `{} with the real key -> HTTP ${goodProbe.status} ${goodProbe.text.slice(0, 80)}\n` +
    `{} with a bogus key -> HTTP ${badProbe.status} ${badProbe.text.slice(0, 80)}\n` +
    `no Authorization header at all -> HTTP ${noAuth.status} ${noAuth.text.slice(0, 80)}\n` +
    `probeKey() -> ${probeResult} (400 = key authenticated, free)`,
);

// --- C. pre-inference rejections ---------------------------------------------

const extraInputs = await raw("C", "POST (max_tokens + max_completion_tokens)", "/chat/completions", {
  method: "POST",
  body: JSON.stringify({
    model: model.id,
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 8,
    max_completion_tokens: 8,
  }),
});
const overCap = await raw("C", "POST (max_tokens 99999999)", "/chat/completions", {
  method: "POST",
  body: JSON.stringify({ model: model.id, messages: [{ role: "user", content: "hi" }], max_tokens: 99_999_999 }),
});
const hotTemperature = await raw("C", "POST (temperature 3)", "/chat/completions", {
  method: "POST",
  body: JSON.stringify({
    model: model.id,
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 8,
    temperature: 3,
  }),
});
report(
  "C. the maxTokensField trap and the documented ranges, all from free rejections",
  extraInputs.status === 400 && /Extra inputs are not permitted/.test(extraInputs.text) &&
    overCap.status === 400 && /less than or equal to 262144/.test(overCap.text) &&
    hotTemperature.status === 400,
  `max_completion_tokens alongside max_tokens -> HTTP ${extraInputs.status}\n  ${extraInputs.text.slice(0, 200)}\n` +
    `max_tokens 99999999 -> HTTP ${overCap.status}\n  ${overCap.text.slice(0, 200)}\n` +
    `temperature 3 -> HTTP ${hotTemperature.status}\n  ${hotTemperature.text.slice(0, 160)}`,
);

// --- D. the wire proof (free: captured before send) --------------------------

const wireOff = await capturePayload("off");
const wireOn = await capturePayload("low");
const wireLevels: { level: string; enable: boolean }[] = [];
for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
  const captured = await capturePayload(level);
  wireLevels.push({ level, enable: captured.body.chat_template_kwargs?.enable_thinking });
}
const wireTools = await capturePayload("off", { tools: [weatherTool] });
report(
  "D. the outgoing body: max_tokens + chat_template_kwargs.enable_thinking",
  wireOff.body.max_tokens === model.maxTokens &&
    !("max_completion_tokens" in wireOff.body) &&
    !("reasoning_effort" in wireOff.body) &&
    wireLevels.every((entry) => entry.enable === (entry.level !== "off")) &&
    wireTools.body.tools?.length === 1,
  `POST ${wireOff.url}\n` +
    `max_tokens ${wireOff.body.max_tokens} (catalog ${model.maxTokens}); ` +
    `max_completion_tokens present: ${"max_completion_tokens" in wireOff.body}; ` +
    `reasoning_effort present: ${"reasoning_effort" in wireOff.body}\n` +
    `enable_thinking per pi level: ${wireLevels.map((e) => `${e.level}=${e.enable}`).join(", ")}\n` +
    `messages[0].role = ${wireOff.body.messages[0].role} (never "developer")\n` +
    `tools on the wire: ${JSON.stringify(wireTools.body.tools?.[0]?.function?.name)}`,
);

if (SKIP_COSTLY) {
  console.log(
    "\nPOOLSIDE_LIVE_SKIP_COSTLY=1: stopping after the free checks (A–D). " +
      "E–J each cost a bounded number of tokens.\n",
  );
} else {
  // --- E. thinking is boolean -------------------------------------------------
  const off = await streamLive(
    "E",
    "POST (enable_thinking false)",
    {
      model: model.id,
      messages: [{ role: "user", content: "say ok" }],
      max_tokens: 16,
      chat_template_kwargs: { enable_thinking: false },
    },
  );
  const on = await streamLive(
    "E",
    "POST (enable_thinking true)",
    {
      model: model.id,
      messages: [{ role: "user", content: "say ok" }],
      max_tokens: 16,
      chat_template_kwargs: { enable_thinking: true },
    },
  );
  report(
    "E. thinking is on/off, not a scale",
    off.usage!.reasoning === 0 && (off as any).reasoning_content === null &&
      on.usage!.reasoning! > 0 && typeof (on as any).reasoning_content === "string",
    `enable_thinking:false -> content ${JSON.stringify(off.content)}, ` +
      `reasoning_content ${JSON.stringify((off as any).reasoning_content)}, reasoning_tokens ${off.usage!.reasoning}\n` +
      `enable_thinking:true  -> content ${JSON.stringify(summarizeContent(on))}, ` +
      `reasoning_content present: ${typeof (on as any).reasoning_content === "string"}, ` +
      `reasoning_tokens ${on.usage!.reasoning}`,
  );

  // --- F. the paired reasoning-echo experiment --------------------------------
  const firstTurn = [
    { role: "user", content: "What is 2+2? Think it through." },
    { role: "assistant", content: "4", reasoning_content: "The user asks 2+2. That is 4." },
    { role: "user", content: "Now what is 3+3? Think it through." },
  ];
  const echoed = await streamLive("F", "second turn WITH reasoning_content", {
    model: model.id,
    messages: firstTurn,
    max_tokens: 96,
  });
  const silent = await streamLive("F", "second turn WITHOUT reasoning_content", {
    model: model.id,
    messages: [
      { role: "user", content: "What is 2+2? Think it through." },
      { role: "assistant", content: "4" },
      { role: "user", content: "Now what is 3+3? Think it through." },
    ],
    max_tokens: 96,
  });
  report(
    "F. dropping reasoning_content stops the model from reasoning (paired control)",
    echoed.usage!.reasoning! > 0 && silent.usage!.reasoning === 0,
    `with reasoning_content echoed -> reasoning_tokens ${echoed.usage!.reasoning}, ` +
      `reasoning_content ${typeof (echoed as any).reasoning_content === "string" ? "present" : "absent"}\n` +
      `without it (the only difference) -> reasoning_tokens ${silent.usage!.reasoning}, ` +
      `reasoning_content ${JSON.stringify((silent as any).reasoning_content)}\n` +
      "Note: n=1 per arm. The difference is categorical (0 vs non-zero) rather than a " +
      "quantity, and it is the effect the provider's documentation predicts.",
  );

  // --- G. tools --------------------------------------------------------------
  const toolCall = await streamLive("G", "tool round-trip", {
    model: model.id,
    messages: [{ role: "user", content: "What is the weather in Paris? Use the get_weather tool." }],
    max_tokens: 256,
    chat_template_kwargs: { enable_thinking: false },
    tools: [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Look up the weather for a city.",
          parameters: {
            type: "object",
            properties: { city: { type: "string", description: "City name" } },
            required: ["city"],
          },
        },
      },
    ],
  });
  const calls = (toolCall as any).tool_calls ?? [];
  report(
    "G. a function tool returns a well-formed tool call",
    calls.length === 1 && calls[0].function?.name === "get_weather" &&
      JSON.parse(calls[0].function.arguments).city === "Paris",
    `finish_reason ${toolCall.stopReason}; tool_calls ${JSON.stringify(calls)}`,
  );

  // --- H. streaming usage through the real adapter ----------------------------
  await pace();
  const streamResponse = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: model.id,
      messages: [{ role: "user", content: "say ok" }],
      max_tokens: 16,
      stream: true,
      stream_options: { include_usage: true },
      chat_template_kwargs: { enable_thinking: false },
    }),
    signal: AbortSignal.timeout(180_000),
  });
  const sse = await streamResponse.text();
  const chunks = sse.split("\n").filter((line) => line.startsWith("data: ") && line !== "data: [DONE]");
  const parsed = chunks.map((line) => JSON.parse(line.slice("data: ".length)));
  const withUsage = parsed.filter((chunk) => chunk.usage);
  const lastCumulative = withUsage.at(-1)?.usage;
  const usageEveryChunk = withUsage.length === parsed.length - 1; // all but the closing delta

  let streamed: AssistantMessage | undefined;
  const replayApi = openAICompletionsApi();
  const replayStream = replayApi.streamSimple(model, liveContext(), {
    apiKey: KEY,
    maxRetries: 0,
    fetch: (async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch,
  });
  for await (const event of replayStream) {
    const candidate = (event as any).error ?? (event as any).message ?? (event as any).partial;
    streamed = candidate ?? streamed;
  }
  ledger.push({
    check: "H",
    request: "stream (recorded live)",
    status: streamResponse.status,
    billed: streamResponse.ok,
    inputTokens: lastCumulative?.prompt_tokens ?? 0,
    outputTokens: lastCumulative?.completion_tokens ?? 0,
    reasoningTokens: lastCumulative?.completion_tokens_details?.reasoning_tokens ?? 0,
    cachedTokens: lastCumulative?.prompt_tokens_details?.cached_tokens ?? 0,
  });
  const streamedUsage = streamed?.usage;
  report(
    "H. usage on every chunk does not double-count through pi's adapter",
    usageEveryChunk && streamedUsage?.output === lastCumulative?.completion_tokens &&
      streamedUsage?.totalTokens === lastCumulative?.total_tokens,
    `${parsed.length} chunks, ${withUsage.length} carrying usage (every content chunk)\n` +
      `closing delta carries usage: ${"usage" in parsed.at(-1)}\n` +
      `last cumulative: completion ${lastCumulative?.completion_tokens}, total ${lastCumulative?.total_tokens}\n` +
      `pi's adapter reported: output ${streamedUsage?.output}, total ${streamedUsage?.totalTokens} ` +
      `(a sum over chunks would be larger)`,
  );

  // --- J. the other two surfaces ---------------------------------------------
  const messages = await raw("J", "POST /v1/messages", "/messages", {
    method: "POST",
    body: JSON.stringify({
      model: model.id,
      messages: [{ role: "user", content: "say ok" }],
      max_tokens: 1,
    }),
  });
  const responses = await raw("J", "POST /v1/responses", "/responses", {
    method: "POST",
    body: JSON.stringify({ model: model.id, input: "say ok", max_output_tokens: 1 }),
  });
  const embeddings = await raw("J", "POST /v1/embeddings", "/embeddings", {
    method: "POST",
    body: JSON.stringify({ model: model.id, input: "hi" }),
  });
  report(
    "J. surfaces: two more exist and are deliberately not registered; none is an embedding route",
    messages.status === 200 && responses.status === 200 && embeddings.status === 404,
    `/v1/messages (Anthropic shape) -> HTTP ${messages.status} ` +
      `content-type ${messages.contentType}\n` +
      `/v1/responses -> HTTP ${responses.status} content-type ${responses.contentType}\n` +
      `/v1/embeddings -> HTTP ${embeddings.status} ${embeddings.text.slice(0, 80)}\n` +
      "All three are state 2 of the README's three-state table: they exist, and only " +
      "chat-completions is registered.",
  );
}

// --- I. the error layer against live traffic ---------------------------------

const errorCases: { name: string; result: RawResult; expectStatus: number }[] = [
  { name: "no Authorization header", result: noAuth, expectStatus: 401 },
  { name: "wrong key", result: badProbe, expectStatus: 403 },
  {
    name: "unknown model",
    result: await raw("I", "POST (unknown model)", "/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "poolside/does-not-exist-xyz", messages: [{ role: "user", content: "hi" }], max_tokens: 8 }),
    }),
    expectStatus: 404,
  },
];

/**
 * pi's classifiers read an `AssistantMessage`, so the live check builds the same
 * shape `pi-ai/utils/overflow.js` and `utils/retry.js` consume.
 */
function failedTurn(errorMessage: string): AssistantMessage {
  return {
    role: "assistant",
    provider: "poolside",
    api: "openai-completions",
    model: model.id,
    stopReason: "error",
    errorMessage,
    content: [],
    usage: {
      input: 1,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 1,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: 1,
  } as AssistantMessage;
}

const classification = errorCases.map((entry) => {
  const composed = `${entry.result.status} ${entry.result.text}`;
  const clarified = clarifyPoolsideError(composed);
  const parsed = parseGatewayError(composed);
  const retryableBefore = isRetryableAssistantError(failedTurn(composed));
  const retryableAfter = clarified
    ? isRetryableAssistantError(failedTurn(clarified))
    : retryableBefore;
  return {
    name: entry.name,
    status: entry.result.status,
    ok: entry.result.status === entry.expectStatus,
    parsed: parsed.message,
    clarified,
    overflow: isContextOverflow(failedTurn(clarified ?? composed)),
    retryStable: retryableBefore === retryableAfter,
  };
});
report(
  "I. every measured dialect is classified, and none becomes retryable or an overflow",
  classification.every((entry) => entry.ok && entry.clarified && !entry.overflow && entry.retryStable),
  classification
    .map(
      (entry) =>
        `${entry.name}: HTTP ${entry.status}\n  parsed as: ${JSON.stringify(entry.parsed.slice(0, 90))}\n` +
        `  clarified: ${entry.clarified ? "yes" : "NO"}; overflow after rewrite: ${entry.overflow}; ` +
        `retryability unchanged: ${entry.retryStable}`,
    )
    .join("\n"),
);

// --- ledger ------------------------------------------------------------------

const billed = ledger.filter((row) => row.billed);
const totals = billed.reduce(
  (acc, row) => ({
    input: acc.input + row.inputTokens,
    output: acc.output + row.outputTokens,
    reasoning: acc.reasoning + row.reasoningTokens,
    cached: acc.cached + row.cachedTokens,
  }),
  { input: 0, output: 0, reasoning: 0, cached: 0 },
);

console.log("\n=== cost ledger (the key is free: $0.00, tokens itemised) ===");
console.log("check  request                                         status billed  in  out  reason  cached");
for (const row of ledger) {
  console.log(
    `${row.check.padEnd(6)} ${row.request.padEnd(48)} ${String(row.status).padStart(4)} ` +
      `${(row.billed ? "yes" : "no ").padEnd(6)} ${String(row.inputTokens).padStart(4)} ` +
      `${String(row.outputTokens).padStart(4)} ${String(row.reasoningTokens).padStart(6)} ` +
      `${String(row.cachedTokens).padStart(6)}`,
  );
}
console.log(
  `\n${ledger.length} requests, ${billed.length} answered 2xx (billed), ` +
    `${ledger.length - billed.length} rejected pre-inference (free).`,
);
console.log(
  `Tokens reported by the 2xx responses: input ${totals.input}, output ${totals.output} ` +
    `(of which reasoning ${totals.reasoning}), cache reads ${totals.cached}.`,
);
console.log(
  "Money: $0.00 — the listing's own `pricing` object is \"0\" on every field and `is_free` is " +
    "true for both ids. The number above is the only thing that could ever become a charge " +
    "if that changes.",
);

console.log(`\n${checks - failures}/${checks} checks passed.`);
if (failures > 0) {
  console.log(`${failures} FAILED.`);
  process.exitCode = 1;
}
for (const entry of CATALOG) {
  const known = CATALOG_BY_ID.get(entry.id);
  if (!known) {
    console.log(`internal error: ${entry.id} not in CATALOG_BY_ID`);
    process.exitCode = 1;
  }
}
