/**
 * Per-check selection for `npm run live` — a pure module, so the selector is
 * testable offline (no key, no network, no pi).
 *
 * Why it exists: the harness runs A–J in a fixed order, so re-measuring one
 * claim meant paying for and waiting through all of them (every request is paced
 * 3 s apart). `POOLSIDE_LIVE_SKIP_COSTLY=1` was the only switch and it is coarse:
 * free versus costly, nothing in between. This adds the missing granularity and
 * keeps the old switch working.
 *
 * Grammar:
 *   npm run live                      every check, exactly as before
 *   npm run live -- --list            print the catalog and exit — needs no key
 *   npm run live -- A D               only A and D
 *   npm run live -- tools thinking    substring match on the title → G and E
 *   npm run live -- --only=A,D        the same as the positional form
 *   npm run live -- --free            the free half (what SKIP_COSTLY left)
 *
 * A filter matches a check id exactly, or a check title as a substring — and
 * substring matching needs at least three characters, so `-- A` selects check A
 * instead of every title that happens to contain the letter "a". Matching is
 * case-insensitive. A filter that matches nothing is an **error** (exit 2), not a
 * silent no-op: "ran 0 of 10 checks" must never look like a pass.
 *
 * Some checks consume measurements another check made — `I` classifies the error
 * bodies that `B`'s free probes collected. Such a check declares `requires`, and
 * selection expands it transitively, so `npm run live -- I` runs B too and says
 * so. Before the sections became blocks this coupling was implicit in module
 * scope: selecting I alone would have crashed at runtime on an unbound name.
 */

export interface LiveCheck {
  /** Single-letter id used by the section comments in `check.ts`. */
  id: string;
  /** The name the check reports under, used for substring matching. */
  title: string;
  /** True when the check sends a request the gateway answers with tokens. */
  costly: boolean;
  /** Checks whose measurements this one consumes; pulled in automatically. */
  requires?: readonly string[];
}

export interface Selection {
  list: boolean;
  help: boolean;
  /** Filters as given, after `--only=` expansion. */
  filters: string[];
  /** Ids that will run, in catalog order: the matched ones plus their requirements. */
  matched: string[];
  /** Ids added because a selected check `requires` them. */
  pulledIn: string[];
  /** Filters that matched nothing. */
  unknown: string[];
  /** Flags that are not part of the grammar. */
  badFlags: string[];
  selected(id: string): boolean;
}

const ONLY_PREFIX = "--only=";

/**
 * Shorter than this, a filter is read as an id only: a one- or two-letter
 * substring would match most titles (every check title contains "a"), so
 * `npm run live -- a` would quietly run everything.
 */
const MIN_TITLE_FILTER = 3;

/** Case-insensitive id equality, or title substring at >= MIN_TITLE_FILTER chars. */
export function filterMatches(check: LiveCheck, filter: string): boolean {
  const needle = filter.trim().toLowerCase();
  if (!needle) return false;
  if (needle === check.id.toLowerCase()) return true;
  return needle.length >= MIN_TITLE_FILTER && check.title.toLowerCase().includes(needle);
}

export function parseLiveArgs(
  argv: readonly string[],
  checks: readonly LiveCheck[],
): Selection {
  const filters: string[] = [];
  const badFlags: string[] = [];
  let list = false;
  let help = false;
  let freeOnly = false;

  for (const raw of argv) {
    const arg = raw.trim();
    if (!arg) continue;
    if (arg === "--list" || arg === "-l") {
      list = true;
    } else if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--free") {
      freeOnly = true;
    } else if (arg.startsWith(ONLY_PREFIX)) {
      for (const part of arg.slice(ONLY_PREFIX.length).split(",")) {
        if (part.trim()) filters.push(part.trim());
      }
    } else if (arg.startsWith("-")) {
      badFlags.push(arg);
    } else {
      filters.push(arg);
    }
  }

  const direct = checks
    .filter((check) => (freeOnly ? !check.costly : true))
    .filter((check) => (filters.length === 0 ? true : filters.some((f) => filterMatches(check, f))))
    .map((check) => check.id);

  // Expand `requires` transitively. A requirement wins over `--free`: the check
  // cannot run without the measurement it consumes, so honouring the flag would
  // mean silently skipping the check the user asked for.
  const byId = new Map(checks.map((check) => [check.id, check]));
  const wanted = new Set(direct);
  const pulledIn: string[] = [];
  const queue = [...direct];
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const dependency of byId.get(id)?.requires ?? []) {
      if (wanted.has(dependency)) continue;
      wanted.add(dependency);
      pulledIn.push(dependency);
      queue.push(dependency);
    }
  }

  const matched = checks.filter((check) => wanted.has(check.id)).map((check) => check.id);

  const unknown = filters.filter(
    (filter) => !checks.some((check) => filterMatches(check, filter)),
  );

  return {
    list,
    help,
    filters,
    matched,
    pulledIn,
    unknown,
    badFlags,
    selected: (id: string) => wanted.has(id),
  };
}

/** The `--list` output: id, title, cost, requirements, and a mark on what runs. */
export function formatCheckList(
  checks: readonly LiveCheck[],
  matched: readonly string[],
): string {
  const width = Math.max(...checks.map((c) => c.title.length), 0);
  const lines = checks.map((check) => {
    const mark = matched.includes(check.id) ? "*" : " ";
    const cost = check.costly ? "costly" : "free";
    const needs = check.requires?.length ? `  needs ${check.requires.join(",")}` : "";
    return ` ${mark} ${check.id}  ${check.title.padEnd(width)}  ${cost}${needs}`;
  });
  return [
    "checks (`npm run live -- <id|substring>`; `*` = would run):",
    ...lines,
    `${matched.length} of ${checks.length} selected`,
  ].join("\n");
}

export function usageText(): string {
  return [
    "npm run live [-- <selection>]",
    "",
    "  (no args)        run every check, in the fixed order A–J",
    "  --list, -l       print the checks and which the selection covers, then exit",
    "                   (needs no key and makes no request)",
    "  --free           only the checks that cost no tokens (A–D, I)",
    "  --only=A,D       comma-separated ids or title substrings",
    "  A D tools        the same, as positional filters",
    "  --help, -h       this text",
    "",
    "A filter matches a check id exactly, or a title substring of three or",
    "more characters, case-insensitively (so `a` is the id, not every title",
    "containing the letter). A filter that matches nothing exits 2 rather than",
    "quietly running nothing. A check that consumes another check's",
    "measurements declares it (`needs` in --list) and pulls it in automatically.",
    "POOLSIDE_LIVE_SKIP_COSTLY=1 still works and means the same as --free.",
  ].join("\n");
}
