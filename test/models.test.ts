/**
 * Catalog → pi `Model` conversion invariants.
 *
 * These assert the *metadata contract* rather than the wire bytes (that is
 * `wire-format.test.ts`): identity, the listing-sourced numbers, the zero cost,
 * and the fact that every model's `thinkingLevelMap` presents the boolean as the
 * two states that exist.
 */

import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import { CATALOG } from "../catalog.ts";
import {
  buildModels,
  CHAT_COMPAT,
  DEFAULT_BASE_URL,
  entryToModel,
  MAX_TOKENS_FIELD,
  PROVIDER_ID,
  THINKING_ON_LEVEL,
} from "../models.ts";

describe("entryToModel", () => {
  test("identity fields come from the listing entry", () => {
    for (const entry of CATALOG) {
      const model = entryToModel(entry, DEFAULT_BASE_URL) as Model<"openai-completions">;
      assert.equal(model.id, entry.id);
      assert.equal(model.name, entry.name);
      assert.equal(model.provider, PROVIDER_ID);
      assert.equal(model.api, "openai-completions");
      assert.equal(model.baseUrl, DEFAULT_BASE_URL);
      assert.deepEqual(model.input, entry.input);
    }
  });

  test("the numbers are the listing's numbers", () => {
    for (const entry of CATALOG) {
      const model = entryToModel(entry, DEFAULT_BASE_URL) as Model<"openai-completions">;
      assert.equal(model.contextWindow, entry.contextWindow);
      assert.equal(model.maxTokens, entry.maxTokens);
      assert.equal(model.contextWindow, 262_144);
      assert.equal(model.maxTokens, 32_768);
    }
  });

  test("cost is zero on every axis, because the listing prices zero", () => {
    for (const entry of CATALOG) {
      const model = entryToModel(entry, DEFAULT_BASE_URL);
      assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
      // A model with no `promptCache` declaration must not make pi warm a cache:
      // cache warming sends extra billed requests (pi's settings-manager), and
      // nothing here measured a cache-control field.
      assert.equal(model.promptCache, undefined);
    }
  });

  test("reasoning is true, and that is load-bearing in pi", () => {
    // `chat_template_kwargs` and `reasoning_content` are only applied when
    // `model.reasoning` is set (pi-ai 0.87.1 `openai-completions.js:645`,
    // `:1044`), so this flag is not cosmetic — with `reasoning: false` the
    // thinking switch and the reasoning echo would both silently vanish.
    for (const entry of CATALOG) {
      assert.equal(entry.reasoning, true);
      assert.equal(entryToModel(entry, DEFAULT_BASE_URL).reasoning, true);
    }
  });

  test("no headers are invented for the request", () => {
    for (const entry of CATALOG) {
      assert.equal(entryToModel(entry, DEFAULT_BASE_URL).headers, undefined);
    }
  });

  test("the base URL is passed through, so a mirror or self-managed endpoint works", () => {
    const model = entryToModel(CATALOG[0], "https://host.internal/v1") as Model<"openai-completions">;
    assert.equal(model.baseUrl, "https://host.internal/v1");
  });

  test("each model gets its own compat object (no shared mutable state)", () => {
    const first = entryToModel(CATALOG[0], DEFAULT_BASE_URL);
    const second = entryToModel(CATALOG[1], DEFAULT_BASE_URL);
    assert.notEqual(first.compat, second.compat);
    assert.deepEqual(first.compat, second.compat);
    assert.deepEqual(first.compat, CHAT_COMPAT);
  });
});

describe("buildModels", () => {
  test("returns one model per catalog entry, in listing order", () => {
    const models = buildModels(DEFAULT_BASE_URL);
    assert.equal(models.length, CATALOG.length);
    assert.deepEqual(
      models.map((model) => model.id),
      CATALOG.map((entry) => entry.id),
    );
  });
});

describe("thinking levels offered to the user", () => {
  test("exactly two levels exist: off and the single on-level", () => {
    for (const entry of CATALOG) {
      const model = entryToModel(entry, DEFAULT_BASE_URL);
      assert.deepEqual(getSupportedThinkingLevels(model), ["off", THINKING_ON_LEVEL]);
    }
  });

  test("the on-level is a real string, so it can never fall back to pi's internal name", () => {
    for (const entry of CATALOG) {
      const map = entryToModel(entry, DEFAULT_BASE_URL).thinkingLevelMap;
      assert.ok(map);
      assert.equal(map[THINKING_ON_LEVEL], THINKING_ON_LEVEL);
      // Every level the model cannot express is an explicit null (hidden and
      // clamped), never merely omitted — an omitted entry stays supported and
      // would fall back to pi's own level name.
      for (const absent of ["minimal", "medium", "high", "xhigh", "max"] as const) {
        assert.equal(map[absent], null, `${absent} must be an explicit null`);
      }
      // `off` is deliberately NOT null: a null off is filtered out, so off clamps
      // upward and thinking gets billed after the user disabled it.
      assert.notEqual(map.off, null);
    }
  });

  test("MAX_TOKENS_FIELD is the request field, not the listing's name for it", () => {
    assert.equal(MAX_TOKENS_FIELD, "max_tokens");
    assert.notEqual(MAX_TOKENS_FIELD, "max_completion_tokens");
  });
});
