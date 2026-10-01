/**
 * Selector tests — the part of `npm run live` that can be verified without a key,
 * without a network and without pi. `live/select.ts` is pure on purpose: these
 * assertions are the only thing standing between a filter typo and a run that
 * silently executed nothing.
 *
 * The check list here mirrors `live/check.ts`'s own `CHECKS` (ids, a title
 * fragment, and which are costly); the harness's copy is the source of truth for
 * titles, and `test/hygiene.test.ts`-style duplication is avoided by asserting
 * behaviour, not exact strings.
 */

import assert from "node:assert/strict";
import test, { describe } from "node:test";
import {
  filterMatches,
  formatCheckList,
  parseLiveArgs,
  usageText,
  type LiveCheck,
} from "../live/select.ts";

const CHECKS: LiveCheck[] = [
  { id: "A", title: "the listing still carries the frozen catalog", costly: false },
  { id: "B", title: "key validation without inference and the empty-body trap", costly: false },
  { id: "C", title: "the maxTokensField trap and the documented ranges", costly: false },
  { id: "D", title: "the outgoing body: max_tokens and enable_thinking", costly: false },
  { id: "E", title: "thinking is on/off, not a scale", costly: true },
  { id: "F", title: "reasoning_content is accepted on the assistant message", costly: true },
  { id: "G", title: "a function tool returns a well-formed tool call", costly: true },
  { id: "H", title: "usage on every chunk does not double-count", costly: true },
  { id: "I", title: "every measured dialect is classified", costly: false },
  { id: "J", title: "surfaces: two more exist and are not registered", costly: true },
];

const ids = (argv: string[]) => parseLiveArgs(argv, CHECKS).matched;

describe("parseLiveArgs", () => {
  test("no arguments selects every check, in catalog order", () => {
    assert.deepEqual(ids([]), CHECKS.map((c) => c.id));
    assert.deepEqual(ids(["  ", ""]), CHECKS.map((c) => c.id), "blank args are ignored");
  });

  test("positional ids select exactly those checks", () => {
    assert.deepEqual(ids(["A"]), ["A"]);
    assert.deepEqual(ids(["A", "D"]), ["A", "D"]);
    assert.deepEqual(ids(["D", "A"]), ["A", "D"], "order follows the catalog, not argv");
    assert.deepEqual(ids(["a", "d"]), ["A", "D"], "ids are case-insensitive");
  });

  test("--only= is the comma-separated spelling of the same thing", () => {
    assert.deepEqual(ids(["--only=A,D"]), ["A", "D"]);
    assert.deepEqual(ids(["--only=a, d ,G"]), ["A", "D", "G"], "spaces are trimmed");
    assert.deepEqual(ids(["--only=A", "D"]), ["A", "D"], "mixes with positionals");
  });

  test("a title substring selects every check it appears in", () => {
    assert.deepEqual(ids(["tool"]), ["G"]);
    assert.deepEqual(ids(["listing"]), ["A"]);
    assert.deepEqual(ids(["trap"]), ["B", "C"], "matches more than one, and that is fine");
    assert.deepEqual(
      ids(["THINKING"]),
      ["D", "E"],
      "both titles contain it: substring matching is not id matching",
    );
  });

  test("a filter shorter than three characters is an id, never a title substring", () => {
    // Every title contains the letter "a"; without this rule `-- a` would run all.
    assert.deepEqual(ids(["a"]), ["A"]);
    assert.deepEqual(ids(["ab"]), [], "matches nothing, so check.ts exits 2");
    assert.deepEqual(parseLiveArgs(["ab"], CHECKS).unknown, ["ab"]);
  });

  test("--free keeps exactly the checks that cost no tokens", () => {
    assert.deepEqual(ids(["--free"]), CHECKS.filter((c) => !c.costly).map((c) => c.id));
    assert.deepEqual(ids(["--free", "A"]), ["A"], "narrows further with a filter");
    assert.deepEqual(ids(["--free", "E"]), [], "E is costly: the intersection is empty");
  });

  test("a filter that matches nothing is reported, not swallowed", () => {
    const selection = parseLiveArgs(["ZZZ", "A"], CHECKS);
    assert.deepEqual(selection.unknown, ["ZZZ"]);
    assert.deepEqual(selection.matched, ["A"], "the valid filter still applies");
    const none = parseLiveArgs(["ZZZ"], CHECKS);
    assert.deepEqual(none.matched, []);
    assert.deepEqual(none.unknown, ["ZZZ"]);
  });

  test("unknown flags are rejected instead of being read as filters", () => {
    const selection = parseLiveArgs(["--nope", "A"], CHECKS);
    assert.deepEqual(selection.badFlags, ["--nope"]);
    assert.deepEqual(selection.matched, ["A"]);
  });

  test("--list and --help are flags, not filters", () => {
    const list = parseLiveArgs(["--list"], CHECKS);
    assert.equal(list.list, true);
    assert.deepEqual(list.filters, []);
    assert.equal(parseLiveArgs(["-l"], CHECKS).list, true);
    assert.equal(parseLiveArgs(["--help"], CHECKS).help, true);
    assert.equal(parseLiveArgs(["-h"], CHECKS).help, true);
  });

  test("selected() agrees with matched", () => {
    const selection = parseLiveArgs(["G", "I"], CHECKS);
    assert.equal(selection.selected("G"), true);
    assert.equal(selection.selected("I"), true);
    assert.equal(selection.selected("A"), false);
  });
});

describe("filterMatches", () => {
  test("matches an id exactly and a title substring of three or more characters", () => {
    const g = CHECKS.find((c) => c.id === "G")!;
    assert.equal(filterMatches(g, "G"), true);
    assert.equal(filterMatches(g, "g"), true);
    assert.equal(filterMatches(g, "tool"), true);
    assert.equal(filterMatches(g, "well-formed"), true);
    assert.equal(filterMatches(g, "A"), false);
    assert.equal(filterMatches(g, ""), false, "an empty filter matches nothing");
    assert.equal(filterMatches(g, "   "), false);
    assert.equal(filterMatches(g, "to"), false, "two characters are read as an id, not a substring");
  });
});

describe("requirements", () => {
  test("selecting a dependent check pulls in what it consumes", () => {
    const withDep: LiveCheck[] = [
      { id: "A", title: "probes", costly: false },
      { id: "I", title: "classifies", costly: false, requires: ["A"] },
    ];
    const selection = parseLiveArgs(["I"], withDep);
    assert.deepEqual(selection.matched, ["A", "I"], "catalog order, not argv order");
    assert.deepEqual(selection.pulledIn, ["A"]);
    assert.equal(selection.selected("A"), true);
  });

  test("expansion is transitive and does not loop", () => {
    const chain: LiveCheck[] = [
      { id: "A", title: "first", costly: false },
      { id: "B", title: "second", costly: false, requires: ["A"] },
      { id: "C", title: "third", costly: false, requires: ["B"] },
    ];
    const selection = parseLiveArgs(["C"], chain);
    assert.deepEqual(selection.matched, ["A", "B", "C"]);
    assert.deepEqual(selection.pulledIn, ["B", "A"], "nearest requirement first");
  });

  test("a requirement wins over --free, because the check cannot run without it", () => {
    const mixed: LiveCheck[] = [
      { id: "A", title: "free probe", costly: false },
      { id: "I", title: "classifies", costly: false, requires: ["A"] },
      { id: "E", title: "costly", costly: true },
    ];
    assert.deepEqual(parseLiveArgs(["--free"], mixed).matched, ["A", "I"]);
    const costlyDep: LiveCheck[] = [
      { id: "E", title: "costly probe", costly: true },
      { id: "I", title: "classifies", costly: false, requires: ["E"] },
    ];
    assert.deepEqual(
      parseLiveArgs(["--free"], costlyDep).matched,
      ["E", "I"],
      "I needs E's measurement, so --free still runs E",
    );
  });

  test("--list shows the requirement", () => {
    const withDep: LiveCheck[] = [
      { id: "A", title: "probes", costly: false },
      { id: "I", title: "classifies", costly: false, requires: ["A"] },
    ];
    assert.match(formatCheckList(withDep, ["A", "I"]), /needs A/);
  });
});

describe("formatCheckList", () => {
  test("lists every check, its cost and which the selection covers", () => {
    const out = formatCheckList(CHECKS, ["A", "G"]);
    for (const check of CHECKS) assert.ok(out.includes(check.id), `missing ${check.id}`);
    assert.ok(out.includes("2 of 10 selected"));
    const marked = out.split("\n").filter((line) => line.trimStart().startsWith("*"));
    assert.deepEqual(
      marked.map((line) => line.trim().split(/\s+/)[1]),
      ["A", "G"],
    );
    assert.ok(/free/.test(out) && /costly/.test(out), "cost column is printed");
  });

  test("an empty selection still lists the catalog", () => {
    const out = formatCheckList(CHECKS, []);
    assert.ok(out.includes("0 of 10 selected"));
    assert.equal(out.split("\n").filter((l) => l.trimStart().startsWith("*")).length, 0);
  });
});

describe("usageText", () => {
  test("names every flag the parser accepts", () => {
    const text = usageText();
    for (const flag of ["--list", "--free", "--only=", "--help"]) {
      assert.ok(text.includes(flag), `usage does not mention ${flag}`);
    }
  });
});
