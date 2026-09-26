/**
 * Provider assembly.
 *
 * Split out of `index.ts` so it loads under plain Node (and `node --test`):
 * everything here resolves through pi-ai's core entrypoint. The one symbol that
 * does not — `openAICompletionsApi`, which pi's extension loader serves from the
 * compat entrypoint — is injected by `index.ts` instead of imported here.
 */

import {
  createProvider,
  envApiKeyAuth,
  type ApiKeyAuth,
  type Provider,
  type ProviderStreams,
} from "@earendil-works/pi-ai";
import { fetchPoolsideModels } from "./discovery.ts";
import { buildModels, DEFAULT_BASE_URL, PROVIDER_ID, type GatewayApi } from "./models.ts";

export const API_KEY_AUTH_NAME = "Poolside API key";
export const API_KEY_ENV_VAR = "POOLSIDE_API_KEY";
export const BASE_URL_ENV_VAR = "POOLSIDE_BASE_URL";

type EnvReader = (name: string) => string | undefined;

const processEnv: EnvReader = (name) =>
  typeof process !== "undefined" ? process.env?.[name] : undefined;

/** Endpoint override for a proxy, a mirror, or a self-managed Poolside endpoint. */
export function resolveBaseUrl(env: EnvReader = processEnv): string {
  const trimmed = env(BASE_URL_ENV_VAR)?.trim().replace(/\/+$/, "");
  return trimmed ? trimmed : DEFAULT_BASE_URL;
}

export type KeyProbeResult = "valid" | "invalid" | "unknown";

/**
 * The model id the key probe asks for. It does not exist, which is the point:
 * this gateway validates the request body *before* the key and the model id
 * *after* it, so a structurally valid request for an unknown id is answered
 * `404` for a good key and `403` for a wrong one — both pre-inference, both free.
 */
export const KEY_PROBE_MODEL_ID = "poolside/key-probe-nonexistent";

/**
 * Zero-inference key check.
 *
 * **The obvious probe does not work here, and that was measured.** The generic
 * recipe ("`POST` an empty body — a `400` means the key authenticated") returns
 * `400 {"error":"Invalid request body"}` for *any* key, good or bad
 * (`research/raw/badkey-empty-body.txt`: a bogus key plus `{}` is a **400**, not
 * a 403). Taking that 400 as "the key is valid" would accept a wrong key and save
 * it, which is a `/login` that silently does the opposite of its job.
 *
 * What the gateway does instead, measured 2026-09-26:
 *
 * | request | good key | wrong key |
 * |---|---|---|
 * | `{}` | 400 `Invalid request body` | **400** `Invalid request body` |
 * | valid shape, unknown model | 404 `please check the model you provided` | **403** `please check the api-key you provided` |
 * | valid shape, `max_tokens: 99999999` | 400 range error | **403** |
 * | valid shape, real model | 200 (billed) | **403** |
 *
 * So the body is parsed first, then the key, then the model and the ranges. The
 * probe therefore sends a **structurally valid** request for an id that cannot
 * exist: `404` means the key was accepted and no inference happened, `401`/`403`
 * mean the key was not. `max_tokens: 1` bounds the worst case — if a future
 * gateway ever accepted an unknown id, this could produce a single token rather
 * than nothing.
 *
 * `/models` is deliberately **not** used for the check even though it is the
 * cheaper call: `GET /models` with a wrong key answers 403 and then **resets the
 * stream**, so the body never arrives and the status alone would have to be
 * trusted through a transport error.
 *
 * A network failure returns `"unknown"`, never `"invalid"`: `/login` must still
 * work offline, and a flaky gateway must not make a good key look bad.
 */
export async function probeKey(
  key: string,
  baseUrl: string = DEFAULT_BASE_URL,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 8_000,
): Promise<KeyProbeResult> {
  try {
    const response = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: KEY_PROBE_MODEL_ID,
        messages: [{ role: "user", content: "key check" }],
        max_tokens: 1,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 401 || response.status === 403) return "invalid";
    return "valid";
  } catch {
    return "unknown";
  }
}

/**
 * Stored-key-then-env resolution with whitespace trimming on both paths.
 *
 * The trimming is load-bearing here in a specific way: an *empty* value produces
 * `Authorization: Bearer ` with nothing after it, and this gateway's front proxy
 * answers that with a deterministic **502 HTML page** rather than an auth error
 * (measured 4/4 attempts, `research/raw/listing-empty-auth.txt`). Without the
 * trim guard a key that resolved to whitespace would look like a broken gateway
 * instead of a missing key.
 */
export function poolsideApiKeyAuth(
  baseUrl: () => string = () => resolveBaseUrl(),
  fetchImpl: typeof fetch = fetch,
): ApiKeyAuth {
  const base = envApiKeyAuth(API_KEY_AUTH_NAME, [API_KEY_ENV_VAR]);
  return {
    ...base,

    async login(interaction) {
      interaction.signal.throwIfAborted();
      interaction.notify({
        type: "info",
        message:
          "Paste a Poolside API key (`sky_…`, from platform.poolside.ai). It is checked with a " +
          "request for a model id that cannot exist, which the gateway rejects before inference " +
          "— so no tokens are generated either way.",
      });
      const entered = await interaction.prompt({
        type: "secret",
        message: API_KEY_AUTH_NAME,
        placeholder: "sky_...",
      });
      interaction.signal.throwIfAborted();
      const key = entered.trim();
      if (!key) throw new Error("No API key entered.");
      if (!key.startsWith("sky_")) {
        // Warn, don't reject: `sky_` is the shape of the issued key as measured,
        // not a documented contract.
        interaction.notify({
          type: "info",
          message: "That does not look like a Poolside key (expected sky_…). Checking it anyway.",
        });
      }
      const probe = await probeKey(key, baseUrl(), fetchImpl);
      if (probe === "invalid") {
        throw new Error(
          "The gateway rejected this key (403 `please check the api-key you provided`). " +
            "Nothing was saved.",
        );
      }
      if (probe === "unknown") {
        interaction.notify({
          type: "info",
          message: "Could not reach the gateway to check the key (offline?). Saving it anyway.",
        });
      }
      return { type: "api_key", key };
    },

    async resolve(input) {
      const resolved = await base.resolve(input);
      const key = resolved?.auth.apiKey?.trim();
      // An empty key must resolve to *unconfigured*: pi would otherwise send an
      // empty `Bearer` and the front proxy's 502 HTML page would be read as a
      // gateway outage.
      if (!resolved || !key) return undefined;
      return { ...resolved, auth: { ...resolved.auth, apiKey: key } };
    },
  };
}

/**
 * Build the `poolside` provider.
 *
 * `models` is the frozen listing (always present, never network-dependent).
 * `fetchModels` layers live discovery on top: pi merges the overlay per id,
 * persists it through its own ModelsStore and restores it offline, so a new id
 * appears without a plugin release while a failed listing degrades to the
 * baseline.
 *
 * Only the `openai-completions` surface is registered. `POST /v1/messages`
 * (Anthropic shape) and `POST /v1/responses` both answered 200 when probed —
 * deliberately not registered, with the reasoning in README § Surfaces.
 */
export function buildPoolsideProvider(
  api: ProviderStreams,
  baseUrl: string = resolveBaseUrl(),
): Provider<GatewayApi> {
  return createProvider<GatewayApi>({
    id: PROVIDER_ID,
    name: "Poolside",
    baseUrl,
    auth: { apiKey: poolsideApiKeyAuth() },
    models: buildModels(baseUrl),
    fetchModels: (context) => fetchPoolsideModels(baseUrl, context),
    api: { "openai-completions": api },
  });
}
