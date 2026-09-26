/**
 * Wire-format tests — the highest-value layer in a provider plugin, and the only
 * place the three central decisions of this build can be *proved* rather than
 * asserted in prose.
 *
 * These drive pi-ai's real `openai-completions` adapter (the same
 * `openAICompletionsApi()` `index.ts` registers, wrapped in the same
 * `withBodyRecoveryApi` production uses) and capture the outgoing body through
 * `onPayload`. `fetch` is a stub that records the URL and throws, so nothing
 * reaches the network and nothing is billed.
 *
 * Asserted here, over the **whole catalog × all seven levels**:
 *  1. the output cap goes out as `max_tokens`, never `max_completion_tokens`;
 *  2. thinking is expressed as `chat_template_kwargs.enable_thinking`, `false`
 *     for `off` and `true` for every other level (there is no effort scale);
 *  3. the **second** request carries `reasoning_content` on the assistant
 *     message — the provider's documented agentic requirement;
 *  4. no pi-internal level name and no unproven field ever reaches the wire.
 */

import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type { Context, Model, ThinkingLevel, Tool, TranscriptContext } from "@earendil-works/pi-ai";
import { normalizeContext, Type } from "@earendil-works/pi-ai";
import { CATALOG } from "../catalog.ts";
import { withBodyRecoveryApi } from "../errors.ts";
import { DEFAULT_BASE_URL, entryToModel, MAX_TOKENS_FIELD } from "../models.ts";

const api = withBodyRecoveryApi(openAICompletionsApi());

const LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

const weatherTool: Tool = {
  name: "get_weather",
  description: "Look up the weather for a city.",
  parameters: Type.Object({ city: Type.String({ description: "City name" }) }),
};

function model(id = "poolside/laguna-xs-2.1"): Model<"openai-completions"> {
  const entry = CATALOG.find((candidate) => candidate.id === id);
  assert.ok(entry, `${id} missing from catalog`);
  return entryToModel(entry, DEFAULT_BASE_URL) as Model<"openai-completions">;
}

/** A second-turn transcript: user → assistant (with reasoning) → user. */
function secondTurnContext(reasoningSignature = "reasoning_content"): TranscriptContext {
  return normalizeContext({
    systemPrompt: "You are pi, a coding agent.",
    messages: [
      { role: "user", content: "What is 2+2? Think it through.", timestamp: 1 },
      {
        role: "assistant",
        // A real transcript records which provider/api/model produced the turn.
        // pi-ai's `transformMessages` only keeps a signed thinking block intact
        // when `provider`/`api`/`model` match the model being called
        // (`api/transform-messages.js:70-90`); without them it downgrades the
        // block to plain text and the echo under test disappears.
        provider: "poolside",
        api: "openai-completions",
        model: "poolside/laguna-xs-2.1",
        content: [
          { type: "thinking", thinking: "Four.", thinkingSignature: reasoningSignature },
          { type: "text", text: "4" },
        ],
        timestamp: 2,
      // A real transcript always carries usage on a completed assistant turn;
      // pi-ai's context estimator reads `assistant.usage.totalTokens`
      // (`utils/estimate.js:52-63`), so a hand-built turn without it throws
      // before any payload exists.
      usage: {
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 15,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      },
      { role: "user", content: "Now 3+3?", timestamp: 3 },
    ],
  });
}

/** An assistant turn with no reasoning block at all (a tool-only or aborted turn). */
function noReasoningContext(): TranscriptContext {
  return normalizeContext({
    systemPrompt: "You are pi.",
    messages: [
      { role: "user", content: "hi", timestamp: 1 },
      {
        role: "assistant",
        provider: "poolside",
        api: "openai-completions",
        model: "poolside/laguna-xs-2.1",
        content: [{ type: "text", text: "hello" }],
        timestamp: 2,
      // A real transcript always carries usage on a completed assistant turn;
      // pi-ai's context estimator reads `assistant.usage.totalTokens`
      // (`utils/estimate.js:52-63`), so a hand-built turn without it throws
      // before any payload exists.
      usage: {
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 15,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      },
      { role: "user", content: "go on", timestamp: 3 },
    ],
  });
}

let requestedUrl: string | undefined;

interface CaptureOptions {
  reasoning?: ThinkingLevel;
  maxTokens?: number;
  tools?: Tool[];
  target?: Model<"openai-completions">;
  context?: TranscriptContext;
}

/** Run a stream to its (expected) failure and return the body it would have sent. */
async function capture(options: CaptureOptions = {}): Promise<Record<string, any>> {
  let payload: Record<string, any> | undefined;

  const stream = api.streamSimple(
    options.target ?? model(),
    options.context ?? context({ tools: options.tools }),
    {
      apiKey: "sky_test",
      reasoning: options.reasoning,
      maxTokens: options.maxTokens,
      onPayload: (body) => {
        payload = body as Record<string, any>;
      },
      fetch: ((url: any) => {
        requestedUrl = String(url);
        throw new Error("stop after payload capture");
      }) as unknown as typeof fetch,
    },
  );

  for await (const event of stream) {
    if (event.type === "error" || event.type === "done") break;
  }

  assert.ok(payload, "adapter never built a request payload");
  // pi assigns several fields the literal `undefined`, so `key in body` would lie.
  return JSON.parse(JSON.stringify(payload));
}

function context(overrides: Partial<Context> = {}): TranscriptContext {
  return normalizeContext({
    systemPrompt: "You are pi, a coding agent.",
    messages: [{ role: "user", content: "Say hi.", timestamp: Date.now() }],
    ...overrides,
  });
}

describe("request shape common to every model", () => {
  test("posts to the gateway chat-completions endpoint", async () => {
    await capture();
    assert.equal(requestedUrl, "https://inference.poolside.ai/v1/chat/completions");
  });

  test("the output cap is sent as max_tokens, from the catalog by default", async () => {
    const body = await capture({ maxTokens: 4096 });
    assert.equal(body.max_tokens, 4096);
    assert.equal("max_completion_tokens" in body, false);
  });

  test("every request carries a cap defaulted from the catalog", async () => {
    // pi-ai's `buildBaseOptions` defaults `maxTokens` to `model.maxTokens`
    // (`api/simple-options.js:10`), so the listing-sourced cap is on every wire
    // body, not only on the paths that pass one explicitly.
    const body = await capture();
    assert.equal(body.max_tokens, 32_768);
    assert.equal("max_completion_tokens" in body, false);
  });

  test("always asks for streaming usage so token accounting works", async () => {
    const body = await capture();
    assert.equal(body.stream, true);
    assert.deepEqual(body.stream_options, { include_usage: true });
  });

  test("uses the system role, never developer — even though these models reason", async () => {
    const body = await capture({ reasoning: "low" });
    assert.equal(body.messages[0].role, "system");
    assert.equal(body.messages[0].content, "You are pi, a coding agent.");
    assert.equal(body.messages.some((m: any) => m.role === "developer"), false);
  });

  test("never sends fields this API has not accepted", async () => {
    const body = await capture({ maxTokens: 1024, tools: [weatherTool] });
    for (const field of [
      "store",
      "prompt_cache_retention",
      "prompt_cache_key",
      "reasoning_effort",
      "reasoning",
      "thinking",
      "thinking_budget",
      "thinking_token_budget",
      "temperature",
      "top_p",
      "priority",
    ]) {
      assert.equal(field in body, false, `${field} should not be sent`);
    }
  });

  test("sends plain function tools without the strict flag", async () => {
    const body = await capture({ tools: [weatherTool] });
    assert.equal(body.tools.length, 1);
    const fn = body.tools[0].function;
    assert.equal(fn.name, "get_weather");
    assert.deepEqual(fn.parameters.properties.city, { type: "string", description: "City name" });
    assert.equal("strict" in fn, false);
  });
});

describe("thinking is boolean, and it is expressed in chat_template_kwargs", () => {
  test("off sends an explicit false; every other level sends an explicit true", async () => {
    for (const level of LEVELS) {
      const body = await capture({ reasoning: level });
      assert.deepEqual(
        body.chat_template_kwargs,
        { enable_thinking: level !== "off" },
        `level ${level} must mean ${level !== "off" ? "thinking on" : "thinking off"}`,
      );
    }
  });

  test("off is never clamped upward into a thinking request", async () => {
    // T1's trap: a null `off` is filtered out of the supported levels and then
    // clamps *up* to the lowest level, silently billing thinking the user asked
    // to disable. `enable_thinking:false` on the wire is the proof it did not.
    const body = await capture({ reasoning: "off" });
    assert.equal(body.chat_template_kwargs.enable_thinking, false);
  });

  test("the levels this model does not have clamp down to a real 'on'", async () => {
    // `medium`/`high`/`xhigh`/`max` are mapped to null (they do not exist for a
    // boolean model), so pi must move a request for them DOWN to `low` — the
    // single on-level — and never upward past a level it does support.
    for (const level of ["medium", "high", "xhigh", "max"] as ThinkingLevel[]) {
      const target = model();
      const { clampThinkingLevel } = await import("@earendil-works/pi-ai");
      assert.equal(clampThinkingLevel(target, level), "low", `${level} should clamp to low`);
      const body = await capture({ reasoning: level, target });
      assert.deepEqual(body.chat_template_kwargs, { enable_thinking: true });
    }
  });

  test("no pi-internal level name can leak, across the catalog × all levels", async () => {
    for (const entry of CATALOG) {
      const target = entryToModel(entry, DEFAULT_BASE_URL) as Model<"openai-completions">;
      for (const level of LEVELS) {
        const body = await capture({ reasoning: level, target });
        const bytes = JSON.stringify(body);
        for (const internal of ["minimal", "xhigh", "medium", "high", "max", "off"]) {
          assert.equal(
            bytes.includes(`"${internal}"`),
            false,
            `${entry.id} at ${level} leaked the level name ${internal}`,
          );
        }
        // The only allowed thinking-related key is the documented switch.
        assert.deepEqual(Object.keys(body.chat_template_kwargs ?? {}), ["enable_thinking"]);
      }
    }
  });

  test("no request ever carries reasoning_effort, at any level", async () => {
    for (const level of LEVELS) {
      const body = await capture({ reasoning: level });
      assert.equal("reasoning_effort" in body, false, `reasoning_effort sent at ${level}`);
      assert.equal("reasoning" in body, false, `reasoning object sent at ${level}`);
    }
  });

  test("a non-reasoning model sends no thinking field at all", async () => {
    // The listing can surface an id without `reasoning` in supported_features;
    // pi-ai only enters the chat-template branch when `model.reasoning` is set
    // (`api/openai-completions.js:645`), so such a model must send nothing.
    const base = model();
    const nonReasoning = { ...base, reasoning: false } as Model<"openai-completions">;
    for (const level of LEVELS) {
      const body = await capture({ reasoning: level, target: nonReasoning });
      assert.equal("chat_template_kwargs" in body, false, `sent at ${level}`);
    }
  });
});

describe("reasoning_content on the second request (the agentic requirement)", () => {
  test("the assistant message carries reasoning_content when pi has a thinking block", async () => {
    const body = await capture({ context: secondTurnContext() });
    const assistant = body.messages.find((m: any) => m.role === "assistant");
    assert.ok(assistant, "no assistant message on the wire");
    assert.equal(assistant.reasoning_content, "Four.");
    assert.equal(assistant.content, "4");
    // The thinking block must not also be duplicated into content.
    assert.equal(typeof assistant.content, "string");
  });

  test("an assistant message with no reasoning block still carries the field (empty)", async () => {
    // This is what the compat flag itself buys: without it the key is absent,
    // and the provider's docs say a dropped `reasoning_content` can stop the
    // model from reasoning on later steps.
    const body = await capture({ context: noReasoningContext() });
    const assistant = body.messages.find((m: any) => m.role === "assistant");
    assert.ok(assistant);
    assert.ok("reasoning_content" in assistant, "reasoning_content key missing");
    assert.equal(assistant.reasoning_content, "");
  });

  test("turning the flag off removes the key — so the test above measures the flag", async () => {
    const base = model();
    const withoutFlag = {
      ...base,
      compat: { ...base.compat, requiresReasoningContentOnAssistantMessages: false },
    } as Model<"openai-completions">;
    const body = await capture({ context: noReasoningContext(), target: withoutFlag });
    const assistant = body.messages.find((m: any) => m.role === "assistant");
    assert.ok(assistant);
    assert.equal("reasoning_content" in assistant, false);
  });

  test("a thinking block whose signature is foreign is not echoed as reasoning_content", async () => {
    // pi only echoes fields it recognises as completions reasoning fields
    // (`OPENAI_COMPLETIONS_REASONING_FIELDS`), so an Anthropic-style signature
    // must fall back to the empty-string form rather than inventing a key.
    const body = await capture({ context: secondTurnContext("anthropic-signature") });
    const assistant = body.messages.find((m: any) => m.role === "assistant");
    assert.equal(assistant.reasoning_content, "");
  });
});

describe("the compat surface is pinned, not auto-detected", () => {
  test("maxTokensField is max_tokens on every catalog model", () => {
    for (const entry of CATALOG) {
      const target = entryToModel(entry, DEFAULT_BASE_URL) as Model<"openai-completions">;
      assert.equal(target.compat?.maxTokensField, MAX_TOKENS_FIELD);
      assert.equal(target.compat?.maxTokensField, "max_tokens");
    }
  });

  test("the thinking format and its kwargs are pinned as data", async () => {
    const target = model();
    assert.equal(target.compat?.thinkingFormat, "chat-template");
    assert.deepEqual(target.compat?.chatTemplateKwargs, {
      enable_thinking: { $var: "thinking.enabled" },
    });
    assert.equal(target.reasoning, true, "the chat-template branch requires model.reasoning");
  });

  test("the flags that would add unproven fields are off", () => {
    for (const entry of CATALOG) {
      const compat = entryToModel(entry, DEFAULT_BASE_URL).compat;
      assert.equal(compat?.supportsReasoningEffort, false);
      assert.equal(compat?.supportsStore, false);
      assert.equal(compat?.supportsDeveloperRole, false);
      assert.equal(compat?.supportsLongCacheRetention, false);
      assert.equal(compat?.supportsStrictMode, false);
      assert.equal(compat?.requiresReasoningContentOnAssistantMessages, true);
    }
  });

  test("a per-model override can switch one model back to max_completion_tokens", async () => {
    // The seam exists in pi (`getCompat` resolves it per model) and is left
    // reachable: if a future id rejects `max_tokens`, one catalog entry changes.
    const base = model();
    const overridden = {
      ...base,
      compat: { ...base.compat, maxTokensField: "max_completion_tokens" as const },
    } as Model<"openai-completions">;
    const body = await capture({ target: overridden, maxTokens: 256 });
    assert.equal(body.max_completion_tokens, 256);
    assert.equal("max_tokens" in body, false);
  });
});

describe("sampling parameters", () => {
  test("no sampling parameter is sent unless a model or the caller sets one", async () => {
    const body = await capture();
    assert.equal("temperature" in body, false);
    assert.equal("top_p" in body, false);
    assert.equal("top_k" in body, false);
    assert.equal("min_p" in body, false);
  });

  test("a caller-supplied temperature is the only one that reaches the wire", async () => {
    // `temperature` is the one sampling parameter the listing advertises
    // (`supported_sampling_parameters: ["temperature"]`); `top_k`/`min_p` appear
    // in the docs but not in the listing, so the plugin sends neither — and pi
    // only sends a sampling parameter the caller or the model asked for.
    const withTemperature = await captureWithTemperature(0.2);
    assert.equal(withTemperature.temperature, 0.2);
    assert.equal("top_k" in withTemperature, false);
    assert.equal("min_p" in withTemperature, false);
  });
});

/** Capture with an explicit `temperature`, which `CaptureOptions` does not model. */
async function captureWithTemperature(temperature: number): Promise<Record<string, any>> {
  let payload: Record<string, any> | undefined;
  const stream = api.streamSimple(model(), context(), {
    apiKey: "sky_test",
    temperature,
    onPayload: (body) => {
      payload = body as Record<string, any>;
    },
    fetch: (() => {
      throw new Error("stop after payload capture");
    }) as unknown as typeof fetch,
  });
  for await (const event of stream) {
    if (event.type === "error" || event.type === "done") break;
  }
  assert.ok(payload, "adapter never built a request payload");
  return JSON.parse(JSON.stringify(payload));
}
