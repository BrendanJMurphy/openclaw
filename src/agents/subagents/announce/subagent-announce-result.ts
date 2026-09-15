/** Exact-run final answer reads for subagent completion announcements. */
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  readSessionTranscriptRunId,
  resolveTerminalAssistantTranscriptRunId,
} from "../../../sessions/transcript-events.js";
import { extractStoredAssistantText } from "../../tools/chat-history-text.js";
import { resolveSubagentCompletionResultText } from "../completion/subagent-completion-result.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";

type OutputRuntime = typeof import("./subagent-announce.runtime.js");
export type SubagentAnnounceResultDeps = Pick<
  OutputRuntime,
  | "getRuntimeConfig"
  | "readSubagentSessionEntry"
  | "resolveAgentIdFromSessionKey"
  | "resolveSessionStorePathCore"
> & {
  findTranscriptEvent: typeof import("../../../config/sessions/session-accessor.js").findTranscriptEvent;
  listSessionTranscriptArchivesReadOnly: typeof import("../../../config/sessions/session-history.js").listSessionTranscriptArchivesReadOnly;
  readSessionArchiveContentSync: typeof import("../../../config/sessions/archive-compression.js").readSessionArchiveContentSync;
  resolveSqliteTranscriptArchiveDirectory: typeof import("../../../config/sessions/session-accessor.sqlite-scope.js").resolveSqliteTranscriptArchiveDirectory;
  resolveSqliteTranscriptReadScope: typeof import("../../../config/sessions/session-accessor.sqlite-scope.js").resolveSqliteTranscriptReadScope;
};

type AnnounceChild = Pick<
  SubagentRunRecord,
  "runId" | "childSessionKey" | "execution" | "completion"
>;
export type PreparedAnnounceResult = { text: string | undefined; isCurrent: () => boolean };

function captureAnnounceResultAuthority(child: AnnounceChild): () => boolean {
  const { runId, childSessionKey } = child;
  const terminalReply = child.completion?.terminalReply;
  const outcome = child.execution.outcome;
  const target = child.execution.transcriptTarget;
  const targetIdentity = target ? { ...target } : undefined;
  return () => {
    const currentTarget = child.execution.transcriptTarget;
    return (
      child.runId === runId &&
      child.childSessionKey === childSessionKey &&
      child.completion?.terminalReply === terminalReply &&
      child.execution.outcome === outcome &&
      currentTarget === target &&
      currentTarget?.sessionId === targetIdentity?.sessionId &&
      currentTarget?.agentId === targetIdentity?.agentId &&
      currentTarget?.storePath === targetIdentity?.storePath
    );
  };
}

/** Read the final assistant message from the transcript identity owned by this run. */
export async function readSubagentRunAnnounceResultUsing(
  child: AnnounceChild,
  deps: SubagentAnnounceResultDeps,
): Promise<PreparedAnnounceResult> {
  const isCurrent = captureAnnounceResultAuthority(child);
  const terminalReply = child.completion?.terminalReply;
  if (terminalReply?.disposition !== "visible" || child.execution.outcome?.status !== "ok") {
    return { text: resolveSubagentCompletionResultText(child), isCurrent };
  }
  const runId = child.runId;
  const childSessionKey = child.childSessionKey;
  const target = child.execution.transcriptTarget;
  const agentId = target?.agentId ?? deps.resolveAgentIdFromSessionKey(childSessionKey);
  const storePath =
    target?.storePath ??
    deps.resolveSessionStorePathCore(deps.getRuntimeConfig().session?.store, { agentId });
  const sessionKey = target?.sessionKey ?? childSessionKey;
  const sessionId =
    target?.sessionId ?? deps.readSubagentSessionEntry(storePath, sessionKey)?.sessionId;
  const scope = { agentId, storePath, sessionKey };
  const matchesRun = (event: unknown) =>
    isRecord(event) &&
    isRecord(event.message) &&
    readSessionTranscriptRunId(event.message) === runId &&
    resolveTerminalAssistantTranscriptRunId(event.message, runId) !== undefined;
  const found = sessionId
    ? await deps.findTranscriptEvent({ ...scope, sessionId }, matchesRun)
    : undefined;
  let event: unknown = found?.event;
  if (!event) {
    // Delete cleanup archives the transcript before requester settlement. Its
    // registered session identity and stored run id still identify this answer.
    const archives = deps
      .listSessionTranscriptArchivesReadOnly({
        ...scope,
        sessionIds: [sessionId ?? sessionKey],
      })
      .filter((archive) =>
        sessionId ? archive.sessionId === sessionId : archive.sessionKey === sessionKey,
      )
      .toReversed();
    for (const archive of archives) {
      const directory = deps.resolveSqliteTranscriptArchiveDirectory(
        deps.resolveSqliteTranscriptReadScope({
          ...scope,
          sessionId: archive.sessionId,
        }),
      );
      const events: unknown[] = deps
        .readSessionArchiveContentSync(path.join(directory, archive.archiveName))
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line));
      const header = events[0];
      if (!isRecord(header) || header.type !== "session" || header.id !== archive.sessionId) {
        throw new Error(
          "The completed child run's archive does not match its transcript identity.",
        );
      }
      event = events.findLast(matchesRun);
      if (event) {
        break;
      }
    }
  }
  if (!isCurrent()) {
    throw new Error("The completed child run's transcript identity changed during announcement.");
  }
  const answer = isRecord(event) ? extractStoredAssistantText(event.message) : undefined;
  if (!answer) {
    throw new Error("The completed child run's final answer is unavailable in its transcript.");
  }
  return { text: answer, isCurrent };
}
