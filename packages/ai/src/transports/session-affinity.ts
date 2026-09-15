import type { Model, StreamOptions } from "../types.js";
import type { ResolvedOpenAICompletionsCompat } from "./openai-completions-compat.js";

function isOpencodeEndpoint(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.protocol === "https:" && url.hostname.replace(/\.$/, "") === "opencode.ai";
  } catch {
    return false;
  }
}

/** Required conversation identity is independent of optional prompt caching. */
export function resolveOpencodeSessionHeaders(
  model: Pick<Model, "baseUrl" | "headers">,
  options?: Pick<StreamOptions, "sessionId" | "headers">,
): Record<string, string> | undefined {
  if (!options?.sessionId || !isOpencodeEndpoint(model.baseUrl)) {
    return options?.headers;
  }
  if (hasOpencodeSessionHeader(model, options)) {
    return options.headers;
  }
  return { ...options.headers, "x-opencode-session": options.sessionId };
}

export function hasOpencodeSessionHeader(
  model: Pick<Model, "headers">,
  options?: Pick<StreamOptions, "headers">,
): boolean {
  return [model.headers, options?.headers].some((headers) =>
    Object.keys(headers ?? {}).some((name) => name.toLowerCase() === "x-opencode-session"),
  );
}

/**
 * Opt-in Chat Completions routing affinity. Callers pass the cache session id,
 * so `cacheRetention: "none"` sends none of these headers.
 */
export function resolveOpenAICompletionsSessionAffinityHeaders(
  compat: Pick<ResolvedOpenAICompletionsCompat, "sessionAffinity">,
  sessionId: string | undefined,
): Record<string, string> {
  if (!sessionId || compat.sessionAffinity === "none") {
    return {};
  }
  if (compat.sessionAffinity === "openrouter") {
    return { "x-session-id": sessionId };
  }
  return {
    session_id: sessionId,
    "x-client-request-id": sessionId,
    "x-session-affinity": sessionId,
  };
}
