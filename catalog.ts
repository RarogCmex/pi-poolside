/**
 * Catalog for the **Poolside inference API** (`https://inference.poolside.ai/v1`).
 *
 * This is the rare case where the catalog's numbers are *sourced* rather than
 * probed: `GET /v1/models` returns full metadata for each model — window,
 * output cap, modalities, `supported_features`, quantization, description, and a
 * `pricing` object whose every value is the string `"0"`. The listing is frozen
 * here with its date and kept byte-identical in `test/fixtures/listing.json`
 * (generated from `research/raw/listing.txt`, measured 2026-09-26), so the
 * offline suite fails loudly if the plugin's copy and the recorded snapshot
 * disagree.
 *
 * **Two traps live in that listing and both are documented in `models.ts`:**
 *  - the output cap is *named* `max_completion_tokens` there, but the request
 *    field is `max_tokens` (measured: sending both is rejected with
 *    `max_completion_tokens (8): Extra inputs are not permitted`);
 *  - `supported_features: ["tools", "reasoning"]` is what makes `reasoning` true
 *    below — and `reasoning` is load-bearing for `thinkingFormat:
 *    "chat-template"` and `requiresReasoningContentOnAssistantMessages`, both of
 *    which pi only applies when `model.reasoning` is set
 *    (`api/openai-completions.js:645-650`, `:1044-1047` in pi-ai 0.87.1).
 *
 * Prices are zero because the provider says so (`pricing: {"prompt": "0",
 * "completion": "0", …}`), not because a price is unknown — the one case where
 * `$0` is a measurement rather than a fallback.
 */

/**
 * The gateway speaks OpenAI chat-completions. `POST /v1/messages` (Anthropic
 * shape) and `POST /v1/responses` both answered **200** when probed
 * (`research/raw/messages-surface.txt`, `responses-surface.txt`) and are
 * deliberately not registered — see README § Surfaces.
 */
export type GatewayApi = "openai-completions";

/** Frozen date of the listing this catalog was transcribed from. */
export const LISTING_SNAPSHOT_DATE = "2026-09-26";

export interface CatalogEntry {
  /** Exact gateway model id, `poolside/…` (the listing uses the vendor prefix). */
  id: string;
  name: string;
  /** From the listing's `context_length` (identical for both ids: 262 144). */
  contextWindow: number;
  /**
   * Output cap, from the listing's **`max_completion_tokens`** field — the
   * listing's name for it, which is *not* the request field name. See
   * `models.ts` `MAX_TOKENS_FIELD`.
   */
  maxTokens: number;
  /** From the listing's `input_modalities`. */
  input: ("text" | "image")[];
  /**
   * True when the listing's `supported_features` contains `"reasoning"`. This
   * means "pi may control this model's thinking", which the documentation
   * confirms (thinking is on by default and `chat_template_kwargs
   * .enable_thinking: false` turns it off).
   */
  reasoning: boolean;
  /** Whether tools are advertised for this id (`supported_features`). */
  tools: boolean;
  /** `quantization` from the listing — informational, and it differs per id. */
  quantization: string;
  /** The listing's own `description`, verbatim. */
  description: string;
  /** Where every number above came from. Only one kind exists on this provider. */
  provenance: "listing";
  /** Free-text note carried into pi's `Model` (which has no notes field). */
  priceNote: string;
}

const ZERO_PRICE_NOTE =
  "priced by the listing: every value in its `pricing` object is the string \"0\"; the free key bills $0.00";

/** The two ids in the frozen listing, with the listing's own values. */
const LISTED: readonly Omit<CatalogEntry, "provenance" | "priceNote">[] = [
  {
    id: "poolside/laguna-xs-2.1",
    name: "Laguna XS 2.1",
    contextWindow: 262_144,
    maxTokens: 32_768,
    input: ["text"],
    reasoning: true,
    tools: true,
    quantization: "fp8",
    description: "Our lightest and fastest agentic coding model.",
  },
  {
    id: "poolside/laguna-s-2.1",
    name: "Laguna S 2.1",
    contextWindow: 262_144,
    maxTokens: 32_768,
    input: ["text"],
    reasoning: true,
    tools: true,
    quantization: "fp4",
    description: "Our most capable model. Frontier-class reasoning at mid-size cost.",
  },
];

export const CATALOG: readonly CatalogEntry[] = LISTED.map((entry) => ({
  ...entry,
  provenance: "listing" as const,
  priceNote: ZERO_PRICE_NOTE,
}));

export const CATALOG_BY_ID: ReadonlyMap<string, CatalogEntry> = new Map(
  CATALOG.map((entry) => [entry.id, entry]),
);

/**
 * Cap for an id discovered live that the frozen listing does not contain.
 *
 * **The window is not guessed down and the cap is not guessed up.** Both numbers
 * are the listing's own values for the only two ids that exist today, so an
 * unknown id inherits the family's *advertised* limits rather than a floor
 * invented here. That is the honest reading: the gateway has published exactly
 * one shape of model metadata, and a new id from the same listing endpoint will
 * carry its own `context_length`/`max_completion_tokens` — which
 * `discovery.ts` prefers whenever the listing supplies them.
 *
 * If a future listing omits them, these are what the id gets, and
 * `test/discovery.test.ts` pins that fallback.
 */
export const UNKNOWN_MODEL_FALLBACK = {
  contextWindow: 262_144,
  maxTokens: 32_768,
} as const;

// --- reading the listing -----------------------------------------------------

/** One entry of the recorded `GET /models` body, as far as this plugin reads it. */
interface ListingModel {
  id?: unknown;
  name?: unknown;
  description?: unknown;
  quantization?: unknown;
  context_length?: unknown;
  max_completion_tokens?: unknown;
  input_modalities?: unknown;
  supported_features?: unknown;
  is_free?: unknown;
  pricing?: unknown;
}

const asString = (value: unknown, fallback = ""): string =>
  typeof value === "string" && value.trim() ? value.trim() : fallback;

const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;

const asStringArray = (value: unknown): string[] | undefined =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : undefined;

/**
 * Turn a `GET /v1/models` body into catalog entries.
 *
 * **The same parser feeds the frozen catalog's provenance test and the live
 * discovery overlay**, so an id that appears later is described by the same
 * fields as the two ids frozen on 2026-09-26 — one merge policy, not two. Only
 * fields the listing actually carries are read; nothing is inferred from an id's
 * name.
 *
 * Pure and total: a malformed entry is skipped rather than throwing, because a
 * discovery overlay must never be able to break pi's startup.
 */
export function parseListing(payload: unknown): CatalogEntry[] {
  if (typeof payload !== "object" || payload === null) return [];
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];

  const entries: CatalogEntry[] = [];
  const seen = new Set<string>();
  for (const raw of data) {
    if (typeof raw !== "object" || raw === null) continue;
    const model = raw as ListingModel;
    const id = asString(model.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const features = asStringArray(model.supported_features) ?? [];
    const modalities = asStringArray(model.input_modalities) ?? ["text"];
    const input = modalities.filter((m): m is "text" | "image" => m === "text" || m === "image");

    entries.push({
      id,
      name: asString(model.name, id),
      contextWindow: asNumber(model.context_length) ?? UNKNOWN_MODEL_FALLBACK.contextWindow,
      maxTokens: asNumber(model.max_completion_tokens) ?? UNKNOWN_MODEL_FALLBACK.maxTokens,
      input: input.length > 0 ? input : ["text"],
      reasoning: features.includes("reasoning"),
      tools: features.includes("tools"),
      quantization: asString(model.quantization, "unlisted"),
      description: asString(model.description),
      provenance: "listing",
      priceNote:
        model.pricing === undefined ? "the listing carried no `pricing` object" : ZERO_PRICE_NOTE,
    });
  }
  return entries;
}

/** `is_free` for one id in a listing body; `undefined` when the listing omits it. */
export function listingIsFree(payload: unknown, id: string): boolean | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return undefined;
  for (const raw of data) {
    if (typeof raw !== "object" || raw === null) continue;
    const model = raw as ListingModel;
    if (asString(model.id) === id) return model.is_free === true;
  }
  return undefined;
}
