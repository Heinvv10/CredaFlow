import { Prisma, type AppStatus, type LoanStatus } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { ERROR_RETRY_MAX_DAYS, ERROR_RETRY_MIN_HOURS, RESCREEN_TIME_BUDGET_MS, screeningCutoff } from "./policy"
import { runScreening } from "./run"
import type { SubjectRef } from "./types"

/** A party is in an ongoing relationship while a loan or an application of it (or of its entity) is live. */
export const RESCREEN_LOAN_STATUSES: LoanStatus[] = ["ACTIVE", "DEFAULTED", "PENDING_WRITE_OFF", "RESTRUCTURED"]
export const RESCREEN_APPLICATION_STATUSES: AppStatus[] = ["SUBMITTED", "UNDER_REVIEW", "APPROVED"]

/** Timestamps are stored as UTC wall time without a zone; compare like with like. */
const ts = (d: Date) => Prisma.sql`${d.toISOString()}::timestamp`

/**
 * Every subject due a re-screen, oldest first: active clients (own loans or
 * applications, or an active role in an active entity), active entities, whose
 * latest run is missing, older than SCREENING_MAX_AGE_DAYS, of a different
 * identity, or errored and past its backoff. The backoff after a failed run
 * is the length of the current failure streak, between ERROR_RETRY_MIN_HOURS
 * and ERROR_RETRY_MAX_DAYS, so retries thin out exponentially during an outage.
 */
export async function rescreenCandidates(tenantId: string, now: Date): Promise<SubjectRef[]> {
  const loans = Prisma.join(RESCREEN_LOAN_STATUSES)
  const apps = Prisma.join(RESCREEN_APPLICATION_STATUSES)
  const rows = await prisma.$queryRaw<Array<{ clientId: string | null; entityId: string | null }>>(Prisma.sql`
    WITH last_ok AS (
      -- Each subject's latest row that is not an error: history before it is never read.
      SELECT "clientId", "entityId", max("createdAt") AS ok_at FROM "ScreeningCheck"
       WHERE "tenantId" = ${tenantId} AND result <> 'ERROR' GROUP BY 1, 2
    ), runs AS (
      -- Bounded: the latest successful run and every run since it (the failure streak).
      SELECT s."clientId", s."entityId", s."runId", max(s."createdAt") AS at, bool_or(s.result = 'ERROR') AS errored,
             min(s."subjectFingerprint") AS fp
        FROM "ScreeningCheck" s
        LEFT JOIN last_ok o ON o."clientId" IS NOT DISTINCT FROM s."clientId" AND o."entityId" IS NOT DISTINCT FROM s."entityId"
       WHERE s."tenantId" = ${tenantId} AND (o.ok_at IS NULL OR s."createdAt" >= o.ok_at)
       GROUP BY s."clientId", s."entityId", s."runId"
    ), latest AS (
      SELECT * FROM (
        SELECT runs.*, row_number() OVER (PARTITION BY "clientId", "entityId" ORDER BY at DESC, "runId" DESC) AS rn FROM runs
      ) r WHERE rn = 1
    ), streak AS (
      SELECT "clientId", "entityId", min(at) AS first_err FROM runs WHERE errored GROUP BY 1, 2
    ), active_entities AS (
      SELECT e.id FROM "BusinessEntity" e WHERE e."tenantId" = ${tenantId} AND (
        EXISTS (SELECT 1 FROM "Loan" l WHERE l."tenantId" = ${tenantId} AND l."entityId" = e.id AND l.status::text IN (${loans}))
        OR EXISTS (SELECT 1 FROM "LoanApplication" a WHERE a."tenantId" = ${tenantId} AND a."entityId" = e.id AND a.status::text IN (${apps})))
    ), subjects AS (
      SELECT c.id AS "clientId", NULL::text AS "entityId", c."createdAt" FROM "Client" c
       WHERE c."tenantId" = ${tenantId} AND c."deceasedAt" IS NULL AND (
         EXISTS (SELECT 1 FROM "Loan" l WHERE l."tenantId" = ${tenantId} AND l."clientId" = c.id AND l.status::text IN (${loans}))
         OR EXISTS (SELECT 1 FROM "LoanApplication" a WHERE a."tenantId" = ${tenantId} AND a."clientId" = c.id AND a.status::text IN (${apps}))
         OR EXISTS (SELECT 1 FROM "EntityRelationship" er WHERE er."tenantId" = ${tenantId} AND er."clientId" = c.id AND er.active
                    AND er."entityId" IN (SELECT id FROM active_entities)))
      UNION ALL
      SELECT NULL::text, e.id, e."createdAt" FROM "BusinessEntity" e WHERE e.id IN (SELECT id FROM active_entities)
    )
    SELECT s."clientId", s."entityId" FROM subjects s
      LEFT JOIN latest l ON l."clientId" IS NOT DISTINCT FROM s."clientId" AND l."entityId" IS NOT DISTINCT FROM s."entityId"
      LEFT JOIN streak k ON k."clientId" IS NOT DISTINCT FROM s."clientId" AND k."entityId" IS NOT DISTINCT FROM s."entityId"
     WHERE l.at IS NULL
        OR l.at < ${ts(screeningCutoff(now))}
        OR l.fp IS DISTINCT FROM "screeningCurrentFingerprint"(${tenantId}, s."clientId", s."entityId")
        OR (l.errored AND ${ts(now)} - l.at >= GREATEST(
              interval '1 hour' * ${ERROR_RETRY_MIN_HOURS}::int,
              LEAST(interval '1 day' * ${ERROR_RETRY_MAX_DAYS}::int, l.at - coalesce(k.first_err, l.at))))
     ORDER BY l.at ASC NULLS FIRST, s."createdAt" ASC`)
  return rows.map((r) => (r.clientId ? { clientId: r.clientId } : { entityId: r.entityId as string }))
}

export type RefreshResult = {
  /** The true backlog: every subject due a re-screen when the run started. */
  candidates: number
  screened: number
  /** Runs that ended REFER or BLOCKED: now in the review queue or stopped. */
  flagged: number
  /** Runs that recorded a provider error or timeout, plus runs that threw. */
  failed: number
  /** Candidates left for the next invocation because the time budget ran out. */
  remaining: number
  errors: string[]
}

/** Re-screens one tenant's backlog, oldest first, until `deadline`. Each run is audited by runScreening. */
export async function refreshTenantScreening(
  tenantId: string,
  now: Date = new Date(),
  deadline: number = Date.now() + RESCREEN_TIME_BUDGET_MS,
): Promise<RefreshResult> {
  const candidates = await rescreenCandidates(tenantId, now)
  const result: RefreshResult = { candidates: candidates.length, screened: 0, flagged: 0, failed: 0, remaining: 0, errors: [] }
  for (const [index, subject] of candidates.entries()) {
    if (Date.now() >= deadline) {
      result.remaining = candidates.length - index
      break
    }
    try {
      const ran = await runScreening({ tenantId, subject, trigger: "PERIODIC", actor: null })
      if (!ran.configured) break
      result.screened++
      if (ran.state.state === "REFER" || ran.state.state === "BLOCKED") result.flagged++
      if (ran.providerError) result.failed++
    } catch (error) {
      result.failed++
      result.errors.push(`${"clientId" in subject ? subject.clientId : subject.entityId}: ${error instanceof Error ? error.name : typeof error}`)
    }
  }
  return result
}
