/**
 * Live model discovery — the dynamic half of the catalog.
 *
 * `GET /v1/models` is authenticated and rich (see `catalog.ts`), so unlike a
 * bare-id listing this overlay can read the *same* fields the frozen catalog was
 * transcribed from: `context_length`, `max_completion_tokens`,
 * `input_modalities`, `supported_features`. An id that appears later therefore
 * arrives with its own advertised limits and capabilities rather than with
 * numbers invented here — one merge policy, shared with `parseListing`.
 *
 * The overlay is additive and unknowns-only:
 *
 *  - a **frozen id keeps its frozen entry**, so a listing cannot shadow a later
 *    catalog fix, and pi's persisted overlay cannot freeze today's numbers into
 *    the store;
 *  - a **new id is added** with its listing-supplied fields;
 *  - a non-text id (no `text` in `input_modalities`) is **skipped**: this
 *    gateway serves only chat ids today (its `/v1/embeddings` route answers
 *    `404 Model not found`, and no embedding model is listed), and the guard is
 *    read from the listing rather than guessed from an id's name;
 *  - a failed, empty or keyless listing returns `[]`, leaving the baseline
 *    intact — an offline start degrades to "static catalog", never to "broken
 *    provider".
 *
 * `GET /models` with a wrong key is a 403 **whose body never arrives** (the
 * server resets the stream; see `test/fixtures/error-bodies.json`
 * `bad-key-listing`). That is another reason this function keys off
 * `response.ok` and never inspects the body of a failure.
 */

import type { RefreshModelsContext } from "@earendil-works/pi-ai";
import { CATALOG_BY_ID, parseListing, type CatalogEntry } from "./catalog.ts";
import { entryToModel, type PoolsideModel } from "./models.ts";

/**
 * Overlay for ids the frozen catalog does not know.
 *
 * `known` is injectable so the offline suite can exercise the merge policy
 * without touching the real catalog.
 */
export function buildOverlay(
  entries: readonly CatalogEntry[],
  baseUrl: string,
  known: ReadonlySet<string> = new Set(CATALOG_BY_ID.keys()),
): PoolsideModel[] {
  return entries
    .filter((entry) => !known.has(entry.id))
    .filter((entry) => entry.input.includes("text"))
    .map((entry) => entryToModel(entry, baseUrl));
}

/** Resolve the effective key: refresh credential first, then the env var. Both trimmed. */
export function resolveDiscoveryKey(
  context: RefreshModelsContext,
  env: (name: string) => string | undefined = (name) => process.env[name],
  envVar = "POOLSIDE_API_KEY",
): string | undefined {
  const fromCredential =
    context.credential?.type === "api_key" ? context.credential.key?.trim() : undefined;
  if (fromCredential) return fromCredential;
  const fromEnv = env(envVar)?.trim();
  return fromEnv || undefined;
}

/**
 * `fetchModels` implementation. Never throws: `[]` leaves the curated baseline
 * (and any previously persisted overlay) untouched.
 */
export async function fetchPoolsideModels(
  baseUrl: string,
  context: RefreshModelsContext,
  timeoutMs = 8_000,
): Promise<PoolsideModel[]> {
  if (!context.allowNetwork || context.signal.aborted) return [];

  const key = resolveDiscoveryKey(context);
  if (!key) return [];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  context.signal.addEventListener("abort", onAbort, { once: true });

  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: controller.signal,
    });
    if (!response.ok) return [];
    return buildOverlay(parseListing(await response.json()), baseUrl);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
    context.signal.removeEventListener("abort", onAbort);
  }
}
