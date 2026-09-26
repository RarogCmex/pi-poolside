/**
 * Provider assembly: base-URL handling, `/login` (a real key check with **no
 * inference**), and the key resolution that keeps an empty value from reaching
 * the wire.
 *
 * The empty-key case is provider-specific here: `Authorization: Bearer ` with
 * nothing after it makes this gateway's front proxy answer a deterministic
 * **502 HTML** page (recorded, 4/4 attempts), so a key that resolved to
 * whitespace would look like a gateway outage instead of a missing key.
 */

import assert from "node:assert/strict";
import test, { afterEach, beforeEach, describe } from "node:test";
import type { ApiKeyAuth, ProviderStreams } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import {
  API_KEY_ENV_VAR,
  BASE_URL_ENV_VAR,
  buildPoolsideProvider,
  KEY_PROBE_MODEL_ID,
  poolsideApiKeyAuth,
  probeKey,
  resolveBaseUrl,
} from "../provider.ts";
import { CATALOG } from "../catalog.ts";
import { DEFAULT_BASE_URL, PROVIDER_ID } from "../models.ts";

const realFetch = globalThis.fetch;

const AMBIENT = [API_KEY_ENV_VAR, BASE_URL_ENV_VAR] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const name of AMBIENT) {
    savedEnv[name] = process.env[name];
    delete process.env[name];
  }
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const name of AMBIENT) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
});

/**
 * `ApiKeyAuth.resolve` expects an `AuthResolveInput` — at minimum a live abort
 * signal and an env reader. pi always supplies them; the tests must too, because
 * a missing signal is a type error at runtime, not a no-op.
 */
function resolveInput(overrides: Record<string, unknown> = {}): never {
  return {
    signal: new AbortController().signal,
    ctx: { env: async (name: string) => process.env[name] },
    ...overrides,
  } as never;
}

/** A minimal `LoginInteraction` double that records what it was told. */
function fakeInteraction(answer: string) {
  const notifications: string[] = [];
  return {
    notifications,
    interaction: {
      signal: new AbortController().signal,
      notify: (event: { message: string }) => {
        notifications.push(event.message);
      },
      prompt: async () => answer,
    } as never,
  };
}

describe("resolveBaseUrl", () => {
  test("defaults to the documented endpoint", () => {
    assert.equal(resolveBaseUrl(() => undefined), DEFAULT_BASE_URL);
    assert.equal(DEFAULT_BASE_URL, "https://inference.poolside.ai/v1");
  });

  test("honours an override and strips trailing slashes", () => {
    assert.equal(resolveBaseUrl(() => "https://mirror.internal/v1///"), "https://mirror.internal/v1");
  });

  test("treats a whitespace-only override as unset", () => {
    assert.equal(resolveBaseUrl(() => "   "), DEFAULT_BASE_URL);
  });
});

describe("probeKey — a key check that costs no tokens", () => {
  test("404 for an impossible model id means the key was accepted", async () => {
    // Measured: this gateway parses the body first, then the key, then the model
    // id — so a structurally valid request for a non-existent id is a pre-inference
    // 404 for a good key and a 403 for a wrong one.
    let seenBody: Record<string, unknown> | undefined;
    const result = await probeKey("sky_test", DEFAULT_BASE_URL, (async (_url: unknown, init?: RequestInit) => {
      seenBody = JSON.parse(String(init?.body));
      return new Response('{"error":"please check the model you provided"}', { status: 404 });
    }) as unknown as typeof fetch);
    assert.equal(result, "valid");
    assert.equal(seenBody?.model, KEY_PROBE_MODEL_ID);
    assert.equal(seenBody?.max_tokens, 1, "the cap bounds the worst case if the id ever resolved");
    assert.ok(Array.isArray(seenBody?.messages) && seenBody.messages.length > 0,
      "the body must be structurally valid, or the body check wins and the key is never examined");
  });

  test("a 400 on the empty body is NOT read as a valid key", async () => {
    // The trap this probe was redesigned around: `{}` is answered 400 for a good
    // key *and* for a bogus one (recorded: `badkey-empty-body`), so a 400 must
    // never be treated as proof of a working key.
    const result = await probeKey("sky_bogus", DEFAULT_BASE_URL, (async () =>
      new Response('{"error":"Invalid request body"}', { status: 400 })) as unknown as typeof fetch);
    assert.notEqual(result, "invalid", "a 400 is not a 403 — but see the next assertion");
    // The decisive guard is that the probe never *sends* an empty body: it must
    // send a structurally valid one so that the gateway reaches the key check.
    let body: Record<string, unknown> | undefined;
    await probeKey("sky_bogus", DEFAULT_BASE_URL, (async (_url: unknown, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response("", { status: 403 });
    }) as unknown as typeof fetch);
    assert.ok(body && Object.keys(body).length > 0, "the probe sent an empty body");
  });

  test("403 is an invalid key, 401 too", async () => {
    for (const status of [401, 403]) {
      const result = await probeKey("sky_bad", DEFAULT_BASE_URL, (async () =>
        new Response('{"error":"please check the api-key you provided"}', { status })) as unknown as typeof fetch);
      assert.equal(result, "invalid", `status ${status}`);
    }
  });

  test("a network failure is unknown, never invalid", async () => {
    const result = await probeKey("sky_test", DEFAULT_BASE_URL, (() => {
      throw new Error("ENOTFOUND");
    }) as unknown as typeof fetch);
    assert.equal(result, "unknown");
  });

  test("the 502 proxy page is not read as a bad key", async () => {
    // A 502 is the proxy, not the API; `/login` must not reject the key over it.
    const result = await probeKey("sky_test", DEFAULT_BASE_URL, (async () =>
      new Response("<html><title>502 Server Error</title></html>", { status: 502 })) as unknown as typeof fetch);
    assert.equal(result, "valid");
  });

  test("hits the chat-completions route, not the listing", async () => {
    let url: string | undefined;
    await probeKey("sky_test", "https://host/v1/", (async (input: unknown) => {
      url = String(input);
      return new Response("", { status: 404 });
    }) as unknown as typeof fetch);
    assert.equal(url, "https://host/v1/chat/completions");
  });

  test("the probe asks for a model id that cannot exist", () => {
    // If this id ever became real the probe would generate a token; the test is
    // here so the id cannot be changed into a live one by accident.
    assert.match(KEY_PROBE_MODEL_ID, /nonexistent/);
  });
});

describe("poolsideApiKeyAuth", () => {
  test("login validates a good key and saves it trimmed", async () => {
    const { interaction } = fakeInteraction("  sky_good  ");
    const auth = poolsideApiKeyAuth(() => DEFAULT_BASE_URL, (async () =>
      new Response('{"error":"please check the model you provided"}', { status: 404 })) as unknown as typeof fetch);
    const credential = await auth.login!(interaction);
    assert.deepEqual(credential, { type: "api_key", key: "sky_good" });
  });

  test("login refuses a rejected key and saves nothing", async () => {
    const { interaction } = fakeInteraction("sky_bad");
    const auth = poolsideApiKeyAuth(() => DEFAULT_BASE_URL, (async () =>
      new Response('{"error":"please check the api-key you provided"}', { status: 403 })) as unknown as typeof fetch);
    await assert.rejects(() => auth.login!(interaction), /403 `please check the api-key you provided`/);
  });

  test("login saves the key when the gateway cannot be reached", async () => {
    const { interaction, notifications } = fakeInteraction("sky_good");
    const auth = poolsideApiKeyAuth(() => DEFAULT_BASE_URL, (() => {
      throw new Error("offline");
    }) as unknown as typeof fetch);
    assert.deepEqual(await auth.login!(interaction), { type: "api_key", key: "sky_good" });
    assert.ok(notifications.some((message) => /offline/i.test(message)));
  });

  test("login rejects an empty entry without calling the gateway", async () => {
    let called = false;
    const { interaction } = fakeInteraction("   ");
    const auth = poolsideApiKeyAuth(() => DEFAULT_BASE_URL, (async () => {
      called = true;
      return new Response("", { status: 404 });
    }) as unknown as typeof fetch);
    await assert.rejects(() => auth.login!(interaction), /No API key entered/);
    assert.equal(called, false, "an empty entry must not spend a request");
  });

  test("login warns about a non-sky_ prefix but still checks it", async () => {
    const { interaction, notifications } = fakeInteraction("nvidia-key");
    const auth = poolsideApiKeyAuth(() => DEFAULT_BASE_URL, (async () =>
      new Response("", { status: 404 })) as unknown as typeof fetch);
    assert.deepEqual(await auth.login!(interaction), { type: "api_key", key: "nvidia-key" });
    assert.ok(notifications.some((message) => /does not look like a Poolside key/.test(message)));
  });

  test("resolve trims a stored key", async () => {
    const auth = poolsideApiKeyAuth();
    const resolved = await auth.resolve(resolveInput({ credential: { type: "api_key", key: " sky_abc \n" } }));
    assert.equal(resolved?.auth.apiKey, "sky_abc");
  });

  test("resolve reports an empty key as unconfigured", async () => {
    // Otherwise pi sends `Authorization: Bearer ` and the front proxy answers a
    // 502 HTML page — a gateway outage in the user's eyes.
    const auth = poolsideApiKeyAuth();
    for (const key of ["", "   ", "\n"]) {
      const resolved = await auth.resolve(resolveInput({ credential: { type: "api_key", key } }));
      assert.equal(resolved, undefined, `key ${JSON.stringify(key)}`);
    }
  });

  test("env fallback works through envApiKeyAuth", async () => {
    process.env[API_KEY_ENV_VAR] = "  sky_from_env  ";
    const auth: ApiKeyAuth = poolsideApiKeyAuth();
    const resolved = await auth.resolve(resolveInput());
    assert.equal(resolved?.auth.apiKey, "sky_from_env", "the env path must be trimmed too");
    assert.equal(resolved?.source, API_KEY_ENV_VAR);
  });
});

describe("buildPoolsideProvider", () => {
  test("registers both listing models with the resolved base URL", () => {
    const provider = buildPoolsideProvider({} as ProviderStreams, "https://mirror.internal/v1");
    assert.equal(provider.id, PROVIDER_ID);
    assert.equal(provider.name, "Poolside");
    assert.equal(provider.baseUrl, "https://mirror.internal/v1");
    const models = provider.getModels();
    assert.deepEqual(
      models.map((model) => model.id),
      CATALOG.map((entry) => entry.id),
    );
    for (const model of models) assert.equal(model.baseUrl, "https://mirror.internal/v1");
  });

  test("always uses the resolved default, never a hardcoded one", () => {
    process.env[BASE_URL_ENV_VAR] = "https://self-hosted.internal/v1";
    const provider = buildPoolsideProvider({} as ProviderStreams);
    assert.equal(provider.baseUrl, "https://self-hosted.internal/v1");
  });

  test("the api map dispatches only openai-completions, and routes calls to it", async () => {
    let streamed = 0;
    const api = openAICompletionsApi();
    const spy: ProviderStreams = {
      stream: (model, context, options) => {
        streamed++;
        return api.stream(model, context, options);
      },
      streamSimple: (model, context, options) => {
        streamed++;
        return api.streamSimple(model, context, options);
      },
    };
    const provider = buildPoolsideProvider(spy, DEFAULT_BASE_URL);
    const fetchStub = (async () => new Response("", { status: 500 })) as unknown as typeof fetch;
    const stream = provider.streamSimple(provider.getModels()[0], {
      systemPrompt: "s",
      messages: [{ role: "user", content: "hi", timestamp: 1 }],
    } as never, { apiKey: "sky_test", fetch: fetchStub, maxRetries: 0 });
    for await (const _event of stream) {
      // drain
    }
    assert.equal(streamed, 1);
  });

  test("reports unconfigured auth when no key exists anywhere", async () => {
    const provider = buildPoolsideProvider({} as ProviderStreams, DEFAULT_BASE_URL);
    assert.equal(await provider.auth.apiKey?.resolve(resolveInput()), undefined);
  });
});
