/**
 * Build-time probe helper (NOT part of the plugin, NOT part of `npm test`).
 *
 * Runs one named probe, writes the verbatim response body to
 * `research/raw/<name>.txt` and prints one ledger row per HTTP attempt.
 *
 * Two rules this harness exists to enforce, both learned the hard way in this
 * repo (pitfalls L1 "the probe measures the harness", L35 "the probe you were
 * sure was free was billed"):
 *
 *  1. **"No Authorization header" means the header is absent**, not present with
 *     an empty value and not silently replaced by the default key. An earlier
 *     version of this file collapsed `auth: null` into `undefined` and made
 *     `GET /models` look like it answered 200 without a key; the recorded
 *     fixture was a lie about the provider. The header is now built by
 *     `buildHeaders()` and covered by `test/probe-harness.test.ts`.
 *  2. **A 5xx is retried and never recorded as a finding.** A 500
 *     `{"error":"internal server error"}` after ~5 s is the upstream being
 *     busy, not the API's behaviour for a bad key; only deterministic 4xx /
 *     2xx bodies are written to `research/raw/`.
 *
 *   node live/probe.ts <name>
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";

const DEFAULT_BASE = "https://inference.poolside.ai/v1";

function loadEnv(): { key: string; base: string } {
  const text = readFileSync(new URL("../secret.env", import.meta.url), "utf8");
  const env: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  const key = process.env.POOLSIDE_API_KEY?.trim() || env.POOLSIDE_API_KEY?.trim();
  const base = (
    process.env.POOLSIDE_BASE_URL?.trim() ||
    env.POOLSIDE_BASE_URL?.trim() ||
    DEFAULT_BASE
  ).replace(/\/+$/, "");
  if (!key) throw new Error("POOLSIDE_API_KEY missing");
  return { key, base };
}

/**
 * Build the request headers for one probe.
 *
 * `authMode` is the whole point of this function:
 *  - `"key"`    — `Authorization: Bearer <key>`;
 *  - `"absent"` — **no `Authorization` header at all** (the true
 *    "no Authorization header provided" case);
 *  - `"empty"`  — `Authorization: Bearer ` with nothing after it;
 *  - `"literal"`— a caller-supplied header value (bogus / mangled key).
 *
 * Exported so the offline suite can assert the absent case really is absent.
 */
export type AuthMode = "key" | "absent" | "empty" | "literal";

export function buildHeaders(
  authMode: AuthMode,
  key: string,
  literal?: string,
): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  switch (authMode) {
    case "key":
      headers.Authorization = `Bearer ${key}`;
      break;
    case "absent":
      break;
    case "empty":
      headers.Authorization = "Bearer ";
      break;
    case "literal":
      headers.Authorization = `Bearer ${literal ?? ""}`;
      break;
  }
  return headers;
}

interface Probe {
  path: string;
  method?: "GET" | "POST";
  body?: unknown;
  authMode: AuthMode;
  authLiteral?: string;
  note: string;
}

const PROBES: Record<string, Probe> = {
  listing: { path: "/models", authMode: "key", note: "GET /models with the key" },
  "listing-noauth": {
    path: "/models",
    authMode: "absent",
    note: "GET /models with NO Authorization header at all",
  },
  "listing-empty-auth": {
    path: "/models",
    authMode: "empty",
    note: "GET /models with `Authorization: Bearer ` (empty value)",
  },
  "listing-badkey": {
    path: "/models",
    authMode: "literal",
    authLiteral: "sky_bogus_key_000000000000000000000000",
    note: "GET /models with a wrong key",
  },
  "badkey-chat": {
    path: "/chat/completions",
    method: "POST",
    authMode: "literal",
    authLiteral: "sky_bogus_key_000000000000000000000000",
    body: { model: "poolside/laguna-xs-2.1", messages: [{ role: "user", content: "hi" }], max_tokens: 8 },
    note: "chat with a wrong key",
  },
  "unknown-model": {
    path: "/chat/completions",
    method: "POST",
    authMode: "key",
    body: { model: "poolside/does-not-exist-xyz", messages: [{ role: "user", content: "hi" }], max_tokens: 8 },
    note: "unknown model id",
  },
  "max-tokens-too-big": {
    path: "/chat/completions",
    method: "POST",
    authMode: "key",
    body: { model: "poolside/laguna-xs-2.1", messages: [{ role: "user", content: "hi" }], max_tokens: 99999999 },
    note: "max_tokens above the advertised ceiling",
  },
  "max-completion-tokens-field": {
    path: "/chat/completions",
    method: "POST",
    authMode: "key",
    body: {
      model: "poolside/laguna-xs-2.1",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 8,
      max_completion_tokens: 8,
    },
    note: "max_completion_tokens sent alongside max_tokens",
  },
  "temperature-3": {
    path: "/chat/completions",
    method: "POST",
    authMode: "key",
    body: { model: "poolside/laguna-xs-2.1", messages: [{ role: "user", content: "hi" }], max_tokens: 8, temperature: 3 },
    note: "temperature out of range",
  },
  "empty-body": {
    path: "/chat/completions",
    method: "POST",
    authMode: "key",
    body: {},
    note: "empty JSON body (zero-inference key check)",
  },
  "messages-surface": {
    path: "/messages",
    method: "POST",
    authMode: "key",
    body: { model: "poolside/laguna-xs-2.1", max_tokens: 8, messages: [{ role: "user", content: "say ok" }] },
    note: "POST /v1/messages (Anthropic shape)",
  },
  "responses-surface": {
    path: "/responses",
    method: "POST",
    authMode: "key",
    body: { model: "poolside/laguna-xs-2.1", input: "say ok", max_output_tokens: 8 },
    note: "POST /v1/responses",
  },
  "embeddings-surface": {
    path: "/embeddings",
    method: "POST",
    authMode: "key",
    body: { model: "poolside/laguna-xs-2.1", input: "hello" },
    note: "POST /v1/embeddings",
  },
  root: { path: "/", authMode: "key", note: "GET /v1" },
  // --- tiny generations (billed, max_tokens <= 16 unless tool shape needs more) ---
  "gen-thinking-off": {
    path: "/chat/completions",
    method: "POST",
    authMode: "key",
    body: {
      model: "poolside/laguna-xs-2.1",
      messages: [{ role: "user", content: "say ok" }],
      max_tokens: 16,
      chat_template_kwargs: { enable_thinking: false },
    },
    note: "tiny generation, thinking off via chat_template_kwargs",
  },
  "gen-thinking-on": {
    path: "/chat/completions",
    method: "POST",
    authMode: "key",
    body: {
      model: "poolside/laguna-xs-2.1",
      messages: [{ role: "user", content: "say ok" }],
      max_tokens: 16,
      chat_template_kwargs: { enable_thinking: true },
    },
    note: "tiny generation, thinking on via chat_template_kwargs",
  },
  "gen-reasoning-effort-off": {
    path: "/chat/completions",
    method: "POST",
    authMode: "key",
    body: {
      model: "poolside/laguna-xs-2.1",
      messages: [{ role: "user", content: "say ok" }],
      max_tokens: 16,
      reasoning_effort: "none",
    },
    note: "reasoning_effort:none WITHOUT enable_thinking — does it really disable thinking?",
  },
  "stream-usage": {
    path: "/chat/completions",
    method: "POST",
    authMode: "key",
    body: {
      model: "poolside/laguna-xs-2.1",
      messages: [{ role: "user", content: "say ok" }],
      max_tokens: 16,
      stream: true,
      stream_options: { include_usage: true },
      chat_template_kwargs: { enable_thinking: false },
    },
    note: "SSE stream: usage placement per chunk",
  },
  "stream-usage-no-option": {
    path: "/chat/completions",
    method: "POST",
    authMode: "key",
    body: {
      model: "poolside/laguna-xs-2.1",
      messages: [{ role: "user", content: "say ok" }],
      max_tokens: 16,
      stream: true,
      chat_template_kwargs: { enable_thinking: false },
    },
    note: "SSE stream without stream_options: is usage still present?",
  },
  "tool-call": {
    path: "/chat/completions",
    method: "POST",
    authMode: "key",
    body: {
      model: "poolside/laguna-xs-2.1",
      messages: [{ role: "user", content: "What is the weather in Paris? Use the get_weather tool." }],
      max_tokens: 256,
      chat_template_kwargs: { enable_thinking: false },
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Look up the weather for a city.",
            parameters: {
              type: "object",
              properties: { city: { type: "string", description: "City name" } },
              required: ["city"],
            },
          },
        },
      ],
    },
    note: "tool round-trip (thinking off, max_tokens 256)",
  },
  "second-turn-echo": {
    path: "/chat/completions",
    method: "POST",
    authMode: "key",
    body: {
      model: "poolside/laguna-xs-2.1",
      max_tokens: 96,
      messages: [
        { role: "user", content: "What is 2+2? Think it through." },
        {
          role: "assistant",
          content: "4",
          reasoning_content: "The user asks 2+2. That is 4.",
        },
        { role: "user", content: "Now what is 3+3? Think it through." },
      ],
    },
    note: "second turn WITH reasoning_content echoed on the assistant message",
  },
  "second-turn-no-echo": {
    path: "/chat/completions",
    method: "POST",
    authMode: "key",
    body: {
      model: "poolside/laguna-xs-2.1",
      max_tokens: 96,
      messages: [
        { role: "user", content: "What is 2+2? Think it through." },
        { role: "assistant", content: "4" },
        { role: "user", content: "Now what is 3+3? Think it through." },
      ],
    },
    note: "second turn WITHOUT reasoning_content (the paired control)",
  },
};

/** A 5xx (or 429) is transient: retried, never recorded as a finding. */
export function isTransient(status: number): boolean {
  return status >= 500 || status === 429;
}

const { key, base } = loadEnv();
mkdirSync(new URL("../research/raw/", import.meta.url), { recursive: true });

/**
 * The gateway resets the HTTP/2 stream for some rejected requests (`GET /models`
 * with a wrong key produced `ERR_HTTP2_STREAM_ERROR ... NGHTTP2_INTERNAL_ERROR`
 * from undici's HTTP/2 fallback), and undici surfaces that as an *unhandled*
 * rejection outside the `fetch` promise chain. The probe must survive it and
 * keep retrying, so the error is recorded as an attempt rather than killing the
 * process — an unhandled rejection here used to destroy the whole probe run.
 */
const transportErrors: string[] = [];
process.on("unhandledRejection", (reason) => {
  transportErrors.push(String((reason as Error)?.message ?? reason));
  console.log(`  unhandled transport rejection: ${transportErrors.at(-1)?.slice(0, 160)}`);
});

const name = process.argv[2];
if (!name || !PROBES[name]) {
  console.log(`usage: node live/probe.ts <${Object.keys(PROBES).join("|")}>`);
  process.exit(2);
}
const probe = PROBES[name];

const ledger: { attempt: number; status: number; billed: boolean; ms: number }[] = [];
let recorded:
  | { status: number; text: string; contentType: string | null; ms: number; deterministic5xx: boolean }
  | undefined;
/** Bodies seen on transient attempts, so a *deterministic* 5xx can be told from a flaky one. */
const transientBodies: { status: number; text: string; contentType: string | null; ms: number }[] = [];

for (let attempt = 1; attempt <= 4; attempt++) {
  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(`${base}${probe.path}`, {
      method: probe.method ?? (probe.body === undefined ? "GET" : "POST"),
      headers: buildHeaders(probe.authMode, key, probe.authLiteral),
      ...(probe.body === undefined ? {} : { body: JSON.stringify(probe.body) }),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (error) {
    ledger.push({ attempt, status: -1, billed: false, ms: Date.now() - started });
    console.log(`[attempt ${attempt}] network error: ${(error as Error).message}`);
    await new Promise((r) => setTimeout(r, 2_000 * attempt));
    continue;
  }
  const text = await res.text().catch((error: Error) => `<<body read failed: ${error.message}>>`);
  const ms = Date.now() - started;
  ledger.push({ attempt, status: res.status, billed: res.ok, ms });
  console.log(`[attempt ${attempt}] HTTP ${res.status} (${ms} ms) content-type=${res.headers.get("content-type")}`);
  if (isTransient(res.status)) {
    transientBodies.push({ status: res.status, text, contentType: res.headers.get("content-type"), ms });
    console.log(`  transient ${res.status}, retrying: ${text.replace(/\s+/g, " ").slice(0, 120)}`);
    await new Promise((r) => setTimeout(r, 2_000 * attempt));
    continue;
  }
  recorded = { status: res.status, text, contentType: res.headers.get("content-type"), ms, deterministic5xx: false };
  break;
}

// A 5xx is only a *finding* when it is deterministic: every attempt returned the
// same status and the same body. A flaky 500 (`{"error":"internal server
// error"}` after ~5 s) is the upstream being busy and must never become a
// recorded fixture — that is how a phantom "bad key behaviour" was invented once.
if (!recorded) {
  const first = transientBodies[0];
  const deterministic =
    first !== undefined &&
    transientBodies.length === 4 &&
    transientBodies.every((a) => a.status === first.status && a.text === first.text);
  if (!deterministic) {
    console.log(`\n### ${name} — transient 5xx/429, not deterministic; nothing recorded.`);
    console.log(`ledger: ${JSON.stringify(ledger)}`);
    process.exit(1);
  }
  recorded = { ...first, deterministic5xx: true };
  console.log(`\n### ${name} — deterministic HTTP ${first.status} across all 4 attempts`);
}

const path = `../research/raw/${name}.txt`;
writeFileSync(
  new URL(path, import.meta.url),
  `# ${probe.method ?? "GET"} ${probe.path} -> HTTP ${recorded.status} (authMode=${probe.authMode})\n` +
    `# content-type: ${recorded.contentType}\n# ${recorded.ms} ms\n# attempts: ${ledger.length}\n` +
    `# ${recorded.deterministic5xx ? "DETERMINISTIC 5xx: all 4 attempts returned this exact status and body" : "recorded on the first non-transient attempt"}\n` +
    `# ${probe.note}\n\n` +
    recorded.text.slice(0, 20_000),
);
console.log(`\n### ${name} — ${probe.note}`);
console.log(recorded.text.replace(/\s+/g, " ").slice(0, 600));
console.log(`\nledger: ${JSON.stringify(ledger)}`);
// Node's HTTP/2 fallback can leave an aborted stream behind on the retried-5xx
// path; the probe is a one-shot script, so exit explicitly instead of letting an
// unrelated transport error surface as a crash after a successful probe.
process.exit(0);
