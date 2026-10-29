/**
 * The application's only access to the audit evidence tables (AuditChainLink,
 * AuditChainCheckpoint, AuditRedaction, AuditSiemOutbox): the SECURITY DEFINER
 * functions of migration 20261029100000. The application's database role holds
 * no privilege on those tables, so every read and write of them is one of these
 * calls, and each function checks what it is given (a link continues its chain,
 * a checkpoint names a real link). Times travel as ISO text cast to `timestamp`
 * in SQL: the columns are UTC `timestamp(3)` and this does not depend on the
 * session time zone.
 */
import { Prisma } from "@prisma/client"
import type { HashedRow } from "./chain-hash"

/** A transaction client or the client itself. */
export interface AuditDb {
  $queryRaw<T = unknown>(query: TemplateStringsArray | Prisma.Sql, ...values: unknown[]): Promise<T>
}

const ts = (d: Date) => Prisma.sql`${d.toISOString()}::timestamp`
const tsOrNull = (d: Date | null) => (d ? ts(d) : Prisma.sql`NULL::timestamp`)

export interface ChainHead { seq: number; rowHash: string }
export interface NewLink { seq: number; auditLogId: string; prevHash: string; rowHash: string }
export interface CheckpointRow { id: string; seq: number; rowHash: string; hmac: string; createdAt: Date }
export type LinkRow = Partial<HashedRow> & { seq: number; linkAuditLogId: string; prevHash: string; rowHash: string; present: boolean }

export async function chainHead(db: AuditDb, key: string): Promise<ChainHead | null> {
  const [head] = await db.$queryRaw<ChainHead[]>`SELECT * FROM audit_chain_head(${key})`
  return head ?? null
}

export async function candidateChains(db: AuditDb, since: Date): Promise<string[]> {
  const rows = await db.$queryRaw<Array<{ k: string }>>(Prisma.sql`SELECT audit_chain_candidates(${ts(since)}) AS k`)
  return rows.map((r) => r.k)
}

export function unlinkedRows(db: AuditDb, key: string, since: Date | null, limit: number): Promise<HashedRow[]> {
  return db.$queryRaw<HashedRow[]>(Prisma.sql`SELECT * FROM audit_chain_unlinked(${key}, ${tsOrNull(since)}, ${limit}::int)`)
}

/** Appends links in order; the database refuses a link that does not continue the chain. */
export async function appendLinks(db: AuditDb, key: string, links: readonly NewLink[]): Promise<number> {
  const [r] = await db.$queryRaw<Array<{ n: number }>>`SELECT audit_chain_append(${key}, ${JSON.stringify(links)}::jsonb) AS n`
  return r.n
}

export function checkpoints(db: AuditDb, key: string): Promise<CheckpointRow[]> {
  return db.$queryRaw<CheckpointRow[]>`SELECT * FROM audit_checkpoints(${key})`
}

export async function checkpointById(db: AuditDb, id: string): Promise<CheckpointRow | null> {
  const [cp] = await db.$queryRaw<CheckpointRow[]>`SELECT * FROM audit_checkpoint_get(${id})`
  return cp ?? null
}

/** False when the chain already has a checkpoint at or past `seq`. */
export async function writeCheckpoint(db: AuditDb, key: string, seq: number, rowHash: string, hmac: string): Promise<boolean> {
  const [r] = await db.$queryRaw<Array<{ ok: boolean }>>`SELECT audit_checkpoint_write(${key}, ${seq}::int, ${rowHash}, ${hmac}) AS ok`
  return r.ok
}

export async function linkHashAt(db: AuditDb, key: string, seq: number): Promise<string | null> {
  const [r] = await db.$queryRaw<Array<{ h: string | null }>>`SELECT audit_link_hash_at(${key}, ${seq}::int) AS h`
  return r?.h ?? null
}

export function verifyLinks(db: AuditDb, key: string, after: number, limit: number): Promise<LinkRow[]> {
  return db.$queryRaw<LinkRow[]>`SELECT * FROM audit_verify_links(${key}, ${after}::int, ${limit}::int)`
}

export async function unchainedOld(db: AuditDb, key: string, cutoff: Date, floor: Date | null): Promise<string | null> {
  const [r] = await db.$queryRaw<Array<{ id: string | null }>>(Prisma.sql`SELECT audit_unchained_old(${key}, ${ts(cutoff)}, ${tsOrNull(floor)}) AS id`)
  return r?.id ?? null
}

export async function unchainedPending(db: AuditDb, key: string, cutoff: Date, cap: number): Promise<number> {
  const [r] = await db.$queryRaw<Array<{ n: number }>>(Prisma.sql`SELECT audit_unchained_pending(${key}, ${ts(cutoff)}, ${cap}::int) AS n`)
  return r?.n ?? 0
}

// ── SIEM outbox ──

export interface OutboxRow<T = unknown> {
  id: number
  kind: string
  auditLogId: string | null
  checkpointId: string | null
  seq: number | null
  targetSnapshot: T | null
  attempts: number
  nextAttemptAt: Date
  createdAt: Date
}

export interface OutboxSource {
  id: string
  tenantId: string | null
  userId: string | null
  action: string
  entity: string
  entityId: string | null
  oldValue: unknown
  newValue: unknown
  ipAddress: string | null
  createdAt: Date
  linkSeq: number
  linkRowHash: string
  linkPrevHash: string
}

export async function dueTenants(db: AuditDb, now: Date): Promise<string[]> {
  const rows = await db.$queryRaw<Array<{ t: string }>>(Prisma.sql`SELECT audit_outbox_due_tenants(${ts(now)}) AS t`)
  return rows.map((r) => r.t)
}

export function snapshotRows<T>(db: AuditDb, tenantId: string, limit: number): Promise<OutboxRow<T>[]> {
  return db.$queryRaw<OutboxRow<T>[]>`SELECT * FROM audit_outbox_snapshot_rows(${tenantId}, ${limit}::int)`
}

export function streamRows(db: AuditDb, tenantId: string, limit: number): Promise<OutboxRow[]> {
  return db.$queryRaw<OutboxRow[]>`SELECT * FROM audit_outbox_stream_rows(${tenantId}, ${limit}::int)`
}

export function outboxSources(db: AuditDb, auditLogIds: readonly string[]): Promise<OutboxSource[]> {
  return db.$queryRaw<OutboxSource[]>`SELECT * FROM audit_outbox_sources(${[...auditLogIds]}::text[])`
}

/**
 * Marks entries of one lender after a delivery attempt. The database accepts only that
 * lender's pending entries and only a transition a delivery attempt can end in; 'sent'
 * records a receipt naming `destination` (host or origin, never a credential).
 */
export async function markOutbox(
  db: AuditDb, tenantId: string, ids: readonly number[], state: "sent" | "retry" | "dead", error: string | null, at: Date, destination: string,
): Promise<void> {
  await db.$queryRaw(Prisma.sql`SELECT audit_outbox_mark(${tenantId}, ${[...ids]}::int[], ${state}, ${error}, ${ts(at)}, ${destination})`)
}

/**
 * Routes the audit row recording a policy change to the destination the lender left, and
 * starts an anchor for the one it moves to. The database reads both from the committed
 * AuditPolicy change in this transaction; the caller names only the audit row.
 */
export async function queuePolicyChange(db: AuditDb, tenantId: string, auditLogId: string): Promise<void> {
  await db.$queryRaw`SELECT audit_outbox_policy_change(${tenantId}, ${auditLogId})`
}

/** Drops the unsent queue of a lender that is not forwarding (the database refuses otherwise, and records it). */
export async function pruneUnsent(db: AuditDb, tenantId: string): Promise<void> {
  await db.$queryRaw`SELECT audit_outbox_prune_unsent(${tenantId})`
}

/** Drops entries sent more than seven days ago (the cutoff is the database's). */
export async function purgeSent(db: AuditDb): Promise<void> {
  await db.$queryRaw`SELECT audit_outbox_purge_sent()`
}

export async function oldestPending(db: AuditDb): Promise<Date | null> {
  const [r] = await db.$queryRaw<Array<{ at: Date | null }>>`SELECT audit_outbox_oldest_pending() AS at`
  return r?.at ?? null
}
