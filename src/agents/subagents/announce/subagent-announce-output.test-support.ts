export * from "./subagent-announce-output.js";

type OutputRuntime = typeof import("./subagent-announce.runtime.js");
type OutputDeps = Pick<
  OutputRuntime,
  | "getRuntimeConfig"
  | "readSubagentSessionEntry"
  | "readSessionMessagesAsync"
  | "resolveAgentIdFromSessionKey"
  | "resolveSessionStorePathCore"
> & {
  callGateway: OutputRuntime["callSubagentLifecycleGateway"];
  findTranscriptEvent: typeof import("../../../config/sessions/session-accessor.js").findTranscriptEvent;
  listSessionTranscriptArchivesReadOnly: typeof import("../../../config/sessions/session-history.js").listSessionTranscriptArchivesReadOnly;
  readSessionArchiveContentSync: typeof import("../../../config/sessions/archive-compression.js").readSessionArchiveContentSync;
  resolveSqliteTranscriptArchiveDirectory: typeof import("../../../config/sessions/session-accessor.sqlite-scope.js").resolveSqliteTranscriptArchiveDirectory;
  resolveSqliteTranscriptReadScope: typeof import("../../../config/sessions/session-accessor.sqlite-scope.js").resolveSqliteTranscriptReadScope;
};

type Testing = {
  setDepsForTest(overrides?: Partial<OutputDeps>): void;
};

function getTesting(): Testing {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.subagentAnnounceOutputTestApi")
  ] as Testing;
}

export const testing: Testing = {
  setDepsForTest: (overrides) => getTesting().setDepsForTest(overrides),
};
