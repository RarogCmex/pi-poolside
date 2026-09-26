/**
 * Fake-pi entry test: import the real extension default export with a stubbed
 * `ExtensionAPI`, assert the wiring, then drive both hooks with the message
 * shapes pi passes them. The preload aliases "@earendil-works/pi-ai" to the
 * compat entrypoint, which is what makes `index.ts` importable outside pi.
 *
 * The print-mode case matters more than it looks: an entry appended *after* the
 * errored assistant message makes `pi -p` print nothing at all, which is why the
 * `turn_end` handler is gated on `ctx.hasUI`.
 */

import assert from "node:assert/strict";
import test, { beforeEach, describe } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import poolsideExtension from "../index.ts";
import { PROVIDER_ID } from "../models.ts";

/**
 * Env coupling guard: the wiring must look the same whether or not the caller has
 * exported POOLSIDE_* (the live path sources `secret.env`), so ambient provider
 * variables are removed before every test here.
 */
beforeEach(() => {
  delete process.env.POOLSIDE_API_KEY;
  delete process.env.POOLSIDE_BASE_URL;
});

type Handler = (event: any, context?: any) => any;

function fakePi(): { pi: ExtensionAPI; handlers: Map<string, Handler[]>; providers: any[] } {
  const handlers = new Map<string, Handler[]>();
  const providers: any[] = [];
  const pi = {
    on: (event: string, handler: Handler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {};
    },
    registerProvider: (provider: any) => {
      providers.push(provider);
    },
    registerCommand: () => {},
  } as unknown as ExtensionAPI;
  return { pi, handlers, providers };
}

function run(handlers: Map<string, Handler[]>, event: string, payload: any, context?: any): any {
  let result: any;
  for (const handler of handlers.get(event) ?? []) result = handler(payload, context);
  return result;
}

function assistantMessage(overrides: Record<string, any> = {}): Record<string, any> {
  return { role: "assistant", provider: PROVIDER_ID, stopReason: "stop", content: [], ...overrides };
}

describe("extension wiring", () => {
  test("registers the poolside provider with both listing models", () => {
    const { pi, providers } = fakePi();
    poolsideExtension(pi);
    assert.equal(providers.length, 1);
    assert.equal(providers[0].id, PROVIDER_ID);
    assert.equal(providers[0].name, "Poolside");
    assert.equal(providers[0].baseUrl, "https://inference.poolside.ai/v1");
    assert.deepEqual(
      providers[0].getModels().map((model: { id: string }) => model.id),
      ["poolside/laguna-xs-2.1", "poolside/laguna-s-2.1"],
    );
    // `createProvider` publishes the overlay as `refreshModels`, not
    // `fetchModels`: pi restores the persisted overlay and calls the network
    // refresh through this one function.
    assert.equal(typeof providers[0].refreshModels, "function");
  });

  test("installs exactly the two error hooks and nothing else", () => {
    const { pi, handlers } = fakePi();
    poolsideExtension(pi);
    assert.deepEqual([...handlers.keys()].sort(), ["message_end", "turn_end"]);
  });
});

describe("message_end", () => {
  test("explains a 403 as a wrong key, not a missing one", () => {
    const { pi, handlers } = fakePi();
    poolsideExtension(pi);
    const result = run(handlers, "message_end", {
      message: assistantMessage({
        stopReason: "error",
        errorMessage: "403 please check the api-key you provided",
      }),
    });
    assert.match(result.message.errorMessage, /^poolside: /);
    assert.match(result.message.errorMessage, /wrong key/i);
    assert.match(result.message.errorMessage, /POOLSIDE_API_KEY/);
  });

  test("explains a 401 as a missing header", () => {
    const { pi, handlers } = fakePi();
    poolsideExtension(pi);
    const result = run(handlers, "message_end", {
      message: assistantMessage({
        stopReason: "error",
        errorMessage: "401 No Authorization header provided",
      }),
    });
    assert.match(result.message.errorMessage, /no API key was sent/i);
  });

  test("explains the 502 proxy page", () => {
    const { pi, handlers } = fakePi();
    poolsideExtension(pi);
    const result = run(handlers, "message_end", {
      message: assistantMessage({
        stopReason: "error",
        errorMessage:
          "502 502 Server Error — Error: Server Error — The server encountered a temporary error",
      }),
    });
    assert.match(result.message.errorMessage, /front proxy/);
  });

  test("leaves a foreign provider's error alone", () => {
    const { pi, handlers } = fakePi();
    poolsideExtension(pi);
    assert.equal(
      run(handlers, "message_end", {
        message: assistantMessage({
          provider: "openai",
          stopReason: "error",
          errorMessage: "403 please check the api-key you provided",
        }),
      }),
      undefined,
    );
  });

  test("leaves an unmeasured failure alone rather than inventing a cause", () => {
    const { pi, handlers } = fakePi();
    poolsideExtension(pi);
    assert.equal(
      run(handlers, "message_end", {
        message: assistantMessage({ stopReason: "error", errorMessage: "500 internal server error" }),
      }),
      undefined,
    );
  });

  test("does not touch a successful message", () => {
    const { pi, handlers } = fakePi();
    poolsideExtension(pi);
    assert.equal(
      run(handlers, "message_end", {
        message: assistantMessage({ errorMessage: "403 please check the api-key you provided" }),
      }),
      undefined,
    );
  });

  test("preserves the rest of the message while replacing the error text", () => {
    const { pi, handlers } = fakePi();
    poolsideExtension(pi);
    const original = assistantMessage({
      stopReason: "error",
      errorMessage: "403 please check the api-key you provided",
      usage: { input: 3, output: 0 },
    });
    const result = run(handlers, "message_end", { message: original });
    assert.equal(result.message.usage, original.usage);
    assert.equal(result.message.role, "assistant");
    assert.notEqual(result.message, original, "the returned message must be a new object");
  });
});

describe("turn_end", () => {
  const context = { hasUI: true };

  test("adds one persistent note for an auth failure in the TUI", () => {
    const { pi, handlers } = fakePi();
    poolsideExtension(pi);
    const result = run(
      handlers,
      "turn_end",
      {
        outcome: "error",
        entries: [],
        message: assistantMessage({
          stopReason: "error",
          errorMessage:
            "poolside: the gateway rejected the key with HTTP 403 `please check the api-key you provided`",
        }),
      },
      context,
    );
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0].customType, "poolside-help");
    assert.equal(result.entries[0].display, true);
    assert.match(result.entries[0].content, /401 `No Authorization header provided`/);
    assert.match(result.entries[0].content, /403 `please check the api-key you provided`/);
  });

  test("adds nothing in print mode, so `pi -p` still prints the error", () => {
    const { pi, handlers } = fakePi();
    poolsideExtension(pi);
    assert.equal(
      run(
        handlers,
        "turn_end",
        {
          outcome: "error",
          entries: [],
          message: assistantMessage({
            stopReason: "error",
            errorMessage: "401 No Authorization header provided",
          }),
        },
        { hasUI: false },
      ),
      undefined,
    );
  });

  test("does not duplicate a note that is already there", () => {
    const { pi, handlers } = fakePi();
    poolsideExtension(pi);
    assert.equal(
      run(
        handlers,
        "turn_end",
        {
          outcome: "error",
          entries: [{ type: "custom_message", customType: "poolside-help", content: "x" }],
          message: assistantMessage({
            stopReason: "error",
            errorMessage: "401 No Authorization header provided",
          }),
        },
        context,
      ),
      undefined,
    );
  });

  test("adds nothing for a successful turn or an unrelated error", () => {
    const { pi, handlers } = fakePi();
    poolsideExtension(pi);
    assert.equal(
      run(handlers, "turn_end", { outcome: "success", entries: [], message: assistantMessage() }, context),
      undefined,
    );
    assert.equal(
      run(
        handlers,
        "turn_end",
        {
          outcome: "error",
          entries: [],
          message: assistantMessage({ stopReason: "error", errorMessage: "500 internal server error" }),
        },
        context,
      ),
      undefined,
    );
  });
});
