import { prisma } from "@/lib/prisma"
import { generateReference } from "@/lib/utils"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { calculateLoan } from "@/lib/loan-calculator"
import { deriveAffordabilityFlag } from "@/lib/validation/application-wizard"
import { toApplicationProduct } from "@/lib/applications/product-mapper"
import { prepareApplicationFields } from "@/lib/applications/prepare-application"
import { requiresPoFundingFacts } from "@/lib/applications/po-funding"
import { lockNewApplicationSubmissionEvidence } from "@/lib/applications/submission-lock"
import { isUniqueConstraintViolation, OPEN_APPLICATION_STATUSES } from "@/lib/applications/open-application"
import { EMPTY_APPLICATION_WIZARD_DATA } from "@/components/applications/wizard/types"
import type { ApiCaller } from "@/lib/lender-api/handler"
import { isIdShaped } from "@/lib/lender-api/pagination"
import { hasScope } from "@/lib/lender-api/scopes"
import { applicationSelect, toApiApplication } from "@/lib/lender-api/serializers"
import { CONSUMER_PRODUCT_WHERE } from "@/lib/product-config/product-kind"

/**
 * POST /api/v1/applications: a DRAFT application for an existing client.
 *
 * Only a draft. Submitting for review needs the consumer's affordability
 * declaration, the credit-life election and disclosure, the PASQ and staff's
 * reckless-lending assessment, none of which an integration can give on the
 * consumer's behalf; staff open the draft and complete it in the wizard.
 *
 * It goes through the staff create path's own code: the same row locks
 * (lockNewApplicationSubmissionEvidence), the same validation and
 * defaulted/blacklisted/deceased refusals (prepareApplicationFields), and the
 * one-open-application-per-client-and-product index. The wizard's step-3
 * affordability flag is computed here, server-side, exactly as the wizard does
 * (calculateLoan + deriveAffordabilityFlag); a FAIL needs a staff member's
 * reckless-lending acknowledgement, so the API refuses it (422).
 */

export interface CreateApplicationInput {
  clientId: string
  productId: string
  appliedAmountCents: number
  appliedTermDays: number
  purpose: string
  loanPurposeCategory: string | null
}

const PURPOSE_CATEGORIES = [
  "DEBT_CONSOLIDATION", "MEDICAL", "EDUCATION", "HOME_IMPROVEMENT", "VEHICLE",
  "BUSINESS", "HOUSEHOLD", "FUNERAL", "OTHER",
] as const

type Outcome = { status: number; body: unknown }
const fail = (status: number, code: string, message: string, details?: unknown): Outcome =>
  ({ status, body: { error: { code, message, ...(details ? { details } : {}) } } })

export function parseCreateApplication(body: unknown): CreateApplicationInput | Outcome {
  if (!body || typeof body !== "object") return fail(400, "invalid_body", "Send a JSON object.")
  const b = body as Record<string, unknown>
  if (typeof b.clientId !== "string" || !isIdShaped(b.clientId)) return fail(400, "invalid_body", "clientId is required.")
  if (typeof b.productId !== "string" || !isIdShaped(b.productId)) return fail(400, "invalid_body", "productId is required.")
  if (!Number.isInteger(b.appliedAmountCents) || (b.appliedAmountCents as number) <= 0) {
    return fail(400, "invalid_body", "appliedAmountCents must be a positive integer (cents).")
  }
  if (!Number.isInteger(b.appliedTermDays) || (b.appliedTermDays as number) <= 0) {
    return fail(400, "invalid_body", "appliedTermDays must be a positive integer.")
  }
  if (typeof b.purpose !== "string" || !b.purpose.trim() || b.purpose.length > 500) {
    return fail(400, "invalid_body", "purpose is required (at most 500 characters).")
  }
  const category = b.loanPurposeCategory ?? null
  if (category !== null && !(PURPOSE_CATEGORIES as readonly unknown[]).includes(category)) {
    return fail(400, "invalid_body", `loanPurposeCategory must be one of: ${PURPOSE_CATEGORIES.join(", ")}.`)
  }
  return {
    clientId: b.clientId,
    productId: b.productId,
    appliedAmountCents: b.appliedAmountCents as number,
    appliedTermDays: b.appliedTermDays as number,
    purpose: b.purpose.trim(),
    loanPurposeCategory: category as string | null,
  }
}

export async function createDraftApplication(caller: ApiCaller, input: CreateApplicationInput): Promise<Outcome> {
  const tenantId = caller.tenantId
  try {
    return await prisma.$transaction(async (tx) => {
      const locked = await lockNewApplicationSubmissionEvidence(tx, { tenantId, clientId: input.clientId, productId: input.productId })
      if (!locked) return fail(404, "not_found", "No such client or product.")

      const [client, productRow] = await Promise.all([
        tx.client.findFirst({
          where: { id: input.clientId, tenantId },
          select: { monthlyIncome: true, monthlyExpenses: true, debtObligations: { select: { monthlyInstalment: true } } },
        }),
        tx.loanProduct.findFirst({ where: { id: input.productId, tenantId, active: true, ...CONSUMER_PRODUCT_WHERE } }),
      ])
      if (!client) return fail(404, "not_found", "No such client.")
      if (!productRow) return fail(400, "invalid_body", "productId is not an active loan product.")
      // The API takes no purchase-order document (lib/applications/po-funding.ts).
      if (requiresPoFundingFacts(productRow.productType)) {
        return fail(422, "po_funding_not_supported", "Purchase order funding applications are not supported via the API: they need the purchase order document. Capture them in the staff app or the client portal.")
      }

      const product = toApplicationProduct(productRow)
      const calc = calculateLoan({
        principal: input.appliedAmountCents,
        termDays: input.appliedTermDays,
        interestRatePm: product.interestRatePm,
        productType: product.productType,
        interestModel: product.interestModel,
        initiationFeeModel: product.initiationFeeModel,
        initiationFeePct: product.initiationFeePct,
        initiationFeeMax: product.initiationFeeMax,
        monthlyServiceFee: product.monthlyServiceFee,
      })
      const ndi = client.monthlyIncome - client.monthlyExpenses
        - client.debtObligations.reduce((sum, d) => sum + d.monthlyInstalment, 0)
      const flag = ndi <= 0 ? "FAIL" : deriveAffordabilityFlag((100 * calc.monthlyInstalment) / ndi)
      if (flag === "FAIL") {
        return fail(422, "affordability_fails", "The instalment does not fit the client's recorded disposable income. Staff must capture this application with a reckless-lending assessment.")
      }

      const prepared = await prepareApplicationFields({
        ...EMPTY_APPLICATION_WIZARD_DATA,
        clientId: input.clientId,
        productId: input.productId,
        appliedAmount: input.appliedAmountCents,
        appliedTermDays: input.appliedTermDays,
        purpose: input.purpose,
        loanPurposeCategory: input.loanPurposeCategory ?? "",
        affordabilityFlag: flag,
        submitForReview: false,
      }, tenantId, caller.createdById, { action: "create" }, tx)
      if (!prepared.ok) {
        const code = prepared.status === 400 ? "validation_failed" : prepared.status === 404 ? "not_found" : "refused"
        return fail(prepared.status, code, prepared.body.error, prepared.body.errors)
      }

      const created = await tx.loanApplication.create({
        // The API key's creator stands in for the capturer: the SoD rule for an engine approval names them (lib/applications/input-staff.ts).
        data: { tenantId, reference: generateReference("APP"), ...prepared.fields, inputStaffIds: [caller.createdById] },
        select: applicationSelect,
      })
      await logAuditStrict({
        tenantId,
        action: AuditAction.APPLICATION_CREATED_VIA_API,
        entity: "LoanApplication",
        entityId: created.id,
        newValue: {
          ...(caller.kind === "oauth_client" ? { oauthClientId: caller.keyId } : { apiKeyId: caller.keyId }),
          reference: created.reference,
          clientId: created.clientId,
          productId: created.productId,
          appliedAmount: created.appliedAmount,
          appliedTermDays: created.appliedTermDays,
          status: created.status,
          affordabilityFlag: flag,
        },
      }, tx)
      return { status: 201, body: toApiApplication(created, { pii: hasScope(caller.scopes, "pii:read") }) }
    })
  } catch (error) {
    if (!isUniqueConstraintViolation(error)) throw error
    const open = await prisma.loanApplication.findFirst({
      where: { tenantId, clientId: input.clientId, productId: input.productId, status: { in: [...OPEN_APPLICATION_STATUSES] } },
      select: { id: true, reference: true },
    })
    if (!open) throw error
    return fail(409, "application_open", `An application for this client and product is already open (${open.reference}).`, { existingApplicationId: open.id })
  }
}
