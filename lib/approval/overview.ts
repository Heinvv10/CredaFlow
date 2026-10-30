import { activeCurrency } from "@/lib/jurisdiction/active"
import type { Currency } from "@/lib/jurisdiction/profiles"
import { presentChangeRequest } from "@/lib/maker-checker/http"
import { listChangeRequests } from "@/lib/maker-checker/service"
import { canDo, type UserRole } from "@/lib/permissions"
import { prisma } from "@/lib/prisma"
import { listDelegations } from "./delegations"
import { loadEffectiveMatrix } from "./matrix-store"
import { MATRIX_KIND, type MatrixPayload } from "./types"

export interface DelegationRow {
  id: string
  delegatorId: string
  delegatorName: string
  delegateId: string
  delegateName: string
  level: number
  maxAmountCents: number
  validFrom: string
  validTo: string
  reason: string
  revokedAt: string | null
}

export interface ApprovalMatrixOverview {
  currency: Currency
  inForce: { version: number; payload: MatrixPayload } | null
  versions: Array<{ id: string; version: number; name: string; enabled: boolean; effectiveFrom: string; createdAt: string; levels: number; rules: number }>
  products: Array<{ id: string; name: string; code: string }>
  branches: Array<{ id: string; name: string }>
  staff: Array<{ id: string; name: string; role: string }>
  requests: ReturnType<typeof presentChangeRequest>[]
  delegations: DelegationRow[]
  viewer: { id: string; canManage: boolean; canDelegate: boolean; canDelegateForOthers: boolean }
}

/** What the matrix settings page shows: the version in force, the history, pending changes, delegations, and what a rule can name. */
export async function loadApprovalMatrixOverview(tenantId: string, viewer: { id: string; role: UserRole }, now: Date = new Date()): Promise<ApprovalMatrixOverview> {
  const [inForce, versions, products, branches, staff, requests, delegations] = await Promise.all([
    loadEffectiveMatrix(prisma, tenantId, now),
    prisma.approvalMatrixVersion.findMany({ where: { tenantId }, orderBy: { version: "desc" }, take: 50 }),
    prisma.loanProduct.findMany({ where: { tenantId }, orderBy: { name: "asc" }, select: { id: true, name: true, code: true } }),
    prisma.branch.findMany({ where: { tenantId }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    prisma.user.findMany({ where: { tenantId, active: true, isSystem: false, role: { in: ["LOAN_ADMIN", "BRANCH_MANAGER", "ADMIN", "SUPER_ADMIN"] } }, orderBy: { name: "asc" }, select: { id: true, name: true, email: true, role: true } }),
    // Narrowed in the database: open requests and those decided in the last two weeks, newest first.
    listChangeRequests(tenantId, { kinds: [MATRIX_KIND], recentDays: 14, limit: 100 }).then((page) => page.rows),
    listDelegations(tenantId),
  ])
  return {
    currency: activeCurrency(),
    inForce: inForce ? { version: inForce.version, payload: inForce.payload } : null,
    versions: versions.map((v) => ({
      id: v.id, version: v.version, name: v.name, enabled: v.enabled, effectiveFrom: v.effectiveFrom.toISOString().slice(0, 10), createdAt: v.createdAt.toISOString(),
      levels: Array.isArray(v.levels) ? v.levels.length : 0, rules: Array.isArray(v.rules) ? v.rules.length : 0,
    })),
    products, branches,
    staff: staff.map((u) => ({ id: u.id, name: u.name || u.email, role: u.role })),
    requests: requests.map((r) => presentChangeRequest(r, viewer.id, viewer.role)),
    delegations: delegations.map((d) => ({
      id: d.id, delegatorId: d.delegatorId, delegatorName: d.delegator.name || d.delegator.email, delegateId: d.delegateId, delegateName: d.delegate.name || d.delegate.email,
      level: d.level, maxAmountCents: d.maxAmountCents, validFrom: d.validFrom.toISOString(), validTo: d.validTo.toISOString(), reason: d.reason, revokedAt: d.revokedAt?.toISOString() ?? null,
    })),
    viewer: { id: viewer.id, canManage: canDo(viewer.role, "manage_approval_matrix"), canDelegate: canDo(viewer.role, "manage_approval_delegations"), canDelegateForOthers: canDo(viewer.role, "manage_approval_delegations_any") },
  }
}
