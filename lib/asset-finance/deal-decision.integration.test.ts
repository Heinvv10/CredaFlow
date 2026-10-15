/**
 * Real-Postgres proof of asset-finance origination (goal §4.7, decisions
 * 2a.3 and 2a.6): create → submit → classify → four-eyes regime override →
 * credit memo → s81 affordability → decision with mandatory reasons; an NCA
 * deal proceeds down the regulated path.
 *
 * Only the session is stubbed. Routes, role guard, tenant resolution (by
 * host), feature flag, classifier, audit writer, regime trigger, CHECKs and
 * the (dry-run) Experian bureau path are real.
 *
 *   RUN_ASSET_FINANCE_DEAL_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/deal-decision.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { NextRequest } from "next/server"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { addMonthsClamped } from "./dates"
import { sastCalendarDate } from "@/lib/date/sast"
import { cleanupDealFixture, createDealFixture, dealFixtureTenantId, dealRoutes, type DealFixture } from "./deal.integration-fixture"
import { POST as requestSurrenderRoute } from "@/app/api/portal/asset-finance/loans/[loanId]/surrender/route"
import { POST as valuationRoute } from "@/app/api/asset-finance/surrenders/[id]/valuation/route"
import { POST as valuationNoticeRoute } from "@/app/api/asset-finance/surrenders/[id]/valuation-notice/route"
import { POST as proceedsRoute } from "@/app/api/asset-finance/surrenders/[id]/proceeds/route"
import { POST as finalNoticeRoute } from "@/app/api/asset-finance/surrenders/[id]/final-notice/route"
import { GET as portalSurrenderDocumentRoute } from "@/app/api/portal/asset-finance/surrenders/[id]/documents/[kind]/route"
import { POST as entityQuoteAcknowledgeRoute } from "@/app/api/portal/asset-finance/deals/[id]/nca-quote/acknowledge/route"
import { POST as prepareSigningRoute } from "@/app/api/asset-finance/deals/[id]/signing/route"
import { POST as portalSignerRoute } from "@/app/api/portal/asset-finance/deal-signers/[signerId]/sign/route"
import { POST as contractRoute } from "@/app/api/asset-finance/deals/[id]/contract/route"
import { POST as uploadDealDocumentRoute } from "@/app/api/asset-finance/deals/[id]/documents/route"
import { sweepTenantCharges, type SweepDb } from "@/lib/loan/charges-sweep"
import { applyManualReceipt, type PaymentDb } from "@/lib/loan/apply-payment"
import { evaluateCollectionsEligibility } from "@/lib/collections/section129-eligibility"
import { SECTION129_BORROWER_INCLUDE, section129Addressee } from "@/lib/collections/section129-addressee"
import { buildSection129Attachments } from "@/lib/email/section129-attachments"
import { getLenderIdentity } from "@/lib/config/identity"
import { verifiedSigningOtp } from "@/lib/signing-otp/signing-otp.integration-fixture"

const { session } = vi.hoisted(() => ({
  session: { current: null as null | { user: { id: string; email: string; role: string; tenantId: string } } },
}))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))

const RUN = process.env.RUN_ASSET_FINANCE_DEAL_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: DealFixture
const deals = { refused: "", approved: "", declined: "", natural: "" }

function database(): PrismaClient {
  if (!db) throw new Error("RUN_ASSET_FINANCE_DEAL_IT=1 is required")
  return db
}
const signIn = (userId: string, role: "LOAN_ADMIN" | "CREDIT_OFFICER") => {
  session.current = { user: { id: userId, email: `${userId}@deal-it.test`, role, tenantId: fx.tenantId } }
}
const signInClient = (clientId: string) => {
  session.current = { user: { id: clientId, email: fx.directorEmail, role: "CLIENT", tenantId: fx.tenantId } }
}
const routes = () => dealRoutes(fx.host)
const firstDueDate = addMonthsClamped(sastCalendarDate(new Date()), 2)
const structure = (assetId: string) => ({
  assetId, depositCents: 17_250_000, balloonCents: 0, firstDueDate,
  preset: { kind: "MONTHLY", periods: 60 }, rateBasis: "PRIME", rateMargin: "0.0100",
})
const dealRow = (id: string) => database().assetFinanceDeal.findUniqueOrThrow({ where: { id }, include: { application: true } })
const audits = (entityId: string, action: string) => database().auditLog.findMany({ where: { tenantId: fx.tenantId, entityId, action } })
const REASONS = ["DSCR 1.8 on audited AFS", "Directors' bureau records clean"]

suite.sequential("asset-finance deal decision (real Postgres, real routes)", () => {
  beforeAll(async () => {
    fx = await createDealFixture(database(), t)
  })

  afterAll(async () => {
    if (!db) return
    await cleanupDealFixture(db, fx ?? { tenantId: dealFixtureTenantId(t) })
    await db.$disconnect()
  })

  it("creates a deal: a DRAFT entity application for the financed amount, the deal DRAFT, audited", async () => {
    signIn(fx.officer, "CREDIT_OFFICER")
    const preview = await routes().preview({ ...structure(fx.assets[0]), contractType: "FINANCE_LEASE", balloonCents: 30_000_000 })
    expect(preview.status).toBe(200)
    const solved = await preview.json()
    expect(solved.financedAmountCents).toBe(172_500_000 - 17_250_000)

    const created = await routes().create({ ...structure(fx.assets[0]), contractType: "FINANCE_LEASE", balloonCents: 30_000_000, entityId: fx.unevidenced, supplierId: fx.supplier, productId: fx.product })
    expect(created.status).toBe(201)
    const deal = await created.json()
    deals.refused = deal.id
    const row = await dealRow(deal.id)
    expect(row).toMatchObject({ status: "DRAFT", baseInstalmentCents: solved.baseInstalmentCents, structurePreset: "MONTHLY" })
    expect(row.application).toMatchObject({
      status: "DRAFT", entityId: fx.unevidenced, clientId: null, appliedAmount: 155_250_000, ncaRegime: null,
    })
    expect(row.application.appliedTermDays).toBe(solved.termDays)
    expect(await audits(deal.id, "ASSET_DEAL_CREATED")).toHaveLength(1)

    // The same asset cannot sit on a second open deal.
    const again = await routes().create({ ...structure(fx.assets[0]), entityId: fx.evidenced, supplierId: fx.supplier, productId: fx.product })
    expect(again.status).toBe(409)
  })

  it("submits the unevidenced company's NCA deal instead of refusing it", async () => {
    signIn(fx.officer, "CREDIT_OFFICER")
    const response = await routes().submit(deals.refused)
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toMatchObject({ refusedNca: false, awaitingRegimeApproval: false, deal: { status: "SUBMITTED" } })
    const row = await dealRow(deals.refused)
    expect(row.status).toBe("SUBMITTED")
    expect(row.application).toMatchObject({ status: "SUBMITTED", ncaRegime: "NCA", ncaClassificationRule: "FINANCIALS_UNPROVEN" })
    expect(await audits(deals.refused, "ASSET_DEAL_SUBMITTED")).toHaveLength(1)
    expect(await database().ncaRegimeOverride.count({ where: { applicationId: row.applicationId } })).toBe(0)
  })

  it("books the small entity as an NCA finance lease through its authorised representative", async () => {
    const request = (path: string, method: string, body?: unknown) => new NextRequest(`http://${fx.host}${path}`, {
      method, headers: { host: fx.host, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    signIn(fx.officer, "CREDIT_OFFICER")
    expect((await routes().bureau(deals.refused)).status).toBe(200)
    expect((await routes().financials(deals.refused, {
      periodEnd: "2026-02-28", turnoverCents: 180_000_000, ebitdaCents: 55_000_000, totalAssetsCents: 190_000_000,
      totalLiabilitiesCents: 45_000_000, existingDebtServiceCents: 5_000_000, avgMonthlyCreditsCents: 15_000_000, returnedDebitsCount: 0,
    })).status).toBe(200)
    signIn(fx.adminA, "LOAN_ADMIN")
    expect((await routes().affordability(deals.refused, { recklessLendingNote: "Verified business cash flow supports the finance-lease instalment." })).status).toBe(200)
    signInClient(fx.director)
    const election = await routes().creditLife(deals.refused, { election: "DECLINED" })
    expect(election.status).toBe(200)
    expect(await election.json()).toMatchObject({ offered: false, monthlyPremiumCents: 0 })
    signIn(fx.adminA, "LOAN_ADMIN")
    expect((await routes().decide(deals.refused, { decision: "APPROVE", reasons: ["Affordable on verified entity cash flow"] })).status).toBe(200)
    const issued = await routes().ncaQuote(deals.refused)
    expect(issued.status).toBe(201)
    const quote = await issued.json() as { documentId: string; sha256: string }
    signInClient(fx.director)
    const acknowledged = await entityQuoteAcknowledgeRoute(request(`/api/portal/asset-finance/deals/${deals.refused}/nca-quote/acknowledge`, "POST", {
      documentSha256: quote.sha256,
    }), { params: Promise.resolve({ id: deals.refused }) })
    expect(acknowledged.status).toBe(200)

    signIn(fx.adminA, "LOAN_ADMIN")
    const prepared = await prepareSigningRoute(request(`/api/asset-finance/deals/${deals.refused}/signing`, "POST", {}), { params: Promise.resolve({ id: deals.refused }) })
    expect(prepared.status, await prepared.clone().text()).toBe(200)
    const signers = await database().dealSigner.findMany({ where: { dealId: deals.refused }, orderBy: { document: "asc" } })
    expect(signers.map((s) => s.document).sort()).toEqual(["AGREEMENT", "RESOLUTION"])
    signInClient(fx.director)
    for (const signer of signers) {
      const signingOtpChallengeId = await verifiedSigningOtp(database(), {
        tenantId: fx.tenantId, clientId: signer.clientId, purpose: "DEAL_DOCUMENT", subjectId: signer.id, documentSha256: signer.documentSha256!,
      })
      const signed = await portalSignerRoute(request(`/api/portal/asset-finance/deal-signers/${signer.id}/sign`, "POST", {
        signature: "TEST Director", documentSha256: signer.documentSha256, signingOtpChallengeId,
      }), { params: Promise.resolve({ signerId: signer.id }) })
      expect(signed.status, await signed.clone().text()).toBe(200)
    }
    signIn(fx.adminA, "LOAN_ADMIN")
    const contracted = await contractRoute(request(`/api/asset-finance/deals/${deals.refused}/contract`, "POST", { providerSignature: "TEST Provider" }), {
      params: Promise.resolve({ id: deals.refused }),
    })
    expect(contracted.status, await contracted.clone().text()).toBe(200)

    const accountId = (await database().supplierBankAccount.findFirst({ where: { tenantId: fx.tenantId, supplierId: fx.supplier, status: "APPROVED" }, select: { id: true } }))?.id ?? randomUUID()
    await database().vatConfig.create({ data: {
      tenantId: fx.tenantId, vatNumber: "4000000001", registeredName: "TEST Asset Credit (Pty) Ltd", address: "1 Synthetic Road, Johannesburg",
    } })
    await database().$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica")
      if (!(await tx.supplierBankAccount.count({ where: { id: accountId } }))) {
        await tx.supplierBankAccount.create({ data: {
          id: accountId, tenantId: fx.tenantId, supplierId: fx.supplier, bankName: "TEST Bank", branchCode: "000001",
          accountNumber: "0000000001", accountHolder: "TEST Plant Sales (Pty) Ltd", status: "APPROVED",
          requestedById: fx.officer, decidedById: fx.adminB, decidedAt: new Date(), avsResult: { synthetic: true },
        } })
      }
      const evidenceTypes = {
        SUPPLIER_INVOICE_MATCHES_ASSET: "SUPPLIER_INVOICE", SUPPLIER_BANK_VERIFIED: "BANK_STATEMENT",
        INSURANCE_NOTES_LENDER: "INSURANCE_NOTING", TRACKER_CONFIRMED: "TRACKER_CERTIFICATE",
        DELIVERY_AND_ACCEPTANCE: "DELIVERY_ACCEPTANCE", NATIS_TITLEHOLDER: "NATIS_DOCUMENT",
      } as const
      const evidence = new Map<string, string>()
      for (const [item, docType] of Object.entries(evidenceTypes)) {
        evidence.set(item, (await tx.entityDocument.create({ data: {
          tenantId: fx.tenantId, entityId: fx.unevidenced, dealId: deals.refused, docType,
          fileName: `${docType}.pdf`, mimeType: "application/pdf", fileSize: 1, storagePath: `/synthetic/${docType}.pdf`,
          contentSha256: "1".repeat(64), uploadedByType: "staff", uploadedById: fx.adminA,
        } })).id)
      }
      await tx.financedAsset.update({ where: { id: fx.assets[0] }, data: { trackerId: "TRK-ENTITY-NCA", trackerProvider: "TEST Tracking", lenderNotedConfirmed: true } })
      for (const row of await tx.payoutChecklistItem.findMany({ where: { tenantId: fx.tenantId, dealId: deals.refused } })) {
        await tx.payoutChecklistItem.update({ where: { id: row.id }, data: {
          confirmedById: fx.adminA, confirmedAt: new Date(), evidenceDocumentId: evidence.get(row.item) ?? null,
          attestedIdentifier: row.item === "SUPPLIER_INVOICE_MATCHES_ASSET" ? `TEST${t.toUpperCase()}1` : null,
          note: "Synthetic entity NCA integration evidence",
        } })
      }
      await tx.payout.create({ data: {
        tenantId: fx.tenantId, dealId: deals.refused, supplierBankAccountId: accountId, amountCents: 155_250_000,
        status: "APPROVED", createdById: fx.adminA, approvedById: fx.adminA, approvedAt: new Date(),
      } })
    })
    const booked = await routes().book(deals.refused)
    expect(booked.status, await booked.clone().text()).toBe(201)
    const row = await dealRow(deals.refused)
    expect(row).toMatchObject({ status: "BOOKED", contractType: "FINANCE_LEASE", application: { status: "DISBURSED", ncaRegime: "NCA" } })
    const loan = await database().loan.findUniqueOrThrow({ where: { id: row.loanId ?? "missing" } })
    expect(loan).toMatchObject({ entityId: fx.unevidenced, clientId: null, ncaRegime: "NCA", contractType: "FINANCE_LEASE", balloonAmount: 30_000_000 })
    expect(await database().insurancePolicy.count({ where: { linkedLoanId: loan.id } })).toBe(0)
  })

  it("database-refuses changing an entity asset loan date away from its signed PASQ schedule", async () => {
    const deal = await dealRow(deals.refused)
    const loanId = deal.loanId ?? "missing"
    const first = await database().repaymentSchedule.findFirstOrThrow({
      where: { loanId }, orderBy: { installmentNo: "asc" }, select: { id: true, dueDate: true },
    })
    await expect(database().$transaction(async (tx) => {
      await tx.repaymentSchedule.update({
        where: { id: first.id }, data: { dueDate: new Date(first.dueDate.getTime() + 1) },
      })
      await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE")
    })).rejects.toThrow(/quote window and signed agreement/i)
  })

  it("takes a natural-person asset deal through business-income s81 and approval", async () => {
    const insurer = await database().insurer.create({ data: { tenantId: fx.tenantId, name: "TEST Life Underwriter", fspNumber: "99999" } })
    await database().insuranceProduct.create({ data: {
      tenantId: fx.tenantId, code: `CL-${t}`, name: "TEST Asset Credit Life", type: "CREDIT_LIFE",
      premiumAmount: 1, sumAssured: 1, insurerId: insurer.id,
    } })
    signIn(fx.officer, "CREDIT_OFFICER")
    const created = await routes().create({ ...structure(fx.assets[3]), clientId: fx.director, supplierId: fx.supplier, productId: fx.product })
    expect(created.status).toBe(201)
    deals.natural = (await created.json()).id
    expect((await routes().submit(deals.natural)).status).toBe(200)
    const row = await dealRow(deals.natural)
    expect(row.application).toMatchObject({ ncaRegime: "NCA", ncaClassificationRule: "NATURAL_PERSON_NCA", status: "SUBMITTED" })
    await database().loanApplication.update({ where: { id: row.applicationId }, data: { affordabilityNDI: 80_000_000 } })
    expect((await routes().financials(deals.natural, {
      periodEnd: "2026-02-28", turnoverCents: 240_000_000, ebitdaCents: 80_000_000, totalAssetsCents: 300_000_000,
      totalLiabilitiesCents: 40_000_000, existingDebtServiceCents: 4_000_000, avgMonthlyCreditsCents: 20_000_000, returnedDebitsCount: 0,
    })).status).toBe(200)
    signIn(fx.adminA, "LOAN_ADMIN")
    expect((await routes().affordability(deals.natural, { recklessLendingNote: "Verified business bank credits and personal NDI support the proposed instalment." })).status).toBe(200)
    signInClient(fx.director)
    expect((await routes().creditLife(deals.natural, { election: "ACCEPTED" })).status).toBe(200)
    signIn(fx.adminA, "LOAN_ADMIN")
    const decided = await routes().decide(deals.natural, { decision: "APPROVE", reasons: ["Affordable on verified business income and personal NDI"] })
    expect(decided.status).toBe(200)
    expect(await dealRow(deals.natural)).toMatchObject({ status: "APPROVED", application: { status: "APPROVED", ncaRegime: "NCA" } })
    const issued = await routes().ncaQuote(deals.natural)
    expect(issued.status).toBe(201)
    const quote = await issued.json() as { documentId: string; sha256: string }
    expect(quote).toMatchObject({ kind: "issued", sha256: expect.stringMatching(/^[0-9a-f]{64}$/) })
    expect((await dealRow(deals.natural)).application).toMatchObject({ pasqVersion: "pasq-v3", pasqDocumentId: quote.documentId })
    signInClient(fx.director)
    expect((await routes().viewDocument(quote.documentId)).status).toBe(200)
    expect((await routes().acknowledgePasq(row.applicationId, { documentSha256: quote.sha256 })).status).toBe(200)
    signIn(fx.adminA, "LOAN_ADMIN")
    const agreementResponse = await routes().ncaAgreement(deals.natural)
    expect(agreementResponse.status).toBe(201)
    const agreement = await agreementResponse.json() as { documentId: string; sha256: string }
    signInClient(fx.director)
    expect((await routes().viewDocument(agreement.documentId)).status).toBe(200)
    // The lender requires a signing code (default): none, or one for other
    // bytes, is refused; one verified for this signer row and bytes signs.
    const bare = await routes().signNcaAgreement(deals.natural, { signature: "Test Director", documentSha256: agreement.sha256 })
    expect(bare.status).toBe(403)
    expect(await bare.json()).toEqual(expect.objectContaining({ signingOtp: "required" }))
    const agreementSigner = await database().dealSigner.findFirstOrThrow({ where: { dealId: deals.natural, document: "AGREEMENT" } })
    const otpFor = (documentSha256: string) => verifiedSigningOtp(database(), {
      tenantId: fx.tenantId, clientId: agreementSigner.clientId, purpose: "DEAL_DOCUMENT", subjectId: agreementSigner.id, documentSha256,
    })
    expect((await routes().signNcaAgreement(deals.natural, {
      signature: "Test Director", documentSha256: agreement.sha256, signingOtpChallengeId: await otpFor("0".repeat(64)),
    })).status).toBe(409)
    expect((await dealRow(deals.natural)).application.agreementSignedAt).toBeNull()
    expect((await routes().signNcaAgreement(deals.natural, {
      signature: "Test Director", documentSha256: agreement.sha256, signingOtpChallengeId: await otpFor(agreement.sha256),
    })).status).toBe(200)
    signIn(fx.adminA, "LOAN_ADMIN")
    expect((await routes().countersignNcaAgreement(deals.natural, { signature: "Test Provider" })).status).toBe(200)
    expect((await dealRow(deals.natural)).application).toMatchObject({
      agreementDocumentId: agreement.documentId, agreementDocumentSha256: agreement.sha256,
      agreementSignedMethod: "portal", agreementCountersignedAt: expect.any(Date),
    })
    await database().vatConfig.upsert({ where: { tenantId: fx.tenantId }, create: {
      tenantId: fx.tenantId, vatNumber: "4000000001", registeredName: "TEST Asset Credit (Pty) Ltd", address: "1 Synthetic Road, Johannesburg",
    }, update: {} })
    await database().financedAsset.update({ where: { id: fx.assets[3] }, data: {
      trackerId: "TRK-NCA-001", trackerProvider: "TEST Tracking", lenderNotedConfirmed: true,
    } })
    const evidenceTypes = {
      SUPPLIER_INVOICE_MATCHES_ASSET: "SUPPLIER_INVOICE", SUPPLIER_BANK_VERIFIED: "BANK_STATEMENT",
      INSURANCE_NOTES_LENDER: "INSURANCE_NOTING", TRACKER_CONFIRMED: "TRACKER_CERTIFICATE",
      DELIVERY_AND_ACCEPTANCE: "DELIVERY_ACCEPTANCE", NATIS_TITLEHOLDER: "NATIS_DOCUMENT",
    } as const
    const evidence = new Map<string, string>()
    signIn(fx.officer, "CREDIT_OFFICER")
    for (const [item, docType] of Object.entries(evidenceTypes)) {
      const form = new FormData()
      form.set("docType", docType)
      form.set("file", new File([Buffer.from("%PDF-1.4\n% synthetic payout evidence")], `${docType}.pdf`, { type: "application/pdf" }))
      const uploaded = await uploadDealDocumentRoute(new NextRequest(`http://${fx.host}/api/asset-finance/deals/${deals.natural}/documents`, {
        method: "POST", headers: { host: fx.host }, body: form,
      }), { params: Promise.resolve({ id: deals.natural }) })
      expect(uploaded.status, await uploaded.clone().text()).toBe(201)
      evidence.set(item, ((await uploaded.json()) as { id: string }).id)
    }
    const accountId = (await database().supplierBankAccount.findFirst({ where: { tenantId: fx.tenantId, supplierId: fx.supplier, status: "APPROVED" }, select: { id: true } }))?.id ?? randomUUID()
    await database().$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica")
      if (!(await tx.supplierBankAccount.count({ where: { id: accountId } }))) {
        await tx.supplierBankAccount.create({ data: {
          id: accountId, tenantId: fx.tenantId, supplierId: fx.supplier, bankName: "TEST Bank", branchCode: "000001",
          accountNumber: "0000000001", accountHolder: "TEST Plant Sales (Pty) Ltd", status: "APPROVED",
          requestedById: fx.officer, decidedById: fx.adminB, decidedAt: new Date(), avsResult: { synthetic: true },
        } })
      }
      for (const row of await tx.payoutChecklistItem.findMany({ where: { tenantId: fx.tenantId, dealId: deals.natural } })) {
        await tx.payoutChecklistItem.update({ where: { id: row.id }, data: {
          confirmedById: fx.adminA, confirmedAt: new Date(), evidenceDocumentId: evidence.get(row.item) ?? null,
          attestedIdentifier: row.item === "SUPPLIER_INVOICE_MATCHES_ASSET" ? `TEST${t.toUpperCase()}4` : null,
          note: "Synthetic integration evidence",
        } })
      }
      await tx.payout.create({ data: {
        tenantId: fx.tenantId, dealId: deals.natural, supplierBankAccountId: accountId, amountCents: 155_250_000,
        status: "APPROVED", createdById: fx.adminA, approvedById: fx.adminA, approvedAt: new Date(),
      } })
    })
    signIn(fx.adminA, "LOAN_ADMIN")
    const booked = await routes().book(deals.natural)
    const bookedBody = await booked.json()
    expect(booked.status, JSON.stringify(bookedBody)).toBe(201)
    const bookedDeal = await dealRow(deals.natural)
    expect(bookedDeal).toMatchObject({ status: "BOOKED", application: { status: "DISBURSED", ncaRegime: "NCA" } })
    expect(await database().insurancePolicy.count({ where: {
      tenantId: fx.tenantId, linkedLoanId: bookedDeal.loanId, type: "CREDIT_LIFE", policySource: "BUNDLED_CREDIT_AGREEMENT",
    } })).toBe(1)
  })

  it("database-refuses a deal document owned by both an entity and a natural borrower", async () => {
    await expect(database().entityDocument.create({ data: {
      tenantId: fx.tenantId,
      entityId: fx.unevidenced,
      clientId: fx.director,
      dealId: deals.natural,
      docType: "OTHER",
      fileName: "invalid-owner.pdf",
      mimeType: "application/pdf",
      fileSize: 1,
      storagePath: "/synthetic/invalid-owner.pdf",
      contentSha256: "9".repeat(64),
      uploadedByType: "staff",
      uploadedById: fx.officer,
    } })).rejects.toThrow(/EntityDocument_borrower_xor/i)
  })

  it("services entity and sole-proprietor NCA loans through 90 DPD, s129 addressing and a receipt", async () => {
    const entityDeal = await dealRow(deals.refused)
    const naturalDeal = await dealRow(deals.natural)
    if (!entityDeal.loanId || !naturalDeal.loanId) throw new Error("NCA asset fixtures were not booked")
    const firstDue = await database().repaymentSchedule.findFirstOrThrow({
      where: { loanId: entityDeal.loanId }, orderBy: { installmentNo: "asc" }, select: { dueDate: true },
    })
    const asOf = new Date(firstDue.dueDate.getTime() + 95 * 86_400_000)
    await database().tenantConfig.update({ where: { tenantId: fx.tenantId }, data: {
      defaultChargesEnabled: true, defaultChargesStartedAt: new Date(firstDue.dueDate.getTime() - 86_400_000),
    } })
    const swept = await sweepTenantCharges(database() as unknown as SweepDb, fx.tenantId, asOf, { source: "asset-nca-it" })
    expect(swept.failures).toEqual([])

    const lender = await getLenderIdentity(fx.tenantId)
    for (const loanId of [entityDeal.loanId, naturalDeal.loanId]) {
      const loan = await database().loan.findUniqueOrThrow({
        where: { id: loanId, tenantId: fx.tenantId },
        include: { ...SECTION129_BORROWER_INCLUDE, repaymentSchedule: { orderBy: { installmentNo: "asc" } } },
      })
      expect(evaluateCollectionsEligibility(loan, "SECTION_129")).toMatchObject({ eligible: true, minimumDaysInArrears: 90 })
      const addressee = section129Addressee(loan)
      expect(addressee).not.toBeNull()
      if (!addressee) throw new Error("NCA borrower has no s129 addressee")
      const attachments = await buildSection129Attachments({
        lender,
        client: {
          firstName: addressee.firstName, lastName: addressee.lastName, idNumber: addressee.identityNumber,
          identityLabel: addressee.identityLabel, addressLine1: addressee.addressLine1 ?? undefined, city: addressee.city ?? undefined,
        },
        loan: {
          reference: loan.reference, arrearsAmount: loan.arrearsAmount + loan.chargesOutstanding,
          outstandingPrincipal: loan.outstandingPrincipal, daysInArrears: loan.daysInArrears,
          chargesOutstanding: loan.chargesOutstanding,
        },
        noticeDate: asOf,
      })
      expect(attachments[0].content.subarray(0, 5).toString()).toBe("%PDF-")
      if (loan.entityId) expect(addressee.identityLabel).toBe("Registration no.")
      else expect(addressee.identityLabel).toBe("ID")
    }

    const before = await database().loan.findUniqueOrThrow({ where: { id: naturalDeal.loanId } })
    const receipt = await applyManualReceipt(database() as unknown as PaymentDb, {
      loanId: naturalDeal.loanId, tenantId: fx.tenantId,
      amount: Math.min(1_000_000, before.arrearsAmount + before.chargesOutstanding),
      paymentMethod: "EFT", reference: before.reference, capturedById: fx.adminA,
    })
    expect(receipt.payment.allocationStatus).toBe("ALLOCATED")
    const after = await database().loan.findUniqueOrThrow({ where: { id: naturalDeal.loanId } })
    expect(receipt.payment.amount).toBeGreaterThan(0)
    expect(after.outstandingPrincipal).toBeLessThanOrEqual(before.outstandingPrincipal)
    expect(after.totalPaid > before.totalPaid || after.chargesOutstanding < before.chargesOutstanding).toBe(true)
  })

  it("records s127 surrender, timely valuation, notices, proceeds and shortfall through real routes", async () => {
    const deal = await dealRow(deals.natural)
    if (!deal.loanId) throw new Error("Natural NCA fixture was not booked")
    const request = (path: string, method: string, body?: unknown) => new NextRequest(`http://${fx.host}${path}`, {
      method, headers: { host: fx.host, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    signInClient(fx.director)
    const opened = await requestSurrenderRoute(request(`/api/portal/asset-finance/loans/${deal.loanId}/surrender`, "POST", {
      assetCondition: "Synthetic asset remains operable with ordinary test wear.",
    }), { params: Promise.resolve({ loanId: deal.loanId }) })
    expect(opened.status).toBe(201)
    const surrenderId = (await opened.json() as { id: string }).id
    await expect(database().surrenderRequest.update({ where: { id: surrenderId }, data: { status: "VALUATION_NOTICE_ISSUED" } })).rejects.toThrow(/follows request, valuation/)

    signIn(fx.adminA, "LOAN_ADMIN")
    const valued = await valuationRoute(request(`/api/asset-finance/surrenders/${surrenderId}/valuation`, "POST", {
      valuedOn: sastCalendarDate(new Date()), source: "ASSESSOR", valuerName: "TEST Independent Valuer", amountCents: 120_000_000,
    }), { params: Promise.resolve({ id: surrenderId }) })
    expect(valued.status).toBe(200)
    expect((await valuationNoticeRoute(request(`/api/asset-finance/surrenders/${surrenderId}/valuation-notice`, "POST", {}), { params: Promise.resolve({ id: surrenderId }) })).status).toBe(200)
    expect((await proceedsRoute(request(`/api/asset-finance/surrenders/${surrenderId}/proceeds`, "POST", { saleProceedsCents: 100_000_000 }), { params: Promise.resolve({ id: surrenderId }) })).status).toBe(200)
    expect((await finalNoticeRoute(request(`/api/asset-finance/surrenders/${surrenderId}/final-notice`, "POST", {}), { params: Promise.resolve({ id: surrenderId }) })).status).toBe(200)

    const row = await database().surrenderRequest.findUniqueOrThrow({ where: { id: surrenderId } })
    expect(row).toMatchObject({ status: "FINAL_NOTICE_ISSUED", saleProceedsCents: 100_000_000, refundCents: 0 })
    expect(row.shortfallCents).toBeGreaterThan(0)
    expect(row.valuationNoticeSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(row.finalNoticeSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(await database().payment.count({ where: { tenantId: fx.tenantId, loanId: deal.loanId, reference: `S127-${surrenderId}` } })).toBe(1)
    await expect(database().$transaction(async (tx) => {
      await tx.$executeRawUnsafe('ALTER TABLE "SurrenderRequest" DISABLE TRIGGER "SurrenderRequest_guard"')
      await tx.surrenderRequest.update({ where: { id: surrenderId }, data: { proceedsPaymentId: `missing-payment-${t}` } })
    })).rejects.toThrow(/foreign key constraint|SurrenderRequest_tenantId_proceedsPaymentId_fkey/i)

    signInClient(fx.director)
    const document = await portalSurrenderDocumentRoute(request(`/api/portal/asset-finance/surrenders/${surrenderId}/documents/final`, "GET"), {
      params: Promise.resolve({ id: surrenderId, kind: "final" }),
    })
    expect(document.status).toBe(200)
    expect(document.headers.get("content-type")).toBe("application/pdf")
    expect(await database().documentAccessLog.count({ where: { documentId: `${surrenderId}:final`, accessorId: fx.director } })).toBe(1)
  })

  it("submits the evidenced R2m company's deal: SUBMITTED, awaiting the second approver", async () => {
    signIn(fx.officer, "CREDIT_OFFICER")
    const created = await routes().create({ ...structure(fx.assets[1]), entityId: fx.evidenced, supplierId: fx.supplier, productId: fx.product })
    deals.approved = (await created.json()).id
    const response = await routes().submit(deals.approved)
    expect(await response.json()).toMatchObject({ refusedNca: false, awaitingRegimeApproval: true, deal: { status: "SUBMITTED" } })
    const row = await dealRow(deals.approved)
    expect(row.application).toMatchObject({ status: "SUBMITTED", ncaRegime: "NCA", ncaClassificationRule: "JURISTIC_OVER_THRESHOLD" })
    expect(await database().ncaRegimeOverride.findFirstOrThrow({ where: { applicationId: row.applicationId } }))
      .toMatchObject({ status: "PENDING", toRegime: "NON_NCA", requestedById: fx.officer })
  })

  it("runs the consumer bureau check for the director and lists it on the deal", async () => {
    signIn(fx.officer, "CREDIT_OFFICER")
    const response = await routes().bureau(deals.approved)
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.results).toEqual([{ clientId: fx.director, role: "DIRECTOR", outcome: "stored" }])
    expect(body.deal.bureau).toEqual([expect.objectContaining({ clientId: fx.director, outcome: "stored", provider: "experian" })])
    const row = await dealRow(deals.approved)
    expect(await database().creditBureauCheck.count({ where: { applicationId: row.applicationId, clientId: fx.director } })).toBe(1)
    expect(await audits(deals.approved, "ASSET_DEAL_BUREAU_CHECKED")).toHaveLength(1)
  })

  it("APPROVE while the override is pending is 409 and audited; nothing changes", async () => {
    signIn(fx.adminA, "LOAN_ADMIN")
    const response = await routes().decide(deals.approved, { decision: "APPROVE", reasons: REASONS })
    expect(response.status).toBe(409)
    expect((await response.json()).error).toBe("The NON_NCA override awaits a second approver")
    expect((await dealRow(deals.approved)).status).toBe("SUBMITTED")
    expect(await audits(deals.approved, "ASSET_DEAL_DECISION_REFUSED")).toEqual([
      expect.objectContaining({ newValue: expect.objectContaining({ reason: "awaiting_regime_approval" }) }),
    ])
  })

  it("a second LOAN_ADMIN approves the override; APPROVE then needs the credit memo and reasons", async () => {
    const row = await dealRow(deals.approved)
    const override = await database().ncaRegimeOverride.findFirstOrThrow({ where: { applicationId: row.applicationId } })
    signIn(fx.adminB, "LOAN_ADMIN")
    expect((await routes().decideOverride(override.id, { decision: "APPROVE", note: "AFS agree with CIPC" })).status).toBe(200)
    expect((await dealRow(deals.approved)).application.ncaRegime).toBe("NON_NCA")

    signIn(fx.adminA, "LOAN_ADMIN")
    const noMemo = await routes().decide(deals.approved, { decision: "APPROVE", reasons: REASONS })
    expect(noMemo.status).toBe(409)
    expect((await noMemo.json()).error).toMatch(/credit memo/)
    expect((await routes().decide(deals.approved, { decision: "APPROVE", reasons: [] })).status).toBe(400)
    expect((await routes().decide(deals.approved, { decision: "APPROVE", reasons: ["ok  "] })).status).toBe(400)
  })

  it("records the credit memo with DSCR and gearing from the deal's own schedule", async () => {
    signIn(fx.officer, "CREDIT_OFFICER")
    const response = await routes().financials(deals.approved, {
      periodEnd: "2026-02-28", turnoverCents: 200_000_000, ebitdaCents: 60_000_000, totalAssetsCents: 200_000_000,
      totalLiabilitiesCents: 50_000_000, existingDebtServiceCents: 10_000_000, avgMonthlyCreditsCents: 16_000_000, returnedDebitsCount: 1,
    })
    expect(response.status).toBe(200)
    const { deal } = await response.json()
    // Independent working: 60 equal monthly rows (no balloon) → annual = 12 × the mean row total.
    const rows: Array<{ totalCents: number }> = deal.schedule.result.rows
    const annual = Math.round((rows.reduce((s, r) => s + r.totalCents, 0) * 12) / rows.length)
    expect(deal.financials).toMatchObject({ gearing: "0.2500", dscr: (60_000_000 / (10_000_000 + annual)).toFixed(4) })
    const stored = await database().entityFinancials.findUniqueOrThrow({ where: { dealId: deals.approved } })
    expect(stored.turnoverCents).toBe(BigInt(200_000_000))
    expect(stored.gearing?.toFixed(4)).toBe("0.2500")
  })

  it("APPROVE with reasons: application APPROVED NON_NCA (EFT, approver), deal APPROVED, audited with the reasons", async () => {
    signIn(fx.adminA, "LOAN_ADMIN")
    const response = await routes().decide(deals.approved, { decision: "APPROVE", reasons: REASONS })
    expect(response.status).toBe(200)
    const row = await dealRow(deals.approved)
    expect(row).toMatchObject({ status: "APPROVED", decision: "APPROVE", decisionReasons: REASONS, decidedById: fx.adminA })
    expect(row.application).toMatchObject({
      status: "APPROVED", ncaRegime: "NON_NCA", repaymentMethod: "EFT", approvedById: fx.adminA, approvedAmount: 155_250_000,
    })
    expect(row.application.approvedAt).toBeInstanceOf(Date)
    const [decided] = await audits(deals.approved, "ASSET_DEAL_DECIDED")
    expect(decided).toMatchObject({ userId: fx.adminA, newValue: { decision: "APPROVE", reasons: REASONS, applicationStatus: "APPROVED" } })
  })

  it("DECLINE needs reasons too; with them the application and deal are DECLINED and audited", async () => {
    signIn(fx.officer, "CREDIT_OFFICER")
    const created = await routes().create({ ...structure(fx.assets[2]), entityId: fx.evidenced, supplierId: fx.supplier, productId: fx.product })
    deals.declined = (await created.json()).id
    await routes().submit(deals.declined)

    signIn(fx.adminA, "LOAN_ADMIN")
    expect((await routes().decide(deals.declined, { decision: "DECLINE" })).status).toBe(400)
    expect((await routes().decide(deals.declined, { decision: "DECLINE", reasons: ["   "] })).status).toBe(400)
    expect((await dealRow(deals.declined)).status).toBe("SUBMITTED")

    const reasons = ["Gearing above policy for plant hire"]
    expect((await routes().decide(deals.declined, { decision: "DECLINE", reasons })).status).toBe(200)
    const row = await dealRow(deals.declined)
    expect(row).toMatchObject({ status: "DECLINED", decision: "DECLINE", decisionReasons: reasons })
    expect(row.application).toMatchObject({ status: "DECLINED", decisionReason: reasons[0] })
    expect(await audits(deals.declined, "ASSET_DEAL_DECIDED")).toEqual([
      expect.objectContaining({ newValue: expect.objectContaining({ decision: "DECLINE", reasons }) }),
    ])
  })
})
