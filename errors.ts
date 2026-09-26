/**
 * Error layer for the Poolside inference API.
 *
 * ## Three dialects, all measured (`research/raw/*.txt`, 2026-09-26)
 *
 * | case | status | body | shape |
 * |---|---|---|---|
 * | `GET /models` with **no `Authorization` header at all** | **401** | `No Authorization header provided` | `text/plain` |
 * | wrong key (`POST /chat/completions`) | **403** | `{"error":"please check the api-key you provided"}` | `error` is a **string** |
 * | unknown model id | **404** | `{"error":"please check the model you provided"}` | string again |
 * | `{}` body | **400** | `{"error":"Invalid request body"}` | string again |
 * | `max_tokens` over the cap | **400** | `{"error":{"code":400,"message":"Invalid request: ['max_tokens (99999999): Input should be less than or equal to 262144']","type":"Bad Request"}}` | enveloped |
 * | `temperature: 3` | **400** | `{"error":{"code":400,"message":"Validation: Temperature must be between 0 and 2, got 3","type":"Bad Request"}}` | enveloped |
 * | `Authorization: Bearer ` (empty value) | **502** | HTML `<title>502 Server Error</title>` (the front proxy, not the API) | HTML |
 *
 * **401 and 403 are not the same diagnosis here, and neither is the usual one:**
 * this gateway names the *missing header* in 401 and the *wrong key* in 403 — the
 * reverse of the arrangement some other providers use. Copying another plugin's
 * wording would tell a user with a good key to re-authenticate. The plugin says
 * which is which, from the bodies above.
 *
 * ## Why `withBodyRecovery` is here (and it is *measured*, not assumed)
 *
 * `test/errors.test.ts` drives pi-ai's real adapter with these exact recorded
 * bodies and asserts what pi would print with and without the wrapper. The
 * OpenAI SDK composes `APIError` messages from the body's `error` key alone
 * (`openai` `core/error.js`), so the two shapes that carry their text somewhere
 * else — the HTML 502 and the plain-text 401 — lose it, and pi's fallback prints
 * the generic sentence instead of the gateway's words. The wrapper re-emits a
 * non-OK body as `text/plain` so the SDK's text path carries the message; that
 * turns several dialects into one `<status> <text>` form the parser below reads
 * once.
 *
 * Nothing is rewritten that was not recorded: there is **no overflow rewrite**
 * on this provider, because no overflow rejection was ever measured here — see
 * README § "What remains unverified" for the free probe that would settle it.
 */

import type { ProviderStreams } from "@earendil-works/pi-ai";
import { PROVIDER_ID } from "./models.ts";

/** Prefix marking a message this module already rewrote, so rewrites are idempotent. */
const SENTINEL = "poolside:";

/**
 * No key-management URL is printed anywhere in this plugin: the console address
 * in the docs (`platform.poolside.ai`, the page the key is created on) was read
 * but never fetched, and a wrong URL in an auth error is worse than none. The
 * measured 401 body names nothing but the header.
 */
export const AUTH_HELP = `run \`/login ${PROVIDER_ID}\` or set \`POOLSIDE_API_KEY\``;

// --- measured shapes ---------------------------------------------------------

/** 401 `No Authorization header provided` (text/plain). */
const NO_AUTH_HEADER_RE = /no authorization header provided/i;

/** 403/404 `please check the api-key you provided`. */
const BAD_KEY_RE = /please check the api-?key you provided/i;

/** 404 `please check the model you provided`. */
const UNKNOWN_MODEL_RE = /please check the model you provided/i;

/** 400 `Extra inputs are not permitted` — the `max_completion_tokens` trap. */
const EXTRA_INPUTS_RE = /extra inputs are not permitted/i;

/** 400 `Input should be less than or equal to 262144`. */
const MAX_TOKENS_RANGE_RE = /input should be less than or equal to \d+/i;

/** 400 `Invalid request body` — the `{}` body. */
const INVALID_BODY_RE = /invalid request body/i;

/** 502 from the front proxy: HTML, so the status text is all the gateway says. */
const PROXY_HTML_RE = /<html|502 server error|<title>\s*502/i;

/**
 * Veto list for any future overflow work, taken from pi-ai's own
 * `NON_OVERFLOW_PATTERNS`: a throttle must never be laundered into a compaction
 * trigger. It is applied by `isRewriteSafe` below, which the offline suite
 * asserts against pi's real classifiers.
 */
const RATE_LIMIT_RE = /\brate.?limit\b|too many requests|throttl|\b429\b/i;

// --- parsing -----------------------------------------------------------------

export interface ParsedGatewayError {
  /** HTTP status parsed from the leading `<status>[ :]` token, when present. */
  status?: number;
  /** Human-readable cause, or the remaining raw text when no shape matched. */
  message: string;
  /** The original, unchanged message. */
  raw: string;
}

/** Pull a cause out of an already-parsed JSON body, covering all recorded shapes. */
function messageFromBody(parsed: unknown): string | undefined {
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const body = parsed as Record<string, unknown>;
  // The string dialect: `{"error":"please check the api-key you provided"}`.
  if (typeof body.error === "string" && body.error.trim()) return body.error.trim();
  // The enveloped dialect: `{"error":{"code":400,"message":"…","type":"Bad Request"}}`.
  if (typeof body.error === "object" && body.error !== null) {
    const inner = (body.error as Record<string, unknown>).message;
    if (typeof inner === "string" && inner.trim()) return inner.trim();
  }
  if (typeof body.message === "string" && body.message.trim()) return body.message.trim();
  return undefined;
}

/** Strip an HTML body down to its readable text (the 502 page). */
export function htmlToText(html: string): string {
  const title = /<title>([^<]*)<\/title>/i.exec(html)?.[1]?.trim();
  const headings = [...html.matchAll(/<h[12][^>]*>([\s\S]*?)<\/h[12]>/gi)]
    .map((m) => m[1].replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const parts = [title, ...headings].filter(Boolean);
  return [...new Set(parts)].join(" — ").slice(0, 300);
}

/**
 * Split pi's composed `<status>[ :] <body>` message into status and cause.
 *
 * The body may be JSON (either dialect), verbatim HTML, or plain text.
 */
export function parseGatewayError(errorMessage: string): ParsedGatewayError {
  const raw = errorMessage;
  let rest = errorMessage.trim();
  let status: number | undefined;

  const head = /^(\d{3})\s*:?\s*/.exec(rest);
  if (head) {
    status = Number(head[1]);
    rest = rest.slice(head[0].length).trim();
  }

  if (rest.startsWith("<") && PROXY_HTML_RE.test(rest)) {
    return { status, message: htmlToText(rest), raw };
  }

  if (rest.startsWith("{")) {
    try {
      const message = messageFromBody(JSON.parse(rest));
      if (message) return { status, message, raw };
    } catch {
      // Truncated body — fall through to the raw text.
    }
  }

  // The bare SDK form of the string dialect: the OpenAI SDK wraps a JSON string
  // body, so `{"error":"…"}` reaches pi as `403 "please check the api-key you
  // provided"` — a JSON *string*, quotation marks included. Body recovery
  // removes the quotes, but the parser accepts both shapes so the clarification
  // never silently depends on the wrapper being installed.
  if (rest.startsWith('"') && rest.endsWith('"') && rest.length > 1) {
    try {
      const parsed = JSON.parse(rest);
      if (typeof parsed === "string" && parsed.trim()) {
        return { status, message: parsed.trim(), raw };
      }
    } catch {
      // Not a JSON string after all.
    }
  }

  return { status, message: rest, raw };
}

/**
 * Extract a human message from a raw non-OK response body, for the recovery
 * wrapper. Returns undefined when there is nothing worth substituting, in which
 * case the response is passed through untouched.
 */
export function extractGatewayMessage(body: string): string | undefined {
  const trimmed = body.trim();
  if (!trimmed) return undefined;

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const message = messageFromBody(JSON.parse(trimmed));
      if (message) return message;
    } catch {
      // Not JSON after all.
    }
    return undefined;
  }

  if (trimmed.startsWith("<")) {
    const text = htmlToText(trimmed);
    return text || undefined;
  }

  const firstLine = trimmed.split(/\r?\n/, 1)[0].trim();
  // A body with no words at all carries no message: pass it through untouched
  // rather than replacing it with itself.
  if (!firstLine || !/[a-z0-9]/i.test(firstLine)) return undefined;
  return firstLine.slice(0, 300);
}

// --- body recovery -----------------------------------------------------------

/**
 * Re-emit a non-OK response body as `text/plain` so the OpenAI SDK's error
 * message stops dropping it. A successful response is returned untouched, as is
 * a non-OK response whose body carries no usable message.
 */
export async function recoverErrorBody(response: Response): Promise<Response> {
  if (response.ok) return response;
  let body: string;
  try {
    // clone() so the original stream stays intact if we decide not to replace it.
    body = await response.clone().text();
  } catch {
    return response;
  }
  const message = extractGatewayMessage(body);
  if (!message) return response;
  // Preserve the original headers (request ids, retry hints) — only the encoding changes.
  const headers = new Headers(response.headers);
  headers.set("content-type", "text/plain; charset=utf-8");
  return new Response(message, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

const BODY_RECOVERY_MARK = Symbol.for("pi-poolside.bodyRecovery");

/** Wrap a fetch so every non-OK response gets the recovery treatment. Idempotent and chaining. */
export function withBodyRecovery(inner?: typeof fetch): typeof fetch {
  const base = inner ?? globalThis.fetch;
  if ((base as unknown as Record<symbol, unknown>)?.[BODY_RECOVERY_MARK]) return base;
  const wrapped = (async (input: RequestInfo | URL, init?: RequestInit) =>
    recoverErrorBody(await base(input, init))) as typeof fetch;
  Object.defineProperty(wrapped, BODY_RECOVERY_MARK, { value: true, enumerable: false });
  return wrapped;
}

/**
 * Apply the fetch recovery to a registered api surface. pi passes its own
 * `fetch` per call; we chain onto it rather than replacing it, and preserve
 * every other option field (`onPayload`, `onResponse`, `maxRetries`, …).
 */
export function withBodyRecoveryApi(api: ProviderStreams): ProviderStreams {
  const wrapped: ProviderStreams = {
    stream: (model, context, options) =>
      api.stream(model, context, { ...options, fetch: withBodyRecovery(options?.fetch) }),
    streamSimple: (model, context, options) =>
      api.streamSimple(model, context, { ...options, fetch: withBodyRecovery(options?.fetch) }),
  };
  if (api.fetchDeferred) wrapped.fetchDeferred = api.fetchDeferred;
  if (api.cancelDeferred) wrapped.cancelDeferred = api.cancelDeferred;
  return wrapped;
}

// --- readable rewrites -------------------------------------------------------

/** True when a message is safe to rewrite (not a throttle, non-empty). */
export function isRewriteSafe(errorMessage: string): boolean {
  return Boolean(errorMessage) && !RATE_LIMIT_RE.test(errorMessage);
}

/**
 * Turn a recorded Poolside failure into an actionable sentence, or return
 * undefined when the shape is not one this build measured.
 *
 * The 401/403 distinction is the point of this function (see the module
 * comment), and the `max_completion_tokens` case exists because that trap is
 * invisible from pi's side: the user sees a schema error while the *listing*
 * tells them the field is correct.
 */
export function clarifyPoolsideError(errorMessage: string): string | undefined {
  if (!isRewriteSafe(errorMessage) || errorMessage.startsWith(SENTINEL)) return undefined;
  const { status, message, raw } = parseGatewayError(errorMessage);
  const both = `${message} ${raw}`;

  if (NO_AUTH_HEADER_RE.test(both)) {
    return (
      `${SENTINEL} no API key was sent — the gateway answered HTTP 401 ` +
      "`No Authorization header provided`. That is not a rejected key, it is a missing " +
      `one: ${AUTH_HELP} and check for a trailing newline in the pasted value. ` +
      "(A key that is present but wrong is answered differently — 403.)"
    );
  }

  if (BAD_KEY_RE.test(both)) {
    return (
      `${SENTINEL} the gateway rejected the key with HTTP 403 ` +
      "`please check the api-key you provided` (note: 403 here means *wrong key*, not a " +
      `missing one and not an entitlement). ${AUTH_HELP}, and strip any trailing newline. ` +
      "Original: " +
      message
    );
  }

  if (UNKNOWN_MODEL_RE.test(both)) {
    return (
      `${SENTINEL} the gateway does not know that model id (HTTP ${status ?? 404}). ` +
      "Only the ids in `GET /v1/models` work — see the plugin's catalog — and a discovery " +
      "overlay may have persisted an id the gateway has since retired. Original: " +
      message
    );
  }

  if (EXTRA_INPUTS_RE.test(both)) {
    return (
      `${SENTINEL} HTTP ${status ?? 400}: the request carried a field this API does not ` +
      "accept. On this gateway the usual cause is `max_completion_tokens`: the `/v1/models` " +
      "listing *names* the output cap that way, but the request field is `max_tokens` " +
      "(sending the listing's name is rejected with `Extra inputs are not permitted`). " +
      "This plugin pins `compat.maxTokensField: \"max_tokens\"`; a hand-written " +
      "`models.json` entry for the same provider does not. Original: " +
      message
    );
  }

  if (MAX_TOKENS_RANGE_RE.test(both)) {
    return (
      `${SENTINEL} HTTP ${status ?? 400}: \`max_tokens\` is outside the documented range ` +
      "1..262144 for this model. The ceiling is disclosed by the rejection itself. Original: " +
      message
    );
  }

  if (INVALID_BODY_RE.test(both)) {
    return (
      `${SENTINEL} the gateway could not parse the request body (HTTP ${status ?? 400}), ` +
      "which is what an empty body gets — the same rejection this plugin's `/login` uses as a " +
      "zero-inference key check. Original: " +
      message
    );
  }

  if (status === 502 && PROXY_HTML_RE.test(raw)) {
    return (
      `${SENTINEL} HTTP 502 from the front proxy, not from the model API: the proxy answered ` +
      "with an HTML error page. Measured trigger: an `Authorization: Bearer ` header with an " +
      "**empty** value (deterministic, 4/4 attempts) — i.e. a key that resolved to nothing. " +
      `${AUTH_HELP} and make sure the value is non-empty. Original: ${message}`
    );
  }

  return undefined;
}

/** True when an assistant message is a Poolside failure worth rewriting. */
export function shouldClarify(message: {
  role: string;
  stopReason?: string;
  provider?: string;
  errorMessage?: string;
}): boolean {
  return (
    message.role === "assistant" &&
    message.stopReason === "error" &&
    message.provider === PROVIDER_ID &&
    typeof message.errorMessage === "string" &&
    clarifyPoolsideError(message.errorMessage) !== undefined
  );
}

/**
 * Whether the failure should also leave a persistent TUI note: the states a
 * human has to act on (no key at all, wrong key, unknown model). Called from
 * `turn_end`, which runs *after* `message_end` may already have replaced the text
 * with a sentinel-prefixed sentence, so both inputs are accepted.
 */
export function needsPersistentHelp(errorMessage: string): boolean {
  if (!errorMessage) return false;
  const text = errorMessage.startsWith(SENTINEL)
    ? errorMessage
    : `${parseGatewayError(errorMessage).message} ${errorMessage}`;
  return (
    NO_AUTH_HEADER_RE.test(text) || BAD_KEY_RE.test(text) || UNKNOWN_MODEL_RE.test(text) ||
    (/\b502\b/.test(text) && PROXY_HTML_RE.test(text))
  );
}
