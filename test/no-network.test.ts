/**
 * The gate that keeps the offline suite honest: a test that dials out fails
 * instead of spending the free quota, and the loader alias pi uses is mirrored so
 * `index.ts` can be imported here.
 */

import assert from "node:assert/strict";
import test from "node:test";

test("globalThis.fetch throws instead of reaching the network", () => {
  // The stub throws synchronously (not a rejected promise), so `assert.throws`
  // is the right door: `assert.rejects` would report the stub's error as a
  // failed assertion instead of a caught throw.
  assert.throws(
    () => fetch("https://inference.poolside.ai/v1/models"),
    /network blocked: the offline test suite must not dial out/,
  );
});

test("the preload mirrors pi's loader alias for @earendil-works/pi-ai", async () => {
  // `index.ts` is the one pi-runtime-coupled file; loading it here proves the
  // alias works for the bare specifier (plain Node would resolve it to
  // dist/index and `openAICompletionsApi` would be undefined).
  const mod = (await import("../index.ts")) as { default?: unknown };
  assert.equal(typeof mod.default, "function");
});
