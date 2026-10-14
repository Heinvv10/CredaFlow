/**
 * Origination of the asset-finance demo deals, through the lib functions the
 * deal routes call (parseDealCreate → createDeal, recordDealFinancials,
 * submitDeal, decideDeal) and the override decision as the decide route makes
 * it. Each step runs only from the state before it, so a rerun (or a run
 * after a partial failure) picks up where the deal stands and writes nothing
 * for a step already taken.
 */
import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { sastCalendarDate } from "@/lib/date/sast"
import { parseDealCreate } from "@/lib/asset-finance/deal-input"
import { createDeal } from "@/lib/asset-finance/deal-create"
import { submitDeal } from "@/lib/asset-finance/deal-submit"
import { parseCreditMemoInput } from "@/lib/asset-finance/credit-memo-input"
import { recordDealFinancials } from "@/lib/asset-finance/deal-financials"
import { decideDeal } from "@/lib/asset-finance/deal-decision"
import { isRegimeOpen, lockApplicationForRegime } from "@/lib/asset-finance/classification"
import { overrideMatchesApplication } from "@/lib/asset-finance/override-snapshot"
import { addMonthsClamped } from "@/lib/asset-finance/dates"
import type { SeedActor } from "./asset-finance-documents"
import { COMPANY_DEAL, CREDIT_MEMO } from "./asset-finance-data"

export interface SeedStaff {
  officer: SeedActor
  adminOne: SeedActor
  adminTwo: SeedActor
}

export interface DealParties {
  entityId: string
  assetId: string
  supplierId: string
  productId: string
}

export const dealActor = (tenantId: string, a: SeedActor) => ({ tenantId, userId: a.id, userEmail: a.email })

async function createSeedDeal(tenantId: string, officer: SeedActor, body: Record<string, unknown>, today: string): Promise<string> {
  const parsed = parseDealCreate(body, today)
  if ("errors" in parsed) throw new Error(`Seed deal refused: ${JSON.stringify(parsed.errors)}`)
  const result = await prisma.$transaction((tx) => createDeal(tx, { ...dealActor(tenantId, officer), input: parsed.data }))
  if (result.kind !== "created") throw new Error(`Seed deal refused (${result.status}): ${result.error}`)
  return result.dealId
}

const findDeal = (tenantId: string, p: DealParties) =>
  prisma.assetFinanceDeal.findFirst({
    where: { tenantId, entityId: p.entityId, assetId: p.assetId },
    orderBy: { createdAt: "desc" },
    select: { id: true, status: true, applicationId: true },
  })

/**
 * The trust's deal: two natural trustees, so the classifier rules NCA
 * (TRUST_FEW_NATURAL_TRUSTEES) and submit refuses it — REFUSED_NCA, the
 * application DECLINED with the slice-1 reason, audited.
 */
export async function seedTrustDeal(tenantId: string, staff: SeedStaff, parties: DealParties): Promise<void> {
  const today = sastCalendarDate(new Date())
  const found = await findDeal(tenantId, parties)
  const dealId = found?.id ?? await createSeedDeal(tenantId, staff.officer, {
    assetId: parties.assetId, entityId: parties.entityId, supplierId: parties.supplierId, productId: parties.productId,
    depositCents: 3_450_000, firstDueDate: addMonthsClamped(today, 1),
    preset: { kind: "MONTHLY", periods: 36 }, rateBasis: "FIXED", fixedRate: "0.1300",
  }, today)
  if (found && found.status !== "DRAFT") return
  const result = await prisma.$transaction((tx) => submitDeal(tx, dealActor(tenantId, staff.officer), dealId))
  if (result.kind !== "refused_nca") throw new Error(`Seed: the trust deal should be refused as NCA, got ${result.kind}`)
}

/** Approve the PENDING NCA → NON_NCA override as POST /api/asset-finance/nca-overrides/[id]/decide does. */
async function approveOverride(tenantId: string, approver: SeedActor, applicationId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    if (!(await lockApplicationForRegime(tx, tenantId, applicationId))) throw new Error("Seed: application not found")
    const override = await tx.ncaRegimeOverride.findFirst({
      where: { tenantId, applicationId, status: "PENDING", toRegime: "NON_NCA" },
      include: {
        application: {
          select: { status: true, ncaRegime: true, entityId: true, appliedAmount: true, productId: true, ncaClassificationRule: true, ncaClassifiedAt: true },
        },
      },
    })
    if (!override) throw new Error("Seed: no pending NON_NCA override to approve")
    if (override.requestedById === approver.id) throw new Error("Seed: the override's requester cannot approve it")
    if (!isRegimeOpen(override.application.status) || override.application.ncaRegime !== override.fromRegime ||
      !overrideMatchesApplication(override, override.application)) {
      throw new Error("Seed: the override is stale")
    }
    const note = "Synthetic audited AFS (TEST) evidence turnover above the juristic threshold"
    await tx.ncaRegimeOverride.update({
      where: { id: override.id },
      data: { status: "APPROVED", decidedById: approver.id, decidedAt: new Date(), decisionNote: note },
    })
    await tx.loanApplication.update({ where: { id: applicationId, tenantId }, data: { ncaRegime: override.toRegime } })
    await logAuditStrict({
      tenantId, userId: approver.id, userEmail: approver.email,
      action: AuditAction.NCA_OVERRIDE_DECIDED, entity: "NcaRegimeOverride", entityId: override.id,
      oldValue: { status: "PENDING", ncaRegime: override.application.ncaRegime },
      newValue: {
        applicationId, status: "APPROVED", note, requestedById: override.requestedById, ncaRegime: override.toRegime,
      },
    }, tx)
  })
}

/**
 * The company's deal to APPROVED: created by the officer with the structure in
 * COMPANY_DEAL (first due one month after `bookingDate`), credit memo
 * recorded, submitted (the classifier's NON_NCA result opens an override in
 * the officer's name), the override approved by the SECOND loan admin, and
 * the deal approved with reasons by the first. Returns the deal id.
 */
export async function originateCompanyDeal(tenantId: string, staff: SeedStaff, parties: DealParties, bookingDate: string): Promise<string> {
  const found = await findDeal(tenantId, parties)
  const dealId = found?.id ?? await createSeedDeal(tenantId, staff.officer, {
    assetId: parties.assetId, entityId: parties.entityId, supplierId: parties.supplierId, productId: parties.productId,
    depositCents: COMPANY_DEAL.depositCents, balloonCents: COMPANY_DEAL.balloonCents,
    firstDueDate: addMonthsClamped(bookingDate, 1),
    preset: { ...COMPANY_DEAL.preset, seasonMonths: [...COMPANY_DEAL.preset.seasonMonths] },
    rateBasis: COMPANY_DEAL.rateBasis, rateMargin: COMPANY_DEAL.rateMargin,
  }, bookingDate)

  const deal = await prisma.assetFinanceDeal.findFirstOrThrow({
    where: { id: dealId, tenantId },
    select: { status: true, applicationId: true, financials: { select: { id: true } } },
  })
  if (deal.status === "DRAFT") {
    if (!deal.financials) {
      const memo = parseCreditMemoInput(CREDIT_MEMO, sastCalendarDate(new Date()))
      if ("errors" in memo) throw new Error(`Seed credit memo refused: ${JSON.stringify(memo.errors)}`)
      const recorded = await prisma.$transaction((tx) => recordDealFinancials(tx, dealActor(tenantId, staff.officer), dealId, memo.data))
      if (recorded.kind !== "recorded") throw new Error(`Seed: credit memo not recorded (${recorded.kind})`)
    }
    const submitted = await prisma.$transaction((tx) => submitDeal(tx, dealActor(tenantId, staff.officer), dealId))
    if (submitted.kind !== "submitted" || !submitted.awaitingRegimeApproval) {
      throw new Error(`Seed: the company deal should await the NON_NCA approval, got ${JSON.stringify(submitted)}`)
    }
  }
  const current = await prisma.assetFinanceDeal.findFirstOrThrow({
    where: { id: dealId, tenantId },
    select: { status: true, application: { select: { ncaRegime: true } } },
  })
  if (current.status !== "SUBMITTED") return dealId
  if (current.application.ncaRegime !== "NON_NCA") await approveOverride(tenantId, staff.adminTwo, deal.applicationId)
  const decided = await prisma.$transaction((tx) => decideDeal(tx, dealActor(tenantId, staff.adminOne), dealId, {
    decision: "APPROVE",
    reasons: [
      "Synthetic AFS show debt service cover comfortably above the credit policy minimum",
      "New excavator, insured with the lender's interest noted and tracked; directors' surety in place",
    ],
  }))
  if (decided.kind !== "decided" || decided.status !== "APPROVED") throw new Error(`Seed: deal approval refused (${JSON.stringify(decided)})`)
  return dealId
}
