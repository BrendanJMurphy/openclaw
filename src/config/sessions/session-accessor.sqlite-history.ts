import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { decodeSessionArchiveBytes } from "./archive-compression.js";
import { isInternalSessionEffectsKey } from "./internal-session-key.js";
import { hashSessionArchiveBytes } from "./session-accessor.sqlite-archive-artifact.js";
import type {
  SessionAccessScope,
  SessionTranscriptInstance,
  SessionTranscriptInstanceListOptions,
  TranscriptEvent,
} from "./session-accessor.sqlite-contract.js";
import {
  getSessionKysely,
  resolveSqliteReadScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import type { SessionEntry } from "./types.js";

export function listTranscriptInstancesFromDatabase(params: {
  currentEntries: Pick<ReadonlyMap<string, SessionEntry>, "get">;
  database: Pick<OpenClawAgentDatabase, "agentId" | "db">;
  options: SessionTranscriptInstanceListOptions;
}): SessionTranscriptInstance[] {
  const db = getSessionKysely(params.database.db);
  let query = db
    .selectFrom("session_windows")
    .select([
      "session_id",
      "session_key",
      "created_at",
      "updated_at",
      "channel",
      "account_id",
      "transcript_updated_at",
      "session_entry_provenance",
      "acp_owned",
      "plugin_owner_id",
      "hook_external_content_source",
      "parent_session_key",
      "spawned_by",
      "chat_type",
    ]);
  if (!params.options.includeAllWindows) {
    query = query.where("transcript_updated_at", "is not", null);
  }
  if (params.options.sessionId !== undefined) {
    query = query.where("session_id", "=", params.options.sessionId);
  }
  const rows = executeSqliteQuerySync(
    params.database.db,
    query.orderBy("transcript_updated_at", "desc").orderBy("session_id", "asc"),
  ).rows;
  return rows
    .map((row): SessionTranscriptInstance | undefined => {
      if (!params.options.includeAllWindows && isInternalSessionEffectsKey(row.session_key)) {
        return undefined;
      }
      const updatedAtMs = row.transcript_updated_at ?? row.updated_at;
      const current = params.currentEntries.get(row.session_key);
      // Matching identities cannot classify transcript content written before provenance existed.
      const currentIsExact = current?.sessionId === row.session_id;
      const provenanceKnown = row.session_entry_provenance === 1;
      const hookExternalContentSource =
        row.hook_external_content_source === "gmail" ||
        row.hook_external_content_source === "webhook"
          ? row.hook_external_content_source
          : undefined;
      const chatType =
        row.chat_type === "direct" || row.chat_type === "group" || row.chat_type === "channel"
          ? row.chat_type
          : undefined;
      // The legacy window class conflates email and webhook. Keep it for trust
      // gating, but report an exact source only from its bound entry or unchanged Gmail class.
      const exactHookSource =
        (currentIsExact ? current?.hookExternalContentSource : undefined) ??
        (provenanceKnown && hookExternalContentSource === "gmail" ? "gmail" : null);
      const entry: SessionEntry = {
        ...(currentIsExact && current ? structuredClone(current) : {}),
        sessionId: row.session_id,
        updatedAt: updatedAtMs,
        ...(row.parent_session_key ? { parentSessionKey: row.parent_session_key } : {}),
        ...(row.spawned_by ? { spawnedBy: row.spawned_by, spawnDepth: 1 } : {}),
        ...(chatType ? { chatType } : {}),
        ...(provenanceKnown && row.plugin_owner_id ? { pluginOwnerId: row.plugin_owner_id } : {}),
        ...(provenanceKnown && hookExternalContentSource ? { hookExternalContentSource } : {}),
      };
      return {
        agentId: resolveAgentIdFromSessionKey(row.session_key, params.database.agentId),
        acpOwned: row.acp_owned === 1 || Boolean(currentIsExact && current?.acp),
        entry,
        provenanceKnown,
        sessionId: row.session_id,
        sessionKey: row.session_key,
        updatedAtMs,
        sourceMetadata: {
          createdAt: row.created_at,
          channel: row.channel,
          accountId: row.account_id,
          chatType: chatType ?? null,
          hookExternalContentSource: exactHookSource,
        },
      };
    })
    .filter((entry): entry is SessionTranscriptInstance => entry !== undefined);
}

function listTranscriptArchivesFromDatabase(
  { db, agentId }: Pick<OpenClawAgentDatabase, "db" | "agentId">,
  logicalAgentId: string,
  selectors: readonly string[],
  archiveNames: readonly string[],
) {
  let query = getSessionKysely(db)
    .selectFrom("session_transcript_archives")
    .select([
      "archive_name as archiveName",
      "session_id as sessionId",
      "session_key as sessionKey",
      "created_at as createdAt",
    ])
    .orderBy("created_at")
    .orderBy("session_id");
  query = query.where((expression) =>
    expression.or([
      ...(selectors.length > 0
        ? [expression("session_id", "in", selectors), expression("session_key", "in", selectors)]
        : []),
      ...(archiveNames.length > 0 ? [expression("archive_name", "in", archiveNames)] : []),
    ]),
  );
  const rows = executeSqliteQuerySync(db, query).rows;
  return rows.filter(
    (row) => resolveAgentIdFromSessionKey(row.sessionKey, agentId) === logicalAgentId,
  );
}

/** Read retained archive identities through the same physical and logical session owner. */
export function listSessionTranscriptArchivesReadOnly(
  scope: Pick<SessionAccessScope, "agentId" | "env" | "storePath"> & {
    archiveNames?: readonly string[];
    sessionIds?: readonly string[];
  },
) {
  const selectors = [...new Set(scope.sessionIds ?? [])];
  const archiveNames = [...new Set(scope.archiveNames ?? [])];
  if (selectors.length === 0 && archiveNames.length === 0) {
    return [];
  }
  const resolved = resolveSqliteReadScope(scope);
  const result = withOpenClawAgentDatabaseReadOnly(
    (database) =>
      listTranscriptArchivesFromDatabase(database, resolved.agentId, selectors, archiveNames),
    toDatabaseOptions(resolved),
  );
  return result.found ? result.value : [];
}

/** Reads committed archive content before its optional filesystem export is published. */
export function findSessionTranscriptArchiveEventReadOnly(
  scope: Pick<SessionAccessScope, "agentId" | "env" | "storePath"> & {
    sessionId?: string;
    sessionKey: string;
  },
  match: (event: TranscriptEvent) => boolean,
): { event: TranscriptEvent } | undefined {
  const resolved = resolveSqliteReadScope(scope);
  const result = withOpenClawAgentDatabaseReadOnly(
    (database) =>
      runSqliteDeferredTransactionSync(
        database.db,
        () => {
          const { db } = database;
          const archives = listTranscriptArchivesFromDatabase(
            database,
            resolved.agentId,
            [scope.sessionId ?? scope.sessionKey],
            [],
          )
            .filter((archive) =>
              scope.sessionId
                ? archive.sessionId === scope.sessionId
                : archive.sessionKey === scope.sessionKey,
            )
            .toReversed();
          for (const archive of archives) {
            const row = executeSqliteQueryTakeFirstSync(
              db,
              getSessionKysely(db)
                .selectFrom("session_transcript_archives")
                .select(["archive_blob", "archive_sha256", "encoding"])
                .where("archive_name", "=", archive.archiveName)
                .where("session_id", "=", archive.sessionId)
                .where("session_key", "=", archive.sessionKey),
            );
            if (!row) {
              continue;
            }
            if (hashSessionArchiveBytes(row.archive_blob) !== row.archive_sha256) {
              throw new Error("Archived transcript bytes do not match their registered hash.");
            }
            const events: TranscriptEvent[] = decodeSessionArchiveBytes(
              row.archive_blob,
              row.encoding === "zstd",
            )
              .split("\n")
              .filter((line) => line.trim())
              .map((line) => JSON.parse(line));
            const header = events[0];
            if (!isRecord(header) || header.type !== "session" || header.id !== archive.sessionId) {
              throw new Error("Archived transcript header does not match its registered session.");
            }
            const event = events.findLast(match);
            if (event !== undefined) {
              return { event };
            }
          }
          return undefined;
        },
        { operationLabel: "session transcript archive read" },
      ),
    toDatabaseOptions(resolved),
  );
  return result.found ? result.value : undefined;
}
