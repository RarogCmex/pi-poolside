/**
 * Error-layer tests, driven by the **recorded** bodies rather than synthetic
 * ones. `test/fixtures/error-bodies.json` is generated from `research/raw/*.txt`
 * by `live/make-error-fixtures.ts`, so these tests exercise the bytes the
 * gateway actually sent — including the two shapes a synthetic fixture would
 * have hidden: the **string** `error` dialect and the HTML 502 page.
 *
 * Two layers are asserted:
 *
 *  1. **What pi would print**, by feeding each recorded body to pi-ai's real
 *     adapter through a stub `fetch` (no network, no billing). The bare and
 *     recovered columns are both asserted, because the value of
 *     `withBodyRecovery` is exactly their difference. Measured difference
 *     (2026-09-26, pi-ai 0.87.1, `openai` 6.x):
 *
 *     | fixture | bare | recovered |
 *     |---|---|---|
 *     | 401 plain text | `401 No Authorization header provided` | unchanged |
 *     | 502 HTML | the whole HTML document, newlines and all | one readable line |
 *     | 403 with no body (stream reset) | `403 status code (no body)` | unchanged |
 *     | 403/404 string `error` | `403 "please check the api-key you provided"` (quoted) | unquoted |
 *     | enveloped 400 | `400: {"code":400,"message":"…","type":"Bad Request"}` | the message alone |
 *
 *  2. **Negative safety**, against pi's *real* classifiers
 *     (`isContextOverflow`, `isRetryableAssistantError`, `getOverflowPatterns`):
 *     no clarification may turn a throttle or an auth failure into a compaction
 *     trigger, and no clarification may change whether pi retries.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { describe } from "node:test";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import {
  getOverflowPatterns,
  isContextOverflow,
  isRetryableAssistantError,
  normalizeContext,
  type AssistantMessage,
  type Model,
} from "@earendil-works/pi-ai";
import { CATALOG } from "../catalog.ts";
import {
  clarifyPoolsideError,
  extractGatewayMessage,
  htmlToText,
  isRewriteSafe,
  needsPersistentHelp,
  parseGatewayError,
  recoverErrorBody,
  shouldClarify,
  withBodyRecoveryApi,
} from "../errors.ts";
import { DEFAULT_BASE_URL, entryToModel, PROVIDER_ID } from "../models.ts";

interface RecordedBody {
  case: string;
  note: string;
  status: number;
  contentType: string | null;
  body: string | null;
  recordedFile: string;
  attempts: number;
  transportReset: boolean;
}

const fixtures = JSON.parse(
  readFileSync(new URL("./fixtures/error-bodies.json", import.meta.url), "utf8"),
) as Record<string, RecordedBody | string>;

const CASES = Object.entries(fixtures).filter(
  ([key]) => !key.startsWith("$"),
) as [string, RecordedBody][];

const model = entryToModel(CATALOG[0], DEFAULT_BASE_URL) as Model<"openai-completions">;

const context = normalizeContext({
  systemPrompt: "You are pi.",
  messages: [{ role: "user", content: "hi", timestamp: 1 }],
});

/** Feed one recorded body to pi-ai's real adapter and return what pi would print. */
async function printedByPi(fixture: RecordedBody, recover: boolean): Promise<string> {
  const api = recover ? withBodyRecoveryApi(openAICompletionsApi()) : openAICompletionsApi();
  const fetchStub = (async () => {
    const headers = new Headers();
    if (fixture.contentType) headers.set("content-type", fixture.contentType);
    const response = new Response(fixture.body ?? "", { status: fixture.status, headers });
    return recover ? recoverErrorBody(response) : response;
  }) as unknown as typeof fetch;

  const stream = api.streamSimple(model, context, {
    apiKey: "sky_test",
    fetch: fetchStub,
    // pi's own retry layer is a separate concern; keep this a single attempt so
    // the test measures the message, not the retry policy.
    maxRetries: 0,
  });

  for await (const event of stream) {
    if (event.type === "error") return (event as { error: AssistantMessage }).error.errorMessage ?? "";
    if (event.type === "done") return "<<completed without an error>>";
  }
  return "<<stream produced no terminal event>>";
}

function fixture(name: string): RecordedBody {
  const entry = fixtures[name];
  assert.ok(entry && typeof entry === "object", `${name} missing from the recorded fixtures`);
  return entry;
}

describe("what pi prints for each recorded dialect", () => {
  test("the 401 plain-text body survives the SDK as-is, and says exactly which failure it is", async () => {
    // NOTE: this contradicts the recon handoff, which listed the plain-text 401
    // as "does not survive the SDK". Measured here on pi-ai 0.87.1: the body is
    // present in the message. Recorded because a wrong claim in the research
    // note would otherwise be inherited by the next build.
    const bare = await printedByPi(fixture("no-auth-header"), false);
    assert.equal(bare, "401 No Authorization header provided");
    assert.equal(await printedByPi(fixture("no-auth-header"), true), bare);
  });

  test("the 502 HTML page is the one body recovery really rescues", async () => {
    const bare = await printedByPi(fixture("empty-bearer"), false);
    const recovered = await printedByPi(fixture("empty-bearer"), true);
    assert.ok(bare.includes("<html"), "expected pi to receive raw markup without recovery");
    assert.ok(bare.includes("\n"), "expected the multi-line markup dump");
    assert.equal(recovered, "502 502 Server Error — Error: Server Error — The server encountered a temporary error and could not complete your request. Please try again in 30 seconds.");
    assert.ok(!recovered.includes("<"), "recovered message must not contain markup");
  });

  test("the string-`error` dialect arrives, quoted, and recovery unquotes it", async () => {
    const bare = await printedByPi(fixture("bad-key-chat"), false);
    const recovered = await printedByPi(fixture("bad-key-chat"), true);
    assert.equal(bare, '403 "please check the api-key you provided"');
    assert.equal(recovered, "403 please check the api-key you provided");
    // The quoted form is what a naive regex-based clarifier fails to match; the
    // clarifier below must handle both, which is why it goes through
    // parseGatewayError rather than testing the raw string.
    assert.ok(clarifyPoolsideError(bare));
    assert.ok(clarifyPoolsideError(recovered));
  });

  test("the enveloped 400 shows raw JSON without recovery and the message with it", async () => {
    const bare = await printedByPi(fixture("max-tokens-range"), false);
    const recovered = await printedByPi(fixture("max-tokens-range"), true);
    assert.ok(bare.startsWith('400: {"code":400'), bare);
    assert.equal(
      recovered,
      "400 Invalid request: ['max_tokens (99999999): Input should be less than or equal to 262144']",
    );
  });

  test("a body that never arrived still yields a status, not a crash", async () => {
    // `GET /models` with a wrong key resets the stream (recorded, reproduced with
    // curl). Nothing can be recovered from an absent body, and the plugin must
    // not pretend otherwise.
    const entry = fixture("bad-key-listing");
    assert.equal(entry.body, null);
    assert.equal(entry.transportReset, true);
    const printed = await printedByPi(entry, true);
    assert.equal(printed, "403 status code (no body)");
  });

  test("a successful response is passed through untouched", async () => {
    const response = new Response('{"ok":true}', {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const recovered = await recoverErrorBody(response);
    assert.equal(await recovered.text(), '{"ok":true}');
    assert.equal(recovered.headers.get("content-type"), "application/json");
  });

  test("only the encoding changes; status, statusText and other headers survive", async () => {
    const response = new Response('{"error":"boom"}', {
      status: 403,
      statusText: "Forbidden",
      headers: { "content-type": "application/json", "x-request-id": "req_1" },
    });
    const recovered = await recoverErrorBody(response);
    assert.equal(recovered.status, 403);
    assert.equal(recovered.statusText, "Forbidden");
    assert.equal(recovered.headers.get("x-request-id"), "req_1");
    assert.equal(recovered.headers.get("content-type"), "text/plain; charset=utf-8");
  });

  test("a body with no words at all is left alone rather than replaced by itself", async () => {
    const response = new Response("[", { status: 500, headers: { "content-type": "application/json" } });
    const recovered = await recoverErrorBody(response);
    assert.equal(await recovered.text(), "[");
    assert.equal(recovered.headers.get("content-type"), "application/json");
  });
});

describe("parseGatewayError reads all three dialects", () => {
  test("string error", () => {
    const parsed = parseGatewayError('403 "please check the api-key you provided"');
    assert.equal(parsed.status, 403);
    assert.equal(parsed.message, "please check the api-key you provided");
  });

  test("unquoted recovered form", () => {
    const parsed = parseGatewayError("403 please check the api-key you provided");
    assert.equal(parsed.status, 403);
    assert.equal(parsed.message, "please check the api-key you provided");
  });

  test("enveloped form", () => {
    const parsed = parseGatewayError(
      '400: {"code":400,"message":"Validation: Temperature must be between 0 and 2, got 3","type":"Bad Request"}',
    );
    assert.equal(parsed.status, 400);
    assert.equal(parsed.message, "Validation: Temperature must be between 0 and 2, got 3");
  });

  test("plain text", () => {
    const parsed = parseGatewayError("401 No Authorization header provided");
    assert.equal(parsed.status, 401);
    assert.equal(parsed.message, "No Authorization header provided");
  });

  test("HTML", () => {
    const parsed = parseGatewayError(`502 ${fixture("empty-bearer").body}`);
    assert.equal(parsed.status, 502);
    assert.match(parsed.message, /502 Server Error/);
    assert.ok(!parsed.message.includes("<"));
  });

  test("an unrecognised shape is returned as-is, never invented", () => {
    const parsed = parseGatewayError("something nobody measured");
    assert.equal(parsed.status, undefined);
    assert.equal(parsed.message, "something nobody measured");
  });
});

describe("extractGatewayMessage", () => {
  test("is verbatim for every recorded body that has one", () => {
    // The extraction must not mangle what the gateway said: each recovered
    // message is asserted against the recorded bytes, so a reformatting change
    // here has to be deliberate.
    assert.equal(
      extractGatewayMessage(fixture("bad-key-chat").body!),
      "please check the api-key you provided",
    );
    assert.equal(
      extractGatewayMessage(fixture("unknown-model").body!),
      "please check the model you provided",
    );
    assert.equal(extractGatewayMessage(fixture("empty-json-body").body!), "Invalid request body");
    assert.equal(
      extractGatewayMessage(fixture("max-tokens-range").body!),
      "Invalid request: ['max_tokens (99999999): Input should be less than or equal to 262144']",
    );
    assert.equal(
      extractGatewayMessage(fixture("temperature-range").body!),
      "Validation: Temperature must be between 0 and 2, got 3",
    );
    assert.equal(extractGatewayMessage(fixture("no-auth-header").body!), "No Authorization header provided");
    assert.match(extractGatewayMessage(fixture("empty-bearer").body!)!, /^ *502 Server Error/);
  });

  test("returns undefined for a body that carries no message", () => {
    for (const body of ["", "   ", "[]", "{", "{}"]) {
      assert.equal(extractGatewayMessage(body), undefined, `body ${JSON.stringify(body)}`);
    }
  });

  test("htmlToText keeps the title and headings, deduped", () => {
    const text = htmlToText(
      "<html><head><title>502 Server Error</title></head><body><h1>Error: Server Error</h1><h2>Please try again in 30 seconds.</h2></body></html>",
    );
    assert.equal(
      text,
      "502 Server Error — Error: Server Error — Please try again in 30 seconds.",
    );
  });
});

describe("clarifyPoolsideError distinguishes the two auth failures", () => {
  test("401 is diagnosed as a MISSING header, not a wrong key", () => {
    const message = clarifyPoolsideError("401 No Authorization header provided");
    assert.ok(message);
    assert.match(message, /no API key was sent/i);
    assert.match(message, /POOLSIDE_API_KEY/);
    assert.match(message, /403/);
    assert.match(message, /^poolside: /);
  });

  test("403 is diagnosed as a WRONG key, not a missing one", () => {
    for (const raw of [
      '403 "please check the api-key you provided"',
      "403 please check the api-key you provided",
    ]) {
      const message = clarifyPoolsideError(raw);
      assert.ok(message, `no clarification for ${raw}`);
      assert.match(message, /rejected the key/i);
      assert.match(message, /403 here means \*wrong key\*/);
      assert.match(message, /Original: please check the api-key you provided/);
    }
  });

  test("404 is diagnosed as an unknown model, not an auth problem", () => {
    const message = clarifyPoolsideError('404 "please check the model you provided"');
    assert.ok(message);
    assert.match(message, /does not know that model id/);
  });

  test("the max_completion_tokens trap is named explicitly", () => {
    const message = clarifyPoolsideError(
      "400 Invalid request: ['max_completion_tokens (8): Extra inputs are not permitted']",
    );
    assert.ok(message);
    assert.match(message, /max_completion_tokens/);
    assert.match(message, /maxTokensField/);
  });

  test("the max_tokens ceiling is reported as the disclosed rejection", () => {
    const message = clarifyPoolsideError(
      "400 Invalid request: ['max_tokens (99999999): Input should be less than or equal to 262144']",
    );
    assert.ok(message);
    assert.match(message, /1\.\.262144/);
  });

  test("the empty body is explained as a body-parser rejection, not as a key check", () => {
    const message = clarifyPoolsideError("400 Invalid request body");
    assert.ok(message);
    assert.match(message, /could not parse the request body/);
    // The measured trap: this 400 arrives for a bad key too, so a tool that reads
    // it as "the key is fine" is measuring the body parser.
    assert.match(message, /before\* any auth check/);
    assert.match(message, /for a bogus one alike/);
  });

  test("the 502 proxy page is explained, with the measured trigger", () => {
    const message = clarifyPoolsideError(
      `502 502 Server Error — Error: Server Error — The server encountered a temporary error`,
    );
    assert.ok(message);
    assert.match(message, /front proxy/);
    assert.match(message, /empty/i);
  });

  test("rewrites are idempotent", () => {
    const first = clarifyPoolsideError("403 please check the api-key you provided");
    assert.ok(first);
    assert.equal(clarifyPoolsideError(first), undefined);
  });

  test("an unmeasured shape is never rewritten", () => {
    for (const raw of [
      "",
      "500 internal server error",
      "429 Too Many Requests",
      "ENOTFOUND api.poolside.ai",
      "Stream ended without finish_reason",
    ]) {
      assert.equal(clarifyPoolsideError(raw), undefined, `rewrote ${raw}`);
    }
  });

  test("the unmeasured transient 500 is not laundered into an auth message", () => {
    // The 500 `{"error":"internal server error"}` seen during this build was the
    // upstream being busy (it disappeared on retry). A rewrite that called it an
    // auth failure would have sent the user to /login for nothing.
    assert.equal(clarifyPoolsideError('500 "internal server error"'), undefined);
    assert.equal(clarifyPoolsideError("500 internal server error"), undefined);
  });
});

describe("negative safety against pi's real classifiers", () => {
  const RECORDED = CASES.map(([, entry]) => entry).filter((entry) => entry.body !== null);

  /**
   * pi's classifiers take an `AssistantMessage`, not a string, and read
   * `stopReason`/`errorMessage` from it. An earlier draft of this file called
   * them with the text and typechecked against nothing real — the shape below is
   * the one `pi-ai/utils/overflow.js` and `utils/retry.js` actually read.
   */
  function failedTurn(errorMessage: string): AssistantMessage {
    return {
      role: "assistant",
      provider: PROVIDER_ID,
      api: "openai-completions",
      model: CATALOG[0].id,
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

  test("no recorded error body is classified as a context overflow", () => {
    const patterns = getOverflowPatterns();
    assert.ok(patterns.length > 0, "pi exposed no overflow patterns to test against");
    for (const entry of RECORDED) {
      const message = failedTurn(`${403} ${entry.body}`);
      assert.equal(isContextOverflow(message), false, `${entry.case} looked like an overflow`);
    }
  });

  test("no clarification creates a new overflow signal", () => {
    for (const entry of RECORDED) {
      const printed = `${entry.status} ${entry.body}`;
      const clarified = clarifyPoolsideError(printed) ?? clarifyPoolsideError(entry.body ?? "");
      if (!clarified) continue;
      assert.equal(
        isContextOverflow(failedTurn(clarified)),
        false,
        `${entry.case} became an overflow after rewriting`,
      );
    }
  });

  test("the throttle veto holds", () => {
    // This provider never answered 429 in this build, and no 429 wording is
    // invented for it; what is asserted is that the guard would refuse to touch
    // one, so a future rewrite cannot turn a busy gateway into compaction.
    assert.equal(isRewriteSafe("429 Too Many Requests"), false);
    assert.equal(isRewriteSafe("rate limit exceeded"), false);
    assert.equal(isRewriteSafe(""), false);
    assert.equal(isRewriteSafe("403 please check the api-key you provided"), true);
  });

  test("clarifying does not change whether pi retries", () => {
    // Retryability is pi's decision, taken from its own catalog; a rewrite that
    // flipped it would either hide a transient failure or cause a retry storm.
    for (const entry of RECORDED) {
      const printed = `${entry.status} ${entry.body}`;
      const before = isRetryableAssistantError(failedTurn(printed));
      const clarified = clarifyPoolsideError(printed);
      const after = clarified
        ? isRetryableAssistantError(failedTurn(clarified))
        : before;
      assert.equal(after, before, `${entry.case}: retryability changed (${before} -> ${after})`);
    }
  });

  test("the classifiers can see an overflow when one is actually present", () => {
    // A control: without it, "no recorded body is an overflow" could be true
    // because the classifier never fires at all. pi 0.87.1 already ships a
    // Poolside-flavoured pattern (in pi-ai's `utils/overflow.js`,
    // `/exceeds maximum allowed input length of N tokens/`, contributed for the
    // OpenRouter route), so compaction would fire on that wording without any
    // rewrite from this plugin.
    const control = failedTurn("400 exceeds maximum allowed input length of 262144 tokens");
    assert.equal(isContextOverflow(control), true, "the overflow classifier is dead");
  });
});

describe("the two hook predicates", () => {
  test("shouldClarify fires only for a poolside assistant error it can improve", () => {
    const base = { role: "assistant", stopReason: "error", provider: PROVIDER_ID };
    assert.equal(shouldClarify({ ...base, errorMessage: "403 please check the api-key you provided" }), true);
    assert.equal(shouldClarify({ ...base, provider: "openai", errorMessage: "403 please check the api-key you provided" }), false);
    assert.equal(shouldClarify({ ...base, stopReason: "stop", errorMessage: "403 please check the api-key you provided" }), false);
    assert.equal(shouldClarify({ ...base, role: "user", errorMessage: "403 please check the api-key you provided" }), false);
    assert.equal(shouldClarify({ ...base, errorMessage: "500 internal server error" }), false);
    assert.equal(shouldClarify({ ...base }), false);
  });

  test("needsPersistentHelp covers exactly the states a human must act on", () => {
    for (const message of [
      "401 No Authorization header provided",
      '403 "please check the api-key you provided"',
      "403 please check the api-key you provided",
      "404 please check the model you provided",
      "poolside: the gateway rejected the key with HTTP 403 `please check the api-key you provided`",
      "502 502 Server Error — Error: Server Error — Please try again in 30 seconds.",
    ]) {
      assert.equal(needsPersistentHelp(message), true, message);
    }
    for (const message of ["", "500 internal server error", "429 Too Many Requests"]) {
      assert.equal(needsPersistentHelp(message), false, message);
    }
  });
});
