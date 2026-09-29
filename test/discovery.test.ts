/**
 * Discovery: the additive, unknowns-only `/v1/models` overlay.
 *
 * Unlike a bare-id listing, this one carries the same fields the frozen catalog
 * was transcribed from, so the overlay can describe a new id from its own
 * metadata. What it may *never* do is replace a frozen entry.
 *
 * `GET /v1/models` is authenticated and answers **401 with no `Authorization`
 * header at all** (recorded), so the refresh must carry the key — and a missing
 * key must return `[]` rather than attempt an unauthenticated call.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { afterEach, beforeEach, describe } from "node:test";
import type { RefreshModelsContext } from "@earendil-works/pi-ai";
import { CATALOG, CATALOG_BY_ID, parseListing, UNKNOWN_MODEL_FALLBACK } from "../catalog.ts";
import { buildOverlay, fetchPoolsideModels, resolveDiscoveryKey } from "../discovery.ts";
import { DEFAULT_BASE_URL } from "../models.ts";

const realFetch = globalThis.fetch;

/**
 * Env coupling guard: this suite must pass whether or not the caller has
 * `POOLSIDE_API_KEY` exported (e.g. after running the live harness in the same
 * shell), so ambient provider variables are removed for the duration and
 * restored afterwards.
 */
const AMBIENT = ["POOLSIDE_API_KEY", "POOLSIDE_BASE_URL"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const name of AMBIENT) {
    savedEnv[name] = process.env[name];
    delete process.env[name];
  }
  // A stub key by default, so a test that means to exercise the request path
  // does not silently become a "no key, no request" test. The test for the
  // keyless path deletes it explicitly.
  process.env.POOLSIDE_API_KEY = "sky_test";
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const name of AMBIENT) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
});

const recorded = JSON.parse(
  readFileSync(new URL("./fixtures/listing.json", import.meta.url), "utf8"),
) as { data: { id: string }[] };

function makeContext(overrides: Partial<RefreshModelsContext> = {}): RefreshModelsContext {
  return {
    allowNetwork: true,
    signal: new AbortController().signal,
    publish: async () => true,
    ...overrides,
  } as RefreshModelsContext;
}

/** Stub the network, recording every request so the test can inspect it. */
function stubFetch(response: () => Response | Promise<Response>): { calls: { url: string; headers: Headers }[] } {
  const calls: { url: string; headers: Headers }[] = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), headers: new Headers(init?.headers) });
    return response();
  }) as unknown as typeof fetch;
  return { calls };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** A listing entry for an id that did not exist on 2026-09-26. */
function futureModel(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name: id,
    context_length: 131_072,
    max_completion_tokens: 8_192,
    input_modalities: ["text"],
    supported_features: ["tools", "reasoning"],
    pricing: { prompt: "0" },
    ...overrides,
  };
}

describe("resolveDiscoveryKey", () => {
  test("prefers the refresh credential and trims it", () => {
    const key = resolveDiscoveryKey(
      makeContext({ credential: { type: "api_key", key: "  sky_abc  " } as never }),
      () => "sky_env",
    );
    assert.equal(key, "sky_abc");
  });

  test("falls back to the environment, trimmed, and treats whitespace as absent", () => {
    assert.equal(resolveDiscoveryKey(makeContext(), () => " sky_env "), "sky_env");
    assert.equal(resolveDiscoveryKey(makeContext(), () => "   "), undefined);
    assert.equal(resolveDiscoveryKey(makeContext(), () => undefined), undefined);
  });

  test("does not read a non-api_key credential as a key", () => {
    const key = resolveDiscoveryKey(
      makeContext({ credential: { type: "oauth", access: "t" } as never }),
      () => "sky_env",
    );
    assert.equal(key, "sky_env");
  });
});

describe("buildOverlay", () => {
  const known = new Set(CATALOG_BY_ID.keys());

  test("adds an unknown id, described by its own listing metadata", () => {
    const overlay = buildOverlay(
      [
        {
          id: "poolside/laguna-m-3.0",
          name: "Laguna M 3.0",
          contextWindow: 131_072,
          maxTokens: 8_192,
          input: ["text"],
          reasoning: true,
          tools: true,
          quantization: "bf16",
          description: "later",
          provenance: "listing",
          priceNote: "priced by the listing",
        },
      ],
      DEFAULT_BASE_URL,
      known,
    );
    assert.equal(overlay.length, 1);
    assert.equal(overlay[0].id, "poolside/laguna-m-3.0");
    assert.equal(overlay[0].contextWindow, 131_072);
    assert.equal(overlay[0].maxTokens, 8_192);
    assert.equal(overlay[0].reasoning, true);
  });

  test("never re-describes a frozen id — the catalog keeps its frozen numbers", () => {
    const overlay = buildOverlay(
      [
        {
          id: "poolside/laguna-xs-2.1",
          name: "Renamed in the listing",
          contextWindow: 1_024,
          maxTokens: 1,
          input: ["text"],
          reasoning: false,
          tools: false,
          quantization: "int4",
          description: "changed",
          provenance: "listing",
          priceNote: "priced by the listing",
        },
      ],
      DEFAULT_BASE_URL,
      known,
    );
    assert.deepEqual(overlay, []);
  });

  test("skips a discovered id whose modalities exclude text", () => {
    // The guard is read from the listing's `input_modalities`, not guessed from
    // an id's name — and it goes through the same `parseListing` the frozen
    // catalog did, so an image-generation id that appears later is described in
    // the same vocabulary and then filtered by it.
    const entries = parseListing({
      data: [
        { id: "poolside/laguna-image-1", input_modalities: ["image"], context_length: 8_192, max_completion_tokens: 1 },
      ],
    });
    assert.deepEqual(entries[0].input, ["image"]);
    assert.deepEqual(buildOverlay(entries, DEFAULT_BASE_URL, known), []);

    // A modality pi cannot represent falls back to `text` in the parser (its own
    // test in `catalog.test.ts`), so the overlay guard is specifically about
    // *image-only* ids, which is the case that exists for other providers.
    const audioOnly = parseListing({ data: [{ id: "poolside/audio-1", input_modalities: ["audio"] }] });
    assert.deepEqual(audioOnly[0].input, ["text"]);
  });

  test("the real catalog is the default 'known' set", () => {
    // Default arguments are part of the contract: the production call passes two
    // arguments, and every frozen id must still be filtered out.
    const overlay = buildOverlay(
      CATALOG.map((entry) => ({ ...entry })),
      DEFAULT_BASE_URL,
    );
    assert.deepEqual(overlay, []);
  });
});

describe("fetchPoolsideModels", () => {
  test("reads the recorded listing and adds nothing, because it lists nothing new", async () => {
    const { calls } = stubFetch(() => jsonResponse(recorded));
    const overlay = await fetchPoolsideModels(DEFAULT_BASE_URL, makeContext());
    assert.deepEqual(overlay, []);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${DEFAULT_BASE_URL}/models`);
  });

  test("sends the key as a bearer token", async () => {
    const { calls } = stubFetch(() => jsonResponse({ data: [] }));
    await fetchPoolsideModels(DEFAULT_BASE_URL, makeContext(), 1_000);
    assert.equal(calls[0].headers.get("authorization"), "Bearer sky_test");
  });

  test("resolves the key from the credential when the env var is unset", async () => {
    const { calls } = stubFetch(() => jsonResponse({ data: [] }));
    await fetchPoolsideModels(
      DEFAULT_BASE_URL,
      makeContext({ credential: { type: "api_key", key: "sky_from_store" } as never }),
    );
    assert.equal(calls[0].headers.get("authorization"), "Bearer sky_from_store");
  });

  test("adds a genuinely new id", async () => {
    stubFetch(() => jsonResponse({ data: [...recorded.data, futureModel("poolside/laguna-m-3.0")] }));
    const overlay = await fetchPoolsideModels(DEFAULT_BASE_URL, makeContext(), 1_000);
    assert.deepEqual(
      overlay.map((model) => model.id),
      ["poolside/laguna-m-3.0"],
    );
  });

  test("a listing entry without limits gets the frozen family values", async () => {
    stubFetch(() => jsonResponse({ data: [futureModel("poolside/bare", { context_length: undefined, max_completion_tokens: undefined })] }));
    const [model] = await fetchPoolsideModels(DEFAULT_BASE_URL, makeContext(), 1_000);
    assert.equal(model.contextWindow, UNKNOWN_MODEL_FALLBACK.contextWindow);
    assert.equal(model.maxTokens, UNKNOWN_MODEL_FALLBACK.maxTokens);
  });

  test("makes no request when the network is not allowed", async () => {
    const { calls } = stubFetch(() => jsonResponse(recorded));
    assert.deepEqual(await fetchPoolsideModels(DEFAULT_BASE_URL, makeContext({ allowNetwork: false })), []);
    assert.equal(calls.length, 0);
  });

  test("makes no request when the signal is already aborted", async () => {
    const { calls } = stubFetch(() => jsonResponse(recorded));
    const controller = new AbortController();
    controller.abort();
    assert.deepEqual(
      await fetchPoolsideModels(DEFAULT_BASE_URL, makeContext({ signal: controller.signal })),
      [],
    );
    assert.equal(calls.length, 0);
  });

  test("makes no request without a usable key", async () => {
    delete process.env.POOLSIDE_API_KEY;
    const { calls } = stubFetch(() => jsonResponse(recorded));
    assert.deepEqual(await fetchPoolsideModels(DEFAULT_BASE_URL, makeContext()), []);
    assert.equal(calls.length, 0, "an unauthenticated listing would only earn a 401");

    // Whitespace is not a key either: it would go out as `Bearer ` and the front
    // proxy answers that with a 502 HTML page.
    process.env.POOLSIDE_API_KEY = "   ";
    assert.deepEqual(await fetchPoolsideModels(DEFAULT_BASE_URL, makeContext()), []);
    assert.equal(calls.length, 0);
  });

  test("a non-OK response returns [] and never throws", async () => {
    // `GET /models` with a wrong key is a 403 whose body never arrives
    // (recorded); the overlay cares only about `response.ok`.
    stubFetch(() => new Response("", { status: 403, headers: { "content-type": "application/json" } }));
    assert.deepEqual(await fetchPoolsideModels(DEFAULT_BASE_URL, makeContext(), 1_000), []);
    stubFetch(() => new Response("No Authorization header provided", { status: 401, headers: { "content-type": "text/plain" } }));
    assert.deepEqual(await fetchPoolsideModels(DEFAULT_BASE_URL, makeContext(), 1_000), []);
  });

  test("a transport failure returns [] rather than propagating", async () => {
    globalThis.fetch = (() => {
      throw new Error("connect ECONNREFUSED");
    }) as unknown as typeof fetch;
    assert.deepEqual(await fetchPoolsideModels(DEFAULT_BASE_URL, makeContext(), 1_000), []);
  });

  test("a body that is not a listing returns []", async () => {
    stubFetch(() => jsonResponse({ unexpected: true }));
    assert.deepEqual(await fetchPoolsideModels(DEFAULT_BASE_URL, makeContext(), 1_000), []);
    stubFetch(() => new Response("<html>bad</html>", { status: 200, headers: { "content-type": "text/html" } }));
    assert.deepEqual(await fetchPoolsideModels(DEFAULT_BASE_URL, makeContext(), 1_000), []);
  });

  test("the base URL is normalised, so a trailing slash cannot double up", async () => {
    const { calls } = stubFetch(() => jsonResponse({ data: [] }));
    await fetchPoolsideModels(`${DEFAULT_BASE_URL}/`, makeContext(), 1_000);
    assert.equal(calls[0].url, `${DEFAULT_BASE_URL}/models`);
  });
});
