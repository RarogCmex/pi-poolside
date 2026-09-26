/**
 * Build `test/fixtures/error-bodies.json` from the recorded raw responses in
 * `research/raw/`, verbatim.
 *
 * The fixture is *generated* from recorded bytes rather than transcribed by
 * hand: a hand-copied error body is how a synthetic fixture silently replaces
 * the shape that actually needed handling (pitfall: "generate data files, never
 * blind-replace"). This script is not part of the plugin; re-run it after a new
 * probe to refresh the fixture.
 *
 *   node live/make-error-fixtures.ts
 */
import { readFileSync, writeFileSync } from "node:fs";

interface Recorded {
  file: string;
  name: string;
  case: string;
  note: string;
}

const RECORDED: Recorded[] = [
  {
    file: "listing-noauth",
    name: "no-auth-header",
    case: "401 plain text — no `Authorization` header at all",
    note: "The header is absent, not empty: `curl -H 'Authorization: ...'`-less requests only.",
  },
  {
    file: "listing-empty-auth",
    name: "empty-bearer",
    case: "502 HTML — `Authorization: Bearer ` with an empty value",
    note: "Deterministic: 4/4 attempts returned this exact body. The front proxy answers, not the API.",
  },
  {
    file: "listing-badkey",
    name: "bad-key-listing",
    case: "403 with NO readable body — the server resets the stream on GET /models with a wrong key",
    note: "Reproduced repeatedly: node/undici reports `403` and then `terminated` (ERR_HTTP2_STREAM_ERROR NGHTTP2_INTERNAL_ERROR), and `curl` independently reports `HTTP/2 stream 1 reset by server (error 0x2 INTERNAL_ERROR)` after `HTTP 403`, over both h2 and http1.1. The *status* is deterministic (0.3-0.5 s) but the body never arrives, so this fixture records a status without a body.",
  },
  {
    file: "badkey-chat",
    name: "bad-key-chat",
    case: "403 `{\"error\":\"<string>\"}` on POST /chat/completions with a wrong key",
    note: "Same dialect on the chat route; ~0.4 s, deterministic.",
  },
  {
    file: "unknown-model",
    name: "unknown-model",
    case: "404 `{\"error\":\"<string>\"}` for an unknown model id",
    note: "String dialect again.",
  },
  {
    file: "empty-body",
    name: "empty-json-body",
    case: "400 `{\"error\":\"<string>\"}` for `{}` — the zero-inference key check",
    note: "A rejection, so it is free and proves the key authenticated.",
  },
  {
    file: "max-tokens-too-big",
    name: "max-tokens-range",
    case: "400 enveloped `{\"error\":{\"code\",\"message\",\"type\"}}` for max_tokens over the cap",
    note: "Discloses the ceiling (262144) pre-inference, for free.",
  },
  {
    file: "max-completion-tokens-field",
    name: "extra-inputs",
    case: "400 enveloped rejection of `max_completion_tokens`",
    note: "`Extra inputs are not permitted` — the listing field is not a request field.",
  },
  {
    file: "temperature-3",
    name: "temperature-range",
    case: "400 enveloped `Validation: Temperature must be between 0 and 2`",
    note: "Same envelope as the max_tokens range error.",
  },
  {
    file: "embeddings-surface",
    name: "embeddings-absent",
    case: "404 enveloped `Model not found` for POST /v1/embeddings",
    note: "Surface check: no embedding model is listed.",
  },
];

interface RawResponse {
  status: number;
  contentType: string | null;
  body: string | null;
  transportReset: boolean;
  attempts: number;
  deterministic5xx: boolean;
  note: string;
}

function parseRaw(name: string): RawResponse {
  const text = readFileSync(new URL(`../research/raw/${name}.txt`, import.meta.url), "utf8");
  const [head, ...rest] = text.split("\n\n");
  const body = rest.join("\n\n");
  const status = /-> HTTP (\d+)/.exec(head)?.[1];
  const contentType = /^# content-type: (.+)$/m.exec(head)?.[1] ?? null;
  const attempts = /^# attempts: (\d+)$/m.exec(head)?.[1] ?? "1";
  if (!status) throw new Error(`${name}: no status line in the recorded file`);
  // Strip the trailing newline the recorded file added, nothing else — the body
  // must stay byte-verbatim.
  const trimmed = body.endsWith("\n") ? body.slice(0, -1) : body;
  // A transport-level stream reset leaves a status with no body at all; that is a
  // *recordable finding* here (the server resets the stream), not a missing probe.
  const transportReset = /^<<body read failed: (.*)>>$/.test(trimmed.trim());
  if (!trimmed.trim() && !transportReset) throw new Error(`${name}: empty recorded body`);
  return {
    status: Number(status),
    contentType,
    body: transportReset ? null : trimmed,
    transportReset,
    attempts: Number(attempts),
    deterministic5xx: head.includes("DETERMINISTIC 5xx"),
    note: "",
  };
}

const fixtures: Record<string, unknown> = {
  "$comment":
    "Recorded verbatim from https://inference.poolside.ai/v1 on 2026-09-26 (see research/raw/*.txt and live/probe.ts). Do not hand-edit: regenerate with `node live/make-error-fixtures.ts`.",
};

for (const entry of RECORDED) {
  const raw = parseRaw(entry.file);
  fixtures[entry.name] = {
    case: entry.case,
    note: entry.note,
    status: raw.status,
    contentType: raw.contentType,
    body: raw.body,
    recordedFile: `research/raw/${entry.file}.txt`,
    attempts: raw.attempts,
    transportReset: raw.transportReset,
    deterministic5xx: raw.deterministic5xx,
  };
}

writeFileSync(
  new URL("../test/fixtures/error-bodies.json", import.meta.url),
  `${JSON.stringify(fixtures, null, 2)}\n`,
);
console.log(`wrote test/fixtures/error-bodies.json with ${Object.keys(fixtures).length - 1} recorded bodies`);
