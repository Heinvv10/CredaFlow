import type { Prisma } from "@prisma/client"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { sastCalendarDate } from "@/lib/date/sast"
import { InvalidPayloadError } from "@/lib/maker-checker/errors"
import type { ChangeHandler, Tx } from "@/lib/maker-checker/types"
import { parseMatrixPayload } from "./matrix-payload"
import { MATRIX_KIND, type MatrixPayload } from "./types"

export const approvalMatrixHandler: ChangeHandler<MatrixPayload> = {
  kind: MATRIX_KIND,
  label: "Approval matrix",
  payloadVersion: 1,
  makePermission: "manage_approval_matrix",
  approvePermission: "approve_approval_matrix",
  parse: parseMatrixPayload,
  async verify(tx: Tx, tenantId, payload) {
    const problems: string[] = []
    const productIds = [...new Set(payload.rules.flatMap((rule) => rule.when.productIds ?? []))]
    if (productIds.length > 0) {
      const found = await tx.loanProduct.findMany({ where: { tenantId, id: { in: productIds } }, select: { id: true } })
      const missing = productIds.filter((id) => !found.some((p) => p.id === id))
      if (missing.length > 0) problems.push(`payload.rules: unknown product ${missing.join(", ")}`)
    }
    const branchIds = [...new Set(payload.rules.flatMap((rule) => rule.when.branchIds ?? []))]
    if (branchIds.length > 0) {
      const found = await tx.branch.findMany({ where: { tenantId, id: { in: branchIds } }, select: { id: true } })
      const missing = branchIds.filter((id) => !found.some((b) => b.id === id))
      if (missing.length > 0) problems.push(`payload.rules: unknown branch ${missing.join(", ")}`)
    }
    if (problems.length > 0) throw new InvalidPayloadError(problems)
  },
  // Drafted against the latest version: approving over a newer one would silently undo it.
  async baseRef(tx: Tx, tenantId) {
    const latest = await tx.approvalMatrixVersion.aggregate({ where: { tenantId }, _max: { version: true } })
    return `v${latest._max.version ?? 0}`
  },
  async apply(tx: Tx, { tenantId, request, payload, checker, now }) {
    const latest = await tx.approvalMatrixVersion.aggregate({ where: { tenantId }, _max: { version: true } })
    const version = (latest._max.version ?? 0) + 1
    // A version cannot take effect in the past: a day already gone starts today.
    const today = sastCalendarDate(now)
    const effectiveFrom = payload.effectiveFrom < today ? today : payload.effectiveFrom
    const created = await tx.approvalMatrixVersion.create({
      data: {
        tenantId, version, name: payload.name, enabled: payload.enabled,
        effectiveFrom: new Date(`${effectiveFrom}T00:00:00Z`),
        levels: payload.levels as unknown as Prisma.InputJsonValue, rules: payload.rules as unknown as Prisma.InputJsonValue,
        defaultRequiredLevels: payload.defaultRequiredLevels, changeRequestId: request.id,
      },
    })
    await logAuditStrict({
      tenantId, userId: checker.id, userEmail: checker.email, action: AuditAction.APPROVAL_MATRIX_VERSION_CREATED,
      entity: "ApprovalMatrixVersion", entityId: created.id,
      newValue: { version, name: payload.name, enabled: payload.enabled, effectiveFrom, levels: payload.levels.length, rules: payload.rules.length, defaultRequiredLevels: payload.defaultRequiredLevels, changeRequestId: request.id, makerId: request.makerId },
    }, tx)
  },
}
