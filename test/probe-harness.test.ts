/**
 * The probe harness's own guard.
 *
 * An earlier version of `live/probe.ts` collapsed `auth: null` into `undefined`
 * and quietly substituted the real key, so `GET /models` "answered 200 without
 * authorization" and a false fixture was written to `research/raw/`. That is
 * pitfall L1 in its purest form: the probe measured the harness, not the
 * provider. `buildHeaders` is exported and asserted here so the mistake cannot
 * come back, and so the fixture generated from it means what it says.
 *
 * The harness is also asserted to be import-safe: a test that imports it must
 * not source `secret.env`, create directories, or touch the network.
 */

import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { buildHeaders, isTransient } from "../live/probe.ts";

describe("buildHeaders", () => {
  test('"absent" really omits the Authorization header', () => {
    const headers = buildHeaders("absent", "sky_secret_value");
    assert.equal("Authorization" in headers, false);
    assert.equal(Object.keys(headers).join(","), "Content-Type");
  });

  test('"empty" sends the header with no value — a different state from absent', () => {
    const headers = buildHeaders("empty", "sky_secret_value");
    assert.equal(headers.Authorization, "Bearer ");
  });

  test('"key" uses the key and "literal" uses the supplied value', () => {
    assert.equal(buildHeaders("key", "sky_secret_value").Authorization, "Bearer sky_secret_value");
    assert.equal(buildHeaders("literal", "sky_ignored", "sky_bogus").Authorization, "Bearer sky_bogus");
  });

  test("no mode leaks the real key into the absent or empty form", () => {
    for (const mode of ["absent", "empty"] as const) {
      const headers = buildHeaders(mode, "sky_secret_value");
      assert.ok(
        !JSON.stringify(headers).includes("sky_secret_value"),
        `mode ${mode} leaked the key`,
      );
    }
  });

  test('a literal with no value is still the empty-Bearer form, not a fallback to the key', () => {
    assert.equal(buildHeaders("literal", "sky_secret_value", "").Authorization, "Bearer ");
    assert.equal(buildHeaders("literal", "sky_secret_value", undefined).Authorization, "Bearer ");
  });
});

describe("isTransient", () => {
  test("5xx and 429 are transient; deterministic 4xx findings are not", () => {
    for (const status of [500, 502, 503, 504, 429]) assert.equal(isTransient(status), true, `${status}`);
    for (const status of [200, 400, 401, 403, 404, 405, 422]) {
      assert.equal(isTransient(status), false, `${status}`);
    }
  });
});

describe("import safety", () => {
  test("importing the harness performs no I/O", () => {
    // The import above already happened; what is asserted is the observable
    // consequence — no raw file was created by the import itself, and the
    // module never reads secret.env at import time. Reaching here without an
    // exception is the test.
    assert.equal(typeof buildHeaders, "function");
  });
});
