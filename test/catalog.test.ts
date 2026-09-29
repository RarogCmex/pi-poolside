/**
 * Catalog invariants, checked against the **recorded listing** rather than
 * against a hand-written expectation. `test/fixtures/listing.json` was
 * transcribed once from the recorded `GET /v1/models` body and has no generator
 * (`live/make-error-fixtures.ts` writes only `error-bodies.json` and
 * `streams.json`), so the frozen numbers in `catalog.ts` can only drift from the
 * recording by failing here.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { describe } from "node:test";
import {
  CATALOG,
  CATALOG_BY_ID,
  LISTING_SNAPSHOT_DATE,
  UNKNOWN_MODEL_FALLBACK,
  listingIsFree,
  parseListing,
} from "../catalog.ts";
import { PROVIDER_ID } from "../models.ts";

const listing = JSON.parse(
  readFileSync(new URL("./fixtures/listing.json", import.meta.url), "utf8"),
) as { data: Record<string, unknown>[] };

describe("frozen listing snapshot", () => {
  test("the listing carried exactly the two ids the catalog declares", () => {
    const listed = listing.data.map((m) => m.id);
    assert.deepEqual(listed, CATALOG.map((entry) => entry.id));
    assert.equal(
      CATALOG.length,
      2,
      "the catalog mirrors the recorded listing — a new id needs a new recording",
    );
  });

  test("every catalog number equals the listing's own value", () => {
    for (const entry of CATALOG) {
      const raw = listing.data.find((m) => m.id === entry.id);
      assert.ok(raw, `${entry.id} missing from the recorded listing`);
      assert.equal(entry.contextWindow, raw.context_length, `${entry.id} context window`);
      assert.equal(entry.maxTokens, raw.max_completion_tokens, `${entry.id} output cap`);
      assert.equal(entry.name, raw.name, `${entry.id} name`);
      assert.equal(entry.quantization, raw.quantization, `${entry.id} quantization`);
      assert.equal(entry.description, raw.description, `${entry.id} description`);
      assert.deepEqual(entry.input, raw.input_modalities, `${entry.id} input modalities`);
    }
  });

  test("reasoning and tools come from supported_features, not from an id's name", () => {
    for (const entry of CATALOG) {
      const raw = listing.data.find((m) => m.id === entry.id) as { supported_features: string[] };
      assert.equal(entry.reasoning, raw.supported_features.includes("reasoning"));
      assert.equal(entry.tools, raw.supported_features.includes("tools"));
    }
  });

  test("every price in the listing is the string \"0\" (so $0 is measured, not a guess)", () => {
    for (const raw of listing.data) {
      const pricing = raw.pricing as Record<string, string>;
      const values = Object.values(pricing);
      assert.ok(values.length > 0, "listing carried no pricing object");
      for (const value of values) {
        assert.equal(value, "0", "a non-zero price would invalidate ZERO_COST");
      }
    }
    for (const entry of CATALOG) assert.match(entry.priceNote, /pricing|free key/);
  });

  test("both ids are is_free, which is why the ledger is token-only", () => {
    for (const entry of CATALOG) {
      assert.equal(listingIsFree(listing, entry.id), true);
    }
  });

  test("the snapshot date is recorded next to the data it dates", () => {
    assert.equal(LISTING_SNAPSHOT_DATE, "2026-09-26");
  });

  test("provenance is 'listing' for every entry — nothing in this file is guessed", () => {
    for (const entry of CATALOG) assert.equal(entry.provenance, "listing");
  });

  test("the catalog is keyed by provider-prefixed ids", () => {
    assert.equal(PROVIDER_ID, "poolside");
    assert.equal(CATALOG_BY_ID.size, CATALOG.length);
    for (const entry of CATALOG) {
      assert.ok(entry.id.startsWith("poolside/"), `${entry.id} is not a gateway id`);
      assert.equal(CATALOG_BY_ID.get(entry.id)?.id, entry.id);
    }
  });
});

describe("parseListing — the one parser shared with the discovery overlay", () => {
  test("reproduces the frozen catalog from the recorded body", () => {
    assert.deepEqual(parseListing(listing), [...CATALOG]);
  });

  test("reads an id that appears later with the same fields as the frozen two", () => {
    const [parsed] = parseListing({
      data: [
        {
          id: "poolside/laguna-m-3.0",
          name: "Laguna M 3.0",
          description: "A model that did not exist on 2026-09-26.",
          quantization: "bf16",
          context_length: 131_072,
          max_completion_tokens: 8_192,
          input_modalities: ["text"],
          supported_features: ["tools", "reasoning"],
          pricing: { prompt: "0" },
        },
      ],
    });
    assert.ok(parsed);
    assert.equal(parsed.contextWindow, 131_072);
    assert.equal(parsed.maxTokens, 8_192);
    assert.equal(parsed.reasoning, true);
    assert.equal(parsed.tools, true);
    assert.equal(parsed.provenance, "listing");
  });

  test("a listing that omits the limits falls back to the frozen family values", () => {
    const [parsed] = parseListing({ data: [{ id: "poolside/unknown-1" }] });
    assert.ok(parsed);
    assert.equal(parsed.contextWindow, UNKNOWN_MODEL_FALLBACK.contextWindow);
    assert.equal(parsed.maxTokens, UNKNOWN_MODEL_FALLBACK.maxTokens);
    // No `supported_features` means no reasoning claim: fail open on the
    // unknown rather than claiming a capability nobody advertised.
    assert.equal(parsed.reasoning, false);
    assert.equal(parsed.tools, false);
    assert.deepEqual(parsed.input, ["text"]);
    assert.match(parsed.priceNote, /no `pricing` object/);
  });

  test("never throws on a malformed body (a discovery overlay must not break startup)", () => {
    for (const payload of [null, undefined, 42, "[]", {}, { data: null }, { data: [null, 1] }]) {
      assert.deepEqual(parseListing(payload), []);
    }
  });

  test("drops duplicate ids and blank ids", () => {
    const parsed = parseListing({
      data: [
        { id: "poolside/dup", context_length: 1 },
        { id: "poolside/dup", context_length: 2 },
        { id: "   " },
        { id: 7 },
      ],
    });
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].contextWindow, 1);
  });

  test("an unmapped modality is not silently turned into an image input", () => {
    const [parsed] = parseListing({ data: [{ id: "x", input_modalities: ["video"] }] });
    assert.deepEqual(parsed.input, ["text"]);
  });
});
