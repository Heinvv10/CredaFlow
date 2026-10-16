import { prisma } from "@/lib/prisma"
import { logAuditStrict } from "@/lib/audit"
import { assessAffordability } from "@/lib/affordability/ndi"
import { logDocumentAccess } from "@/lib/document-auth"
import { recordPasqAcknowledgement } from "@/lib/compliance/pasq-acknowledgement.server"
import { addMonthsClamped } from "@/lib/asset-finance/dates"
import { parseDealCreate } from "@/lib/asset-finance/deal-input"
import { createDeal } from "@/lib/asset-finance/deal-create"
import { submitDeal } from "@/lib/asset-finance/deal-submit"
import { parseCreditMemoInput } from "@/lib/asset-finance/credit-memo-input"
import { recordDealFinancials } from "@/lib/asset-finance/deal-financials"
import { recordAssetFinanceAffordability } from "@/lib/asset-finance/affordability-store"
import { recordAssetCreditLifeElection } from "@/lib/asset-finance/nca-credit-life"
import { issueAssetNcaQuote } from "@/lib/asset-finance/nca-quote-store"
import { runDealBureauCheck } from "@/lib/asset-finance/deal-bureau"
import { decideDeal } from "@/lib/asset-finance/deal-decision"
import { issueAssetNcaAgreement, signAssetNcaAgreement, countersignAssetNcaAgreement } from "@/lib/asset-finance/nca-agreement-store"
import { seedSigningCode } from "./signing-code"
import { confirmChecklist, payOutAndBook } from "./asset-finance-execution"
import { dealActor, type SeedStaff } from "./asset-finance-deal"

interface Parties { clientId: string; assetId: string; supplierId: string; productId: string }

async function createNaturalDeal(tenantId: string, staff: SeedStaff, parties: Parties, today: string): Promise<string> {
  const existing = await prisma.assetFinanceDeal.findFirst({ where: { tenantId, clientId: parties.clientId, assetId: parties.assetId }, select: { id: true } })
  if (existing) return existing.id
  const parsed = parseDealCreate({
    ...parties, depositCents: 5_750_000, balloonCents: 0, firstDueDate: addMonthsClamped(today, 1),
    preset: { kind: "MONTHLY", periods: 48 }, rateBasis: "PRIME", rateMargin: "0.0100",
  }, today)
  if ("errors" in parsed) throw new Error(`Seed sole-proprietor deal refused: ${JSON.stringify(parsed.errors)}`)
  const created = await prisma.$transaction((tx) => createDeal(tx, { ...dealActor(tenantId, staff.officer), input: parsed.data }))
  if (created.kind !== "created") throw new Error(`Seed sole-proprietor deal refused (${created.status}): ${created.error}`)
  return created.dealId
}

async function originateNaturalDeal(tenantId: string, staff: SeedStaff, parties: Parties, today: string): Promise<string> {
  const dealId = await createNaturalDeal(tenantId, staff, parties, today)
  let deal = await prisma.assetFinanceDeal.findFirstOrThrow({ where: { id: dealId, tenantId }, include: { application: true, financials: true, affordabilityAssessment: true } })
  if (deal.status === "DRAFT") {
    const submitted = await prisma.$transaction((tx) => submitDeal(tx, dealActor(tenantId, staff.officer), dealId))
    if (submitted.kind !== "submitted") throw new Error(`Seed: sole proprietor should proceed as NCA (${submitted.kind})`)
  }
  deal = await prisma.assetFinanceDeal.findFirstOrThrow({ where: { id: dealId, tenantId }, include: { application: true, financials: true, affordabilityAssessment: true } })
  if (["SUBMITTED", "REFERRED"].includes(deal.status)) {
    if (!deal.financials) {
      const memo = parseCreditMemoInput({
        periodEnd: "2026-02-28", turnoverCents: 180_000_000, ebitdaCents: 54_000_000,
        totalAssetsCents: 100_000_000, totalLiabilitiesCents: 15_000_000,
        existingDebtServiceCents: 2_000_000, avgMonthlyCreditsCents: 14_000_000, returnedDebitsCount: 0,
      }, today)
      if ("errors" in memo) throw new Error(`Seed sole-proprietor credit memo refused: ${JSON.stringify(memo.errors)}`)
      const recorded = await prisma.$transaction((tx) => recordDealFinancials(tx, dealActor(tenantId, staff.officer), dealId, memo.data))
      if (recorded.kind !== "recorded") throw new Error(`Seed: sole-proprietor credit memo not recorded (${recorded.kind})`)
    }
    await runDealBureauCheck(tenantId, deal.applicationId, { clientId: parties.clientId, role: "DIRECTOR", trusteeKind: null }, { force: false, startedAt: new Date() })
    if (deal.application.affordabilityNDI === null) {
      const current = await prisma.assetFinanceDeal.findFirstOrThrow({ where: { id: dealId, tenantId }, select: {
        baseInstalmentCents: true, applicationId: true, client: { select: { monthlyIncome: true, monthlyExpenses: true } },
      } })
      if (!current.client || current.baseInstalmentCents === null) throw new Error("Seed: sole-proprietor affordability inputs missing")
      const personal = assessAffordability({
        monthlyIncomeCents: current.client.monthlyIncome, monthlyExpensesCents: current.client.monthlyExpenses,
        debts: [], proposedInstalmentCents: current.baseInstalmentCents,
      })
      if (!personal.isAffordable) throw new Error("Seed: sole-proprietor personal NDI is not affordable")
      await prisma.$transaction(async (tx) => {
        await tx.loanApplication.update({ where: { id: current.applicationId, tenantId }, data: {
          totalExistingDebt: personal.totalExistingDebt, netDisposableIncome: personal.netDisposableIncome,
          affordabilityNDI: personal.ndiAfterLoan,
        } })
        await logAuditStrict({
          tenantId, userId: staff.adminOne.id, userEmail: staff.adminOne.email,
          action: "AFFORDABILITY_ASSESSED", entity: "LoanApplication", entityId: current.applicationId,
          newValue: { syntheticSeed: true, ndi: personal.netDisposableIncome, ndiAfterLoan: personal.ndiAfterLoan, isAffordable: true },
        }, tx)
      })
    }
    const refreshed = await prisma.assetFinanceDeal.findFirstOrThrow({ where: { id: dealId, tenantId }, include: { application: true, affordabilityAssessment: true } })
    if (!refreshed.affordabilityAssessment) {
      const assessed = await prisma.$transaction((tx) => recordAssetFinanceAffordability(tx, dealActor(tenantId, staff.adminOne), dealId, "Synthetic business income and personal NDI support this TLB instalment sale."))
      if (assessed.kind !== "recorded" || !assessed.affordable) throw new Error(`Seed: sole-proprietor s81 refused (${JSON.stringify(assessed)})`)
    }
    if (!refreshed.application.creditLifeElection) {
      const elected = await prisma.$transaction((tx) => recordAssetCreditLifeElection(tx, {
        tenantId, clientId: parties.clientId, clientEmail: staff.officer.email, dealId, election: "DECLINED",
      }))
      if (elected.kind !== "recorded") throw new Error(`Seed: sole-proprietor credit life refused (${elected.kind})`)
    }
    const decided = await prisma.$transaction((tx) => decideDeal(tx, dealActor(tenantId, staff.adminOne), dealId, {
      decision: "APPROVE", reasons: ["Synthetic business cash flow and personal NDI are positive", "Consumer bureau enquiry completed"],
    }))
    if (decided.kind !== "decided" || decided.status !== "APPROVED") throw new Error(`Seed: sole-proprietor approval refused (${JSON.stringify(decided)})`)
  }
  let approvedDeal = await prisma.assetFinanceDeal.findFirstOrThrow({ where: { id: dealId, tenantId }, include: { application: true } })
  if (approvedDeal.status === "APPROVED" && !approvedDeal.application.pasqDocumentId) {
    const issued = await prisma.$transaction((tx) => issueAssetNcaQuote(tx, dealActor(tenantId, staff.adminOne), dealId))
    if (issued.kind !== "issued") throw new Error(`Seed: sole-proprietor PASQ refused (${JSON.stringify(issued)})`)
  }
  approvedDeal = await prisma.assetFinanceDeal.findFirstOrThrow({ where: { id: dealId, tenantId }, include: { application: true } })
  if (approvedDeal.status === "APPROVED" && !approvedDeal.application.pasqAcknowledgedAt && approvedDeal.application.pasqDocumentId && approvedDeal.application.pasqDocumentSha256) {
    await logDocumentAccess(prisma, {
      documentId: approvedDeal.application.pasqDocumentId, accessorType: "client", accessorId: parties.clientId,
      action: "view", req: new Request("http://seed.invalid/portal/pasq"),
    })
    const acknowledged = await recordPasqAcknowledgement({
      tenantId, applicationId: approvedDeal.applicationId, documentSha256: approvedDeal.application.pasqDocumentSha256,
      clientId: parties.clientId, clientEmail: staff.officer.email, method: "portal", ipAddress: null, userAgent: "CredaFlow synthetic seed",
    })
    if (!acknowledged.ok) throw new Error(`Seed: sole-proprietor PASQ acknowledgement refused (${acknowledged.error})`)
  }
  return dealId
}

async function executeNaturalDeal(tenantId: string, staff: SeedStaff, dealId: string, clientId: string, today: string): Promise<void> {
  let execution = await prisma.assetFinanceDeal.findFirstOrThrow({ where: { id: dealId, tenantId }, include: { application: true } })
  if (execution.status === "APPROVED" && !execution.application.agreementDocumentId) {
    const issued = await issueAssetNcaAgreement(dealActor(tenantId, staff.adminOne), dealId)
    if (issued.kind !== "done" || !issued.sha256) throw new Error(`Seed: sole-proprietor agreement refused (${JSON.stringify(issued)})`)
  }
  execution = await prisma.assetFinanceDeal.findFirstOrThrow({ where: { id: dealId, tenantId }, include: { application: true } })
  if (execution.status === "APPROVED" && !execution.application.agreementSignedAt && execution.application.agreementDocumentSha256) {
    const agreementSigner = await prisma.dealSigner.findFirstOrThrow({ where: { tenantId, dealId, clientId, document: "AGREEMENT" }, select: { id: true } })
    const signed = await signAssetNcaAgreement({
      tenantId, clientId, clientEmail: staff.officer.email, dealId,
      signature: "TEST Sole Proprietor", documentSha256: execution.application.agreementDocumentSha256,
      signingOtpChallengeId: await seedSigningCode(tenantId, clientId, agreementSigner.id, execution.application.agreementDocumentSha256),
    })
    if (signed.kind !== "done") throw new Error(`Seed: sole-proprietor signature refused (${JSON.stringify(signed)})`)
  }
  execution = await prisma.assetFinanceDeal.findFirstOrThrow({ where: { id: dealId, tenantId }, include: { application: true } })
  if (execution.status === "APPROVED" && !execution.application.agreementCountersignedAt) {
    const signed = await countersignAssetNcaAgreement(dealActor(tenantId, staff.adminOne), dealId, "TEST Provider")
    if (signed.kind !== "done") throw new Error(`Seed: provider countersign refused (${JSON.stringify(signed)})`)
  }
  const current = await prisma.assetFinanceDeal.findFirstOrThrow({ where: { id: dealId, tenantId } })
  if (current.status === "CONTRACTED") {
    await confirmChecklist(tenantId, staff.officer, dealId, { entityId: null, clientId })
    await payOutAndBook(tenantId, staff, dealId, today)
  }
}

export async function seedNaturalNcaDeal(tenantId: string, staff: SeedStaff, parties: Parties, today: string): Promise<void> {
  const dealId = await originateNaturalDeal(tenantId, staff, parties, today)
  await executeNaturalDeal(tenantId, staff, dealId, parties.clientId, today)
  const deal = await prisma.assetFinanceDeal.findFirstOrThrow({ where: { id: dealId, tenantId }, select: { status: true, loanId: true } })
  if (deal.status !== "BOOKED" || !deal.loanId) throw new Error(`Seed: sole-proprietor NCA deal should be BOOKED, got ${deal.status}`)
}
