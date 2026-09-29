/**
 * Token accounting over the **recorded** SSE streams.
 *
 * The gateway has one accounting oddity that could break pi's numbers: **every
 * chunk carries a cumulative `usage`** (its docs say so and the recordings show
 * it), which is not the OpenAI convention — and the final chunk may carry
 * `usage: null` (with `stream_options.include_usage`) or repeat the total
 * (without it). Both recordings live in `test/fixtures/streams.json`, generated
 * from `research/raw/*.txt`.
 *
 * pi-ai *assigns* each chunk's usage instead of accumulating
 * (`output.usage = parseChunkUsage(...)` per chunk, in pi-ai's
 * `api/openai-completions.js`),
 * which is correct for a cumulative stream and wrong for a delta stream. These
 * tests pin the outcome for the recorded bytes, so a provider-side switch to
 * delta usage — or a pi-side switch to accumulation — fails here instead of
 * quietly tripling the context display.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { describe } from "node:test";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { normalizeContext, type AssistantMessage, type Model, type Usage } from "@earendil-works/pi-ai";
import { CATALOG } from "../catalog.ts";
import { DEFAULT_BASE_URL, entryToModel } from "../models.ts";

interface RecordedStream {
  case: string;
  recordedFile: string;
  sse: string;
}

const streams = JSON.parse(
  readFileSync(new URL("./fixtures/streams.json", import.meta.url), "utf8"),
) as Record<string, RecordedStream | string>;

const model = entryToModel(CATALOG[0], DEFAULT_BASE_URL) as Model<"openai-completions">;

/** Replay a recorded SSE body through pi-ai's real adapter (no network). */
async function replay(sse: string): Promise<AssistantMessage> {
  const api = openAICompletionsApi();
  const fetchStub = (async () =>
    new Response(sse, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })) as unknown as typeof fetch;

  const stream = api.streamSimple(
    model,
    normalizeContext({
      systemPrompt: "You are pi.",
      messages: [{ role: "user", content: "say ok", timestamp: 1 }],
    }),
    { apiKey: "sky_test", fetch: fetchStub, maxRetries: 0 },
  );

  let final: AssistantMessage | undefined;
  for await (const event of stream) {
    const candidate = (event as { partial?: AssistantMessage; message?: AssistantMessage; error?: AssistantMessage });
    final = candidate.error ?? candidate.message ?? candidate.partial ?? final;
  }
  assert.ok(final, "no assistant message was produced");
  return final;
}

/** The last non-null `usage` object in a recorded stream, read from the bytes. */
function lastUsageIn(sse: string): Record<string, any> {
  const chunks = sse
    .split("\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice("data: ".length)) as { usage?: Record<string, any> });
  const withUsage = chunks.filter((chunk) => chunk.usage);
  assert.ok(withUsage.length > 0, "recorded stream carries no usage at all");
  return withUsage[withUsage.length - 1].usage!;
}

function recorded(name: string): RecordedStream {
  const entry = streams[name];
  assert.ok(entry && typeof entry === "object", `${name} missing from the recorded streams`);
  return entry;
}

function usageOf(message: AssistantMessage): Usage {
  assert.ok(message.usage, "finished message has no usage");
  return message.usage;
}

describe("every chunk carrying usage does not break the totals", () => {
  test("the final counts equal the LAST cumulative usage, not the sum of the chunks", () => {
    const stream = recorded("with-include-usage");
    const expected = lastUsageIn(stream.sse);
    // The recording: chunk 1 carries completion_tokens 1, chunk 2 carries 2, and
    // the closing chunk carries `usage: null`. Accumulating would yield output 3.
    assert.equal(expected.completion_tokens, 2);
    return replay(stream.sse).then((message) => {
      const usage = usageOf(message);
      assert.equal(usage.output, expected.completion_tokens, "output must not be the chunk sum");
      assert.equal(usage.input, expected.prompt_tokens - expected.prompt_tokens_details.cached_tokens);
      assert.equal(usage.cacheRead, expected.prompt_tokens_details.cached_tokens);
      assert.equal(usage.cacheWrite, 0);
      assert.equal(usage.reasoning, 0);
      assert.equal(usage.totalTokens, usage.input + usage.output + usage.cacheRead + usage.cacheWrite);
    });
  });

  test("the closing chunk carries no usage at all and does not erase the running total", () => {
    const sse = recorded("with-include-usage").sse;
    const chunks = sse.split("\n").filter((line) => line.startsWith("data: ") && line !== "data: [DONE]");
    const closing = JSON.parse(chunks[chunks.length - 1].slice("data: ".length)) as Record<string, unknown>;
    // The recording's closing chunk is the bare `finish_reason: "stop"` delta: the
    // `usage` key is **absent**, not null. pi-ai's `if (chunk.usage)` guard
    // (`:362`) is what keeps that from zeroing the totals.
    assert.equal("usage" in closing, false, "the recording no longer ends without usage");
    return replay(sse).then((message) => {
      assert.ok(usageOf(message).totalTokens > 0, "an absent closing usage zeroed the accounting");
    });
  });

  test("usage arrives even without stream_options.include_usage", () => {
    // Documented by the provider ("Setting `stream_options.include_usage` to
    // false does not suppress these totals") and measured: the recording was
    // made with no `stream_options` at all.
    const stream = recorded("without-include-usage");
    const expected = lastUsageIn(stream.sse);
    return replay(stream.sse).then((message) => {
      const usage = usageOf(message);
      assert.equal(usage.output, expected.completion_tokens);
      assert.equal(usage.cacheRead, expected.prompt_tokens_details.cached_tokens);
      assert.equal(usage.totalTokens, 62, "the recorded final total was 62 tokens");
    });
  });

  test("the stream still finishes with a real stop reason", async () => {
    const message = await replay(recorded("with-include-usage").sse);
    assert.equal(message.stopReason, "stop");
  });

  test("no cost is charged, because the listing prices every field at zero", async () => {
    const message = await replay(recorded("without-include-usage").sse);
    assert.deepEqual(usageOf(message).cost, {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    });
  });
});

describe("the recorded stream matches what the plugin asks for", () => {
  test("the recording was made with stream: true and no forced deliberation", () => {
    // Guard against a fixture that stops describing this provider's request
    // shape: `stream` is what pi sends, and the plugin never sends
    // `reasoning_effort`, so the recording must not contain one either.
    const entry = recorded("with-include-usage");
    assert.ok(entry.sse.includes("chat.completion.chunk"));
    assert.ok(!entry.sse.includes("reasoning_content"), "the recording has thinking on");
    assert.equal(entry.recordedFile, "research/raw/stream-usage.txt");
  });
});
