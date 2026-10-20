/**
 * Takes a SUBMITTED NCA sole-proprietor deal to BOOKED through the real staff
 * and portal routes, as lib/asset-finance/deal-decision.integration.test.ts
 * does: credit memo, s81 affordability, credit life declined by the client,
 * approval, PASQ issued, viewed and acknowledged, agreement issued, viewed,
 * signed with a signing code and countersigned, payout evidence uploaded,
 * then booked. Only the payout checklist confirmation and the approved payout
 * are written directly (triggers off), as that suite does. Every value is
 * synthetic. Not a test file.
 */
import type { PrismaClient } from "@prisma/client"
import { NextRequest } from "next/server"
import { expect } from "vitest"
import { dealRoutes, type DealFixture } from "@/lib/asset-finance/deal.integration-fixture"
import { verifiedSigningOtp } from "@/lib/signing-otp/signing-otp.integration-fixture"
import { POST as uploadDealDocumentRoute } from "@/app/api/asset-finance/deals/[id]/documents/route"

export type SessionUser = { id: string; email: string; role: string; tenantId: string }

const EVIDENCE = {
  SUPPLIER_INVOICE_MATCHES_ASSET: "SUPPLIER_INVOICE", SUPPLIER_BANK_VERIFIED: "BANK_STATEMENT",
  INSURANCE_NOTES_LENDER: "INSURANCE_NOTING", TRACKER_CONFIRMED: "TRACKER_CERTIFICATE",
  DELIVERY_AND_ACCEPTANCE: "DELIVERY_ACCEPTANCE", NATIS_TITLEHOLDER: "NATIS_DOCUMENT",
} as const

export async function bookSubmittedNcaDeal(args: {
  db: PrismaClient
  fx: DealFixture
  dealId: string
  client: { id: string; email: string }
  serialNumber: string
  supplierAccountId: string
  setSession: (user: SessionUser) => void
}): Promise<void> {
  const { db, fx, dealId, client, setSession } = args
  const routes = dealRoutes(fx.host)
  const staff = (id: string, role: string) => setSession({ id, email: `${id}@coc-it.test`, role, tenantId: fx.tenantId })
  const asClient = () => setSession({ id: client.id, email: client.email, role: "CLIENT", tenantId: fx.tenantId })
  const ok = async (response: Response | Promise<Response>, status = 200) => {
    const res = await response
    expect(res.status, await res.clone().text()).toBe(status)
    return res
  }

  const deal = await db.assetFinanceDeal.findUniqueOrThrow({ where: { id: dealId }, include: { application: true } })
  expect(deal.application).toMatchObject({ ncaRegime: "NCA", status: "SUBMITTED" })
  await db.loanApplication.update({ where: { id: deal.applicationId }, data: { affordabilityNDI: 80_000_000 } })
  staff(fx.officer, "CREDIT_OFFICER")
  await ok(routes.financials(dealId, {
    periodEnd: "2026-02-28", turnoverCents: 240_000_000, ebitdaCents: 80_000_000, totalAssetsCents: 300_000_000,
    totalLiabilitiesCents: 40_000_000, existingDebtServiceCents: 4_000_000, avgMonthlyCreditsCents: 20_000_000, returnedDebitsCount: 0,
  }))
  staff(fx.adminA, "LOAN_ADMIN")
  await ok(routes.affordability(dealId, { recklessLendingNote: "Verified business bank credits and personal NDI support the proposed instalment." }))
  asClient()
  await ok(routes.creditLife(dealId, { election: "DECLINED" }))
  staff(fx.adminA, "LOAN_ADMIN")
  await ok(routes.decide(dealId, { decision: "APPROVE", reasons: ["Affordable on verified business income and personal NDI"] }))
  const quote = await (await ok(routes.ncaQuote(dealId), 201)).json() as { documentId: string; sha256: string }
  asClient()
  await ok(routes.viewDocument(quote.documentId))
  await ok(routes.acknowledgePasq(deal.applicationId, { documentSha256: quote.sha256 }))
  staff(fx.adminA, "LOAN_ADMIN")
  const agreement = await (await ok(routes.ncaAgreement(dealId), 201)).json() as { documentId: string; sha256: string }
  asClient()
  await ok(routes.viewDocument(agreement.documentId))
  const signer = await db.dealSigner.findFirstOrThrow({ where: { dealId, document: "AGREEMENT" } })
  const signingOtpChallengeId = await verifiedSigningOtp(db, {
    tenantId: fx.tenantId, clientId: signer.clientId, purpose: "DEAL_DOCUMENT", subjectId: signer.id, documentSha256: agreement.sha256,
  })
  await ok(routes.signNcaAgreement(dealId, { signature: "Test Borrower", documentSha256: agreement.sha256, signingOtpChallengeId }))
  staff(fx.adminA, "LOAN_ADMIN")
  await ok(routes.countersignNcaAgreement(dealId, { signature: "Test Provider" }))

  await db.financedAsset.update({ where: { id: deal.assetId }, data: { trackerId: `TRK-${args.serialNumber}`, trackerProvider: "TEST Tracking", lenderNotedConfirmed: true } })
  const evidence = new Map<string, string>()
  staff(fx.officer, "CREDIT_OFFICER")
  for (const [item, docType] of Object.entries(EVIDENCE)) {
    const form = new FormData()
    form.set("docType", docType)
    form.set("file", new File([Buffer.from("%PDF-1.4\n% synthetic payout evidence")], `${docType}.pdf`, { type: "application/pdf" }))
    const uploaded = await ok(uploadDealDocumentRoute(new NextRequest(`http://${fx.host}/api/asset-finance/deals/${dealId}/documents`, {
      method: "POST", headers: { host: fx.host }, body: form,
    }), { params: Promise.resolve({ id: dealId }) }), 201)
    evidence.set(item, ((await uploaded.json()) as { id: string }).id)
  }
  const financed = (await db.loanApplication.findUniqueOrThrow({ where: { id: deal.applicationId }, select: { appliedAmount: true } })).appliedAmount
  await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica")
    for (const row of await tx.payoutChecklistItem.findMany({ where: { tenantId: fx.tenantId, dealId } })) {
      await tx.payoutChecklistItem.update({ where: { id: row.id }, data: {
        confirmedById: fx.adminA, confirmedAt: new Date(), evidenceDocumentId: evidence.get(row.item) ?? null,
        attestedIdentifier: row.item === "SUPPLIER_INVOICE_MATCHES_ASSET" ? args.serialNumber : null, note: "Synthetic integration evidence",
      } })
    }
    await tx.payout.create({ data: {
      tenantId: fx.tenantId, dealId, supplierBankAccountId: args.supplierAccountId, amountCents: financed,
      status: "APPROVED", createdById: fx.adminA, approvedById: fx.adminA, approvedAt: new Date(),
    } })
  })
  staff(fx.adminA, "LOAN_ADMIN")
  await ok(routes.book(dealId), 201)
}
