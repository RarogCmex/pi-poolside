/**
 * Poolside inference provider for pi (`https://inference.poolside.ai/v1`).
 *
 * Registers `poolside` as a first-class pi-ai provider: the two Laguna ids from
 * the gateway's own `/v1/models` listing (sourced `context_length`,
 * `max_completion_tokens`, `supported_features` and zero prices), `/login`,
 * boolean thinking through `chat_template_kwargs.enable_thinking`,
 * `reasoning_content` preserved on assistant messages, a live listing overlay,
 * and an error layer for the gateway's three measured failure dialects.
 *
 * pi 0.87 boundaries: `message_end` rewrites the *finalized* assistant message
 * before it is persisted — so the transcript, the next turn and the display all
 * agree — while `turn_end` appends one persistent TUI note for the failures a
 * human must act on.
 */

// NOTE on this import: pi's extension loader aliases the bare
// "@earendil-works/pi-ai" specifier to pi-ai's compat entrypoint, a strict
// superset of the core one that re-exports `openAICompletionsApi`. Subpaths
// other than /compat, /oauth and /providers/all are NOT aliased. tsconfig.json
// mirrors the loader's alias so `npm run typecheck` sees what pi sees. This is
// the only pi-runtime-only import in the package; everything else lives in
// modules plain Node can load, which is what makes them testable.
import { openAICompletionsApi } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  clarifyPoolsideError,
  needsPersistentHelp,
  withBodyRecoveryApi,
} from "./errors.ts";
import { PROVIDER_ID } from "./models.ts";
import { buildPoolsideProvider } from "./provider.ts";

const HELP_ENTRY_TYPE = "poolside-help";

export default function (pi: ExtensionAPI) {
  // One rewrite per finalized assistant message, guarded twice (this provider,
  // then the message role). There is no overflow normalization on this
  // provider: no overflow rejection was ever measured here, so none is invented
  // (README § "What remains unverified" records the probe that would settle it).
  pi.on("message_end", (event) => {
    const message = event.message;
    if (message.role !== "assistant") return;
    if (message.provider !== PROVIDER_ID) return;
    if (message.stopReason !== "error") return;

    const rewritten = clarifyPoolsideError(message.errorMessage ?? "");
    if (!rewritten) return;
    return { message: { ...message, errorMessage: rewritten } };
  });

  // A persistent TUI note for the states the user has to fix (no key at all,
  // wrong key, unknown model). The `ctx.hasUI` gate is load-bearing: an entry
  // appended *after* the errored assistant message makes `pi -p` print nothing
  // `pi -p` print nothing at all, so print mode keeps only the rewritten error
  // bubble.
  // Deduped via customType because `turn_end` can re-fire.
  pi.on("turn_end", (event, ctx) => {
    if (!ctx.hasUI) return;
    if (event.outcome !== "error") return;
    const message = event.message as unknown as {
      role: string;
      provider?: string;
      errorMessage?: string;
    };
    if (message.role !== "assistant" || message.provider !== PROVIDER_ID) return;
    if (!needsPersistentHelp(message.errorMessage ?? "")) return;
    if (
      event.entries.some((entry) => (entry as { customType?: string }).customType === HELP_ENTRY_TYPE)
    ) {
      return;
    }
    return {
      entries: [
        ...event.entries,
        {
          type: "custom_message" as const,
          customType: HELP_ENTRY_TYPE,
          content:
            "poolside rejected the request before generation. This gateway is explicit about " +
            "which auth failure you have: HTTP 401 `No Authorization header provided` means no " +
            "key was sent at all, while HTTP 403 `please check the api-key you provided` means a " +
            "key *was* sent and is wrong. Check for a trailing newline, then `/login poolside` or " +
            "`POOLSIDE_API_KEY`. A 404 `please check the model you provided` is a different " +
            "problem: that id is not in `GET /v1/models`.",
          display: true,
        },
      ],
    };
  });

  pi.registerProvider(buildPoolsideProvider(withBodyRecoveryApi(openAICompletionsApi())));
}
