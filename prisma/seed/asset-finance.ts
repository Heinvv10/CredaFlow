/**
 * Asset-finance demo data on the demo lender's tenant (slice 1, goal §4.13), behind
 * TenantConfig.featureAssetFinance (prisma/seed.ts turns it on). Every value
 * is synthetic (./asset-finance-data.ts). Everything is written through the
 * lib functions and parsers the asset-finance routes use, inside the tenant's
 * scope frame, so the database's triggers and CHECKs see the same writes the
 * app makes; staff steps are attributed to the seeded staff ids:
 *
 *   officer (CREDIT_OFFICER)  entities, people, documents, assets, the
 *                             supplier and its account request, deals,
 *                             credit memo, submit, signing prep, wet-ink
 *                             upload, contract, payout checklist, receipts
 *   adminOne (LOAN_ADMIN)     records PRIME, verifies documents, approves the
 *                             supplier account, approves the deal, confirms
 *                             the wet-ink scan, creates the payout, books
 *   adminTwo (LOAN_ADMIN)     approves PRIME, the NON_NCA override and the
 *                             payout (each the second pair of eyes)
 *
 * (a) TEST Family Farming Trust: two natural trustees, verified Letters of
 *     Authority, R800 000 turnover → classifier NCA → deal SUBMITTED into the
 *     entity-NCA path.
 * (b) TEST Earthmoving (Pty) Ltd: verified AFS (R25m turnover), a director
 *     who is also authorised signatory and surety, a separate surety; an
 *     excavator at R1 725 000 incl. VAT on ANNUAL_SEASONAL (Apr–Jun ×3,
 *     others ×0.5, 60 months), 20% balloon, PRIME + 1.00%; NON_NCA by the
 *     classifier's override, approved; signed, contracted, paid out and
 *     BOOKED today, then part-paid by an early receipt of the first
 *     instalment, so it shows a payment and a reduced balance, no arrears.
 *
 * DATES. Every rule runs as the app runs it, on today (SAST): the deal's
 * first instalment is a month out, the documents are prepared with the
 * planned start today, the deal is booked today (the tax invoice's supply
 * date), and the receipt is dated now. No trigger is bypassed.
 *
 * Idempotent: each step runs only from the state before it.
 */
import { runWithTenant } from "@/lib/tenant-scope"
import { getLenderIdentity } from "@/lib/config/identity"
import { sastCalendarDate } from "@/lib/date/sast"
import { ensureDocument, setFinancialsEvidence, verifyDocument } from "./asset-finance-documents"
import { ensurePeople, ensureEntity, linkPerson } from "./asset-finance-parties"
import { ensureAsset, ensurePrime, ensureProduct, ensureSupplier, ensureVatConfig } from "./asset-finance-book"
import { originateCompanyDeal, seedTrustDeal, type SeedStaff } from "./asset-finance-deal"
import { executeCompanyDeal } from "./asset-finance-execution"
import { COMPANY, EXCAVATOR, TRACTOR, TRUST } from "./asset-finance-data"

export type { SeedStaff } from "./asset-finance-deal"

export async function seedAssetFinance(tenantId: string, staff: SeedStaff): Promise<void> {
  const { officer, adminOne, adminTwo } = staff
  await runWithTenant(tenantId, async () => {
    const lender = await getLenderIdentity(tenantId)
    await ensureVatConfig(tenantId, lender.legalName, lender.registeredOfficeLines.join(", "))
    await ensurePrime(tenantId, adminOne, adminTwo)
    const productId = await ensureProduct(tenantId)
    const supplierId = await ensureSupplier(tenantId, officer, adminOne)
    const people = await ensurePeople(tenantId)

    // (a) The trust: submitted into the entity-NCA path.
    const trust = await ensureEntity(tenantId, officer, { ...TRUST })
    await linkPerson(tenantId, officer, trust, people.trusteeOne, ["TRUSTEE"], "NATURAL")
    await linkPerson(tenantId, officer, trust, people.trusteeTwo, ["TRUSTEE"], "NATURAL")
    await ensureDocument(tenantId, officer, trust.id, "TRUST_DEED", "Trust deed - TEST Family Farming Trust")
    const loa = await ensureDocument(tenantId, officer, trust.id, "LETTERS_OF_AUTHORITY", "Letters of Authority - TEST Family Farming Trust")
    await verifyDocument(tenantId, adminOne, trust.id, loa)
    const tractor = await ensureAsset(tenantId, officer, TRACTOR)
    await seedTrustDeal(tenantId, staff, { entityId: trust.id, assetId: tractor, supplierId, productId })

    // (b) The company: booked and part-paid.
    const company = await ensureEntity(tenantId, officer, { ...COMPANY })
    await linkPerson(tenantId, officer, company, people.director, ["DIRECTOR", "AUTHORISED_SIGNATORY", "SURETY"])
    await linkPerson(tenantId, officer, company, people.surety, ["SURETY"])
    await ensureDocument(tenantId, officer, company.id, "CIPC_REGISTRATION", "CIPC registration - TEST Earthmoving (Pty) Ltd")
    await ensureDocument(tenantId, officer, company.id, "RESOLUTION", "Board resolution to finance - TEST Earthmoving (Pty) Ltd")
    const afs = await ensureDocument(tenantId, officer, company.id, "AFS", "Audited AFS FY2026 (turnover R25 000 000) - TEST Earthmoving (Pty) Ltd")
    await verifyDocument(tenantId, adminOne, company.id, afs)
    await setFinancialsEvidence(tenantId, officer, company.id, [afs])
    const excavator = await ensureAsset(tenantId, officer, EXCAVATOR)
    const parties = { entityId: company.id, assetId: excavator, supplierId, productId }

    const today = sastCalendarDate(new Date())
    const dealId = await originateCompanyDeal(tenantId, staff, parties, today)
    await executeCompanyDeal(tenantId, staff, dealId, { directorId: people.director, entityId: company.id }, today)
  })
}
