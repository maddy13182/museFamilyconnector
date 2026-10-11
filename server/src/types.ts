// Shared types for the Family Hub API worker.
// Zero runtime dependencies. Plain interfaces only.

export type SqlParam = string | number | null;

/** Minimal database surface. Implemented by the D1 adapter (db.ts) in the
 *  worker and by the node:sqlite adapter in tests. All SQL is plain SQLite. */
export interface DbClient {
  queryAll(sql: string, params?: SqlParam[]): Promise<Row[]>;
  queryOne(sql: string, params?: SqlParam[]): Promise<Row | null>;
  /** Run a list of statements atomically (BEGIN/COMMIT on SQLite,
   *  D1 batch() in the worker). */
  execAtomically(ops: Array<{ sql: string; params?: SqlParam[] }>): Promise<void>;
}

export type Row = Record<string, unknown>;

export interface Env {
  /** D1 database binding (worker only). */
  DB?: unknown;
  /** Worker secret. NEVER in repo, logs, or chat. Tokens/invites are stored
   *  as sha256(TOKEN_PEPPER || value). */
  TOKEN_PEPPER: string;
  /** Set to "1" after bootstrap to disable POST /v1/families. */
  SETUP_LOCKED?: string;
  /** Minimum CLI version allowed by the client version gate (B1).
   *  Absent/"0.0.0" = gate off. */
  MIN_CLI_VERSION?: string;
}

/** HTTP error with a machine-readable code. Serialized as
 *  {error: {code, message}} per SPEC §13. */
export class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Result of the single auth choke point (auth.ts resolveToken).
 * principal_id is the stable cross-circle identity (F02): it is set at
 * member creation and never changes. Authorization joins use it, never the
 * email string. NULL only for rows that predate migration 0005 in a DB
 * where the backfill did not run — handlers treat that as fail-closed. */
export interface AuthContext {
  family_id: string;
  member_id: string;
  role: 'owner' | 'parent' | 'kid';
  token_id: string;
  agent_label: string;
  principal_id: string | null;
}

export const ENTRY_KINDS = [
  'message',
  'briefing',
  'member_joined',
  'member_left',
  'topic_spawned',
  'task_created',
  'task_assigned',
  'task_status',
  'task_note',
  'task_done',
  'redaction',
  // E2EE Phase 4 system kinds (client-posted, plaintext by design):
  'key_rotated',
  'key_request',
  'pending_key_distribution',
  // E2EE Phase 5 system kind (client-posted, plaintext by design):
  // topic_archived retires a dead topic and names its successor.
  'topic_archived',
] as const;

export const TASK_STATUSES = [
  'open',
  'in_progress',
  'blocked',
  'done',
  'cancelled',
] as const;

export const MEMBER_ROLES = ['owner', 'parent', 'kid'] as const;

/** Ownership-transfer completion modes: what happens to the offering owner
 *  once the recipient accepts — 'demote' drops them to parent, 'remove'
 *  deletes their member row and revokes their circle tokens. */
export const TRANSFER_COMPLETION_MODES = ['demote', 'remove'] as const;
export type TransferCompletionMode = (typeof TRANSFER_COMPLETION_MODES)[number];

/** Circle kinds (v0.2.0+). 'family' keeps owner/parent/kid roles;
 *  'general' will use owner/admin/member. */
export const FAMILY_KINDS = ['family', 'general'] as const;
export type FamilyKind = (typeof FAMILY_KINDS)[number];
