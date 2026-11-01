import { createHash } from "node:crypto"
import { Prisma } from "@prisma/client"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { InvalidPayloadError } from "@/lib/maker-checker/errors"
import type { ChangeHandler, Tx } from "@/lib/maker-checker/types"
import { nonNcaArrearsAudit } from "./non-nca-arrears"
import { LOAN_PRODUCT_KIND, parseLoanProductChange, type LoanProductPayload } from "./product-change"
import { checkProductUpdate, lockProduct, productCreateRefusal, productDeactivateRefusal, type ProductRefusal } from "./product-change-rules"

const refused = (refusal: ProductRefusal) => new InvalidPayloadError([refusal.body.error])

/** A product as the audit trail records it. */
const audited = (p: Prisma.LoanProductGetPayload<object>) => ({
  code: p.code, name: p.name, productType: p.productType, minAmount: p.minAmount, maxAmount: p.maxAmount, minTermDays: p.minTermDays, maxTermDays: p.maxTermDays,
  interestRatePm: p.interestRatePm, interestModel: p.interestModel, initiationFeeModel: p.initiationFeeModel, initiationFeePct: p.initiationFeePct, initiationFeeMax: p.initiationFeeMax,
  monthlyServiceFee: p.monthlyServiceFee, active: p.active, ...nonNcaArrearsAudit(p),
})

async function existing(tx: Tx, tenantId: string, productId: string) {
  const before = await lockProduct(tx, tenantId, productId)
  if (!before) throw new InvalidPayloadError(["payload.productId: that product does not exist"])
  return before
}

/** The creation, edit and deactivation of a loan product. The direct routes propose one of these; nothing else writes a product but the seed, the operator CLI and a version's activation. */
export const loanProductHandler: ChangeHandler<LoanProductPayload> = {
  kind: LOAN_PRODUCT_KIND,
  label: "Loan product",
  payloadVersion: 1,
  makePermission: "manage_product_versions",
  approvePermission: "approve_product_versions",
  parse: parseLoanProductChange,
  async verify(tx: Tx, tenantId, payload) {
    if (payload.action === "CREATE") {
      const refusal = await productCreateRefusal(tx, tenantId, payload.product)
      if (refusal) throw refused(refusal)
      return
    }
    const before = await existing(tx, tenantId, payload.productId)
    if (payload.action === "DEACTIVATE") {
      if (!before.active) throw new InvalidPayloadError(["payload.productId: that product is already inactive"])
      const refusal = await productDeactivateRefusal(tx, tenantId, before)
      if (refusal) throw refused(refusal)
      return
    }
    const check = await checkProductUpdate(tx, tenantId, before, payload.product)
    if ("refusal" in check) throw refused(check.refusal)
  },
  // A change is drafted against the product as it stands: any later write to the row, an activated version included, makes it stale.
  async baseRef(tx: Tx, tenantId, payload) {
    if (payload.action === "CREATE") return `new:${payload.product.code}`
    const row = await tx.loanProduct.findFirst({ where: { id: payload.productId, tenantId } })
    return row ? createHash("sha256").update(JSON.stringify(row)).digest("hex") : "missing"
  },
  async apply(tx: Tx, { tenantId, request, payload, checker }) {
    const provenance = { changeRequestId: request.id, makerId: request.makerId, reason: payload.reason }
    const who = { tenantId, userId: checker.id, userEmail: checker.email, entity: "LoanProduct" }
    if (payload.action === "CREATE") {
      const created = await tx.loanProduct.create({ data: { ...payload.product, tenantId } })
      await logAuditStrict({ ...who, action: AuditAction.LOAN_PRODUCT_CREATED, entityId: created.id, newValue: { ...audited(created), ...provenance } }, tx)
      return
    }
    const before = await existing(tx, tenantId, payload.productId)
    if (payload.action === "DEACTIVATE") {
      await tx.loanProduct.update({ where: { id: before.id, tenantId }, data: { active: false } })
      await logAuditStrict({ ...who, action: AuditAction.LOAN_PRODUCT_DEACTIVATED, entityId: before.id, oldValue: { active: before.active }, newValue: { active: false, ...provenance } }, tx)
      return
    }
    const updated = await tx.loanProduct.update({ where: { id: before.id, tenantId }, data: payload.product })
    await logAuditStrict({ ...who, action: AuditAction.LOAN_PRODUCT_UPDATED, entityId: before.id, oldValue: audited(before), newValue: { ...audited(updated), ...provenance } }, tx)
  },
}
