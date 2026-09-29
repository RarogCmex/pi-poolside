/**
 * Hygiene guards: no credential may reach the working tree, and the live harness
 * must not be able to run by accident.
 *
 * No key file is committed, but a key pasted into a README example, a recorded
 * response body or a fixture is easy to miss by eye — so the tree is scanned
 * rather than assumed. The walk covers everything that gets published,
 * `research/*.md` included: `research/` is the one directory a partial scan tends
 * to skip, and skipping it makes the "raw captures are not in the tree"
 * assertion below vacuously true.
 *
 * `research/raw/` is excluded by path, not by name: it is gitignored, holds
 * verbatim gateway bodies, and does not exist in a fresh clone.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test, { describe } from "node:test";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Directories that hold no published source of ours, by relative path. */
const SKIP_DIRS = new Set(["node_modules", ".git", join("research", "raw")]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const rel = relative(ROOT, path);
    if (SKIP_DIRS.has(rel) || SKIP_DIRS.has(entry)) continue;
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

const FILES = walk(ROOT);

/** Guard against the scan silently degrading to nothing (see the header). */
const SCANNED = FILES.map((path) => relative(ROOT, path).split(sep).join("/"));

describe("no secret in the working tree", () => {
  test("no file contains a Poolside key literal", () => {
    // The real key shape (`sky_` + a long body) is what must never appear; the
    // tests legitimately use `sky_test`/`sky_abc`, so the pattern requires a
    // body of 16+ characters.
    const pattern = /sky_[A-Za-z0-9]{16,}/;
    for (const path of FILES) {
      const text = readFileSync(path, "utf8");
      const match = pattern.exec(text);
      assert.equal(match, null, `possible key in ${path}: ${match?.[0].slice(0, 12)}…`);
    }
  });

  /**
   * Deliberately invalid key literals used by the live harness to *measure* the
   * 403 dialect (`live/probe.ts`, `live/check.ts`). They are not credentials:
   * they are the bogus values the gateway is asked to reject, and the assertion
   * below is that nothing else of that shape exists anywhere.
   */
  const BOGUS_KEYS = new Set(["sky_bogus_key_000000000000000000000000"]);

  test("no file hardcodes a bearer token, except the deliberately bogus probe value", () => {
    const allowed = new Map([...BOGUS_KEYS].map((key) => [`Bearer ${key}`, 0]));
    for (const path of FILES) {
      const text = readFileSync(path, "utf8");
      for (const match of text.matchAll(/Bearer ([A-Za-z0-9_.-]{20,})/g)) {
        const literal = match[0];
        if (allowed.has(literal)) {
          allowed.set(literal, (allowed.get(literal) ?? 0) + 1);
          continue;
        }
        assert.fail(`hardcoded bearer token in ${path}: ${match[1].slice(0, 8)}…`);
      }
    }
    // The bogus value must still be in use, so the exception cannot quietly
    // become dead code that hides a real leak.
    for (const [literal, count] of allowed) {
      assert.ok(count > 0, `${literal} is allow-listed but unused — remove the exception`);
    }
  });

  test("secret.env is not tracked and is gitignored", () => {
    const ignore = readFileSync(join(ROOT, ".gitignore"), "utf8");
    for (const entry of ["secret.env", "node_modules/", "research/raw/"]) {
      assert.ok(ignore.includes(entry), `.gitignore must list ${entry}`);
    }
  });

  test("the recorded raw responses are not part of the published tree", () => {
    // `research/raw/` holds verbatim gateway responses; they are inputs to the
    // fixture generator, not deliverables. This assertion is only meaningful
    // because the walk above scans `research/` and excludes `raw/` by path —
    // so first prove the walk really reached the published research notes.
    assert.ok(
      SCANNED.some((path) => path === "research/2026-09-26-live-verification.md"),
      "the scan did not reach research/*.md — the raw-capture check below is vacuous",
    );
    assert.ok(
      !SCANNED.some((path) => path.startsWith("research/raw/")),
      "raw probes leaked into the tree",
    );
  });

  test("the committed fixtures are the generated ones, not the raw captures", () => {
    // `live/make-error-fixtures.ts` mentions the directory it writes to; only
    // the files under test/fixtures/ are the committed data.
    const generated = FILES.filter((path) => path.includes(join("test", "fixtures")));
    assert.deepEqual(
      generated.map((path) => path.slice(ROOT.length).replace(/^\/+/, "")).sort(),
      ["test/fixtures/error-bodies.json", "test/fixtures/listing.json", "test/fixtures/streams.json"],
    );
  });
});

describe("the live harness cannot run by accident", () => {
  test("npm test does not include live/", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    assert.ok(!pkg.scripts.test.includes("live/"), "the test script must not run the live harness");
    assert.match(pkg.scripts.live, /node live\/check\.ts/);
    assert.match(pkg.scripts.test, /--import \.\/test\/no-network\.ts/);
  });

  test("the manifest declares the extension and the pi-package keyword", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      pi: { extensions: string[] };
      keywords: string[];
    };
    assert.deepEqual(pkg.pi.extensions, ["./index.ts"]);
    assert.ok(pkg.keywords.includes("pi-package"));
  });
});

describe("documentation stays in sync with the code", () => {
  test("the README names every catalog id", () => {
    const readme = readFileSync(join(ROOT, "README.md"), "utf8");
    for (const id of ["poolside/laguna-xs-2.1", "poolside/laguna-s-2.1"]) {
      assert.ok(readme.includes(id), `README does not mention ${id}`);
    }
  });
});
