import type { prisma } from "@/lib/prisma"
import { sastCalendarDate } from "@/lib/date/sast"
import { roleLevel } from "./evaluate"
import type { ApplicationFacts, Delegation, MatrixLevel, MatrixPayload } from "./types"

type Db = Pick<typeof prisma, "approvalMatrixVersion" | "approvalDelegation" | "loanApplication" | "user">

export interface StoredMatrix {
  id: string
  version: number
  payload: MatrixPayload
}

function toPayload(row: { name: string; enabled: boolean; effectiveFrom: Date; levels: unknown; rules: unknown; defaultRequiredLevels: number }): MatrixPayload {
  return {
    name: row.name, enabled: row.enabled, effectiveFrom: row.effectiveFrom.toISOString().slice(0, 10),
    levels: row.levels as MatrixLevel[], rules: row.rules as MatrixPayload["rules"], defaultRequiredLevels: row.defaultRequiredLevels,
  }
}

/**
 * The lender's matrix in force: the latest version whose effective day has come. Null where there is none, or the latest
 * effective version switches it off: the lender is then on today's single-approver flow.
 */
export async function loadEffectiveMatrix(db: Pick<Db, "approvalMatrixVersion">, tenantId: string, now: Date): Promise<StoredMatrix | null> {
  const row = await db.approvalMatrixVersion.findFirst({
    where: { tenantId, effectiveFrom: { lte: new Date(`${sastCalendarDate(now)}T00:00:00Z`) } },
    orderBy: { version: "desc" },
  })
  if (!row || !row.enabled) return null
  return { id: row.id, version: row.version, payload: toPayload(row) }
}

/** A stored version by id, whether or not it is still in force (a case keeps the matrix it started under). */
export async function loadMatrixVersion(db: Pick<Db, "approvalMatrixVersion">, tenantId: string, id: string): Promise<StoredMatrix | null> {
  const row = await db.approvalMatrixVersion.findFirst({ where: { tenantId, id } })
  return row ? { id: row.id, version: row.version, payload: toPayload(row) } : null
}

export interface ApplicationForMatrix {
  id: string
  status: string
  facts: ApplicationFacts
  inputStaffIds: string[]
  clientId: string | null
}

export async function loadApplicationForMatrix(db: Pick<Db, "loanApplication">, tenantId: string, applicationId: string): Promise<ApplicationForMatrix | null> {
  const app = await db.loanApplication.findFirst({
    where: { id: applicationId, tenantId },
    select: { id: true, status: true, appliedAmount: true, productId: true, branchId: true, riskGradeRank: true, inputStaffIds: true, clientId: true },
  })
  if (!app) return null
  return {
    id: app.id, status: app.status, clientId: app.clientId, inputStaffIds: app.inputStaffIds,
    facts: { amountCents: app.appliedAmount, productId: app.productId, branchId: app.branchId, riskGradeRank: app.riskGradeRank },
  }
}

/** The user's delegations that could be in force now (the dates and amount are checked by delegatedLevel). */
export async function loadDelegationsFor(db: Pick<Db, "approvalDelegation">, tenantId: string, delegateId: string, now: Date): Promise<Delegation[]> {
  return db.approvalDelegation.findMany({ where: { tenantId, delegateId, revokedAt: null, validTo: { gte: now } } })
}

/** The current role level of each delegator, so a delegator who lost a level cannot keep passing it on. */
export async function delegatorLevels(db: Pick<Db, "user">, tenantId: string, delegations: readonly Delegation[], levels: readonly MatrixLevel[]): Promise<Record<string, number>> {
  const ids = [...new Set(delegations.map((d) => d.delegatorId))]
  if (ids.length === 0) return {}
  const users = await db.user.findMany({ where: { tenantId, id: { in: ids } }, select: { id: true, role: true, active: true } })
  const out: Record<string, number> = {}
  for (const id of ids) {
    const u = users.find((x) => x.id === id)
    out[id] = u && u.active ? roleLevel(levels, u.role) : 0
  }
  return out
}
