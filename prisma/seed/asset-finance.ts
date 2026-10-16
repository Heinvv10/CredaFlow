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
 *     Authority, R800 000 turnover → classifier NCA; finance lease with a
 *     balloon, entity PASQ acknowledgement, portal signing and BOOKED today.
 * (b) TEST sole proprietor: TLB instalment sale, NCA affordability and
 *     accepted bundled credit life, portal signing and BOOKED today.
 * (c) TEST Earthmoving (Pty) Ltd: verified AFS (R25m turnover), a director
 *     who is also authorised signatory and surety, a separate surety; an
 *     excavator at R1 725 000 incl. VAT on ANNUAL_SEASONAL (Apr–Jun ×3,
 *     others ×0.5, 60 months), 20% balloon, PRIME + 1.00%; NON_NCA by the
 *     classifier's override, approved; signed, contracted, paid out and
 *     BOOKED today, then part-paid by an early receipt of the first
 *     instalment, so it shows a payment and a reduced balance, no arrears.
 *
 * (d) Three leases (slice 3, ./asset-finance-leases.ts), after the above, on the
 *     company, a new sole-proprietor client and the trust: a full-maintenance
 *     lease with claims and readings, a CPA operating lease with an
 *     early-termination quote, and a trust lease with its RETURN elected (the
 *     inspection waits for the term's end, which a seed run on the booking day
 *     cannot reach).
 *
 * (e) Recoveries (slice 4a, ./asset-finance-recovery.ts): the TLB taken through its legal matter and an s131
 *     recovery to a shortfall, and the company lease recovered and listed.
 *
 * DATES. Every rule runs as the app runs it, on today (SAST): each deal's
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
import { ensureAsset, ensureCreditLifeProduct, ensurePrime, ensureProduct, ensureRepo, ensureSupplier, ensureVatConfig } from "./asset-finance-book"
import { originateCompanyDeal, seedTrustDeal, type SeedStaff } from "./asset-finance-deal"
import { executeCompanyDeal } from "./asset-finance-execution"
import { COMPANY, EXCAVATOR, TLB, TRACTOR, TRUST } from "./asset-finance-data"
import { seedNaturalNcaDeal } from "./asset-finance-nca-natural"
import { seedLeases } from "./asset-finance-leases"
import { seedRecoveries } from "./asset-finance-recovery"

export type { SeedStaff } from "./asset-finance-deal"

export async function seedAssetFinance(tenantId: string, staff: SeedStaff): Promise<void> {
  const { officer, adminOne, adminTwo } = staff
  await runWithTenant(tenantId, async () => {
    const lender = await getLenderIdentity(tenantId)
    await ensureVatConfig(tenantId, lender.legalName, lender.registeredOfficeLines.join(", "))
    await ensurePrime(tenantId, adminOne, adminTwo)
    await ensureRepo(tenantId, adminOne, adminTwo)
    const productId = await ensureProduct(tenantId)
    await ensureCreditLifeProduct(tenantId)
    const supplierId = await ensureSupplier(tenantId, officer, adminOne)
    const people = await ensurePeople(tenantId)

    // (a) The trust: NCA finance lease, booked through the regulated path.
    const trust = await ensureEntity(tenantId, officer, { ...TRUST })
    await linkPerson(tenantId, officer, trust, people.trusteeOne, ["TRUSTEE"], "NATURAL")
    await linkPerson(tenantId, officer, trust, people.trusteeTwo, ["TRUSTEE"], "NATURAL")
    await ensureDocument(tenantId, officer, trust.id, "TRUST_DEED", "Trust deed - Botha Family Farming Trust")
    const loa = await ensureDocument(tenantId, officer, trust.id, "LETTERS_OF_AUTHORITY", "Letters of Authority - Botha Family Farming Trust")
    await verifyDocument(tenantId, adminOne, trust.id, loa)
    const tractor = await ensureAsset(tenantId, officer, TRACTOR)
    const trustDealId = await seedTrustDeal(tenantId, staff, { entityId: trust.id, assetId: tractor, supplierId, productId }, people.trusteeOne)
    await executeCompanyDeal(tenantId, staff, trustDealId, { directorId: people.trusteeOne, entityId: trust.id }, sastCalendarDate(new Date()))

    // (b) Sole-proprietor TLB instalment sale: NCA, credit life, booked.
    const tlb = await ensureAsset(tenantId, officer, TLB)
    await seedNaturalNcaDeal(tenantId, staff, { clientId: people.director, assetId: tlb, supplierId, productId }, sastCalendarDate(new Date()))

    // (c) The company: booked and part-paid.
    const company = await ensureEntity(tenantId, officer, { ...COMPANY })
    await linkPerson(tenantId, officer, company, people.director, ["DIRECTOR", "AUTHORISED_SIGNATORY", "SURETY"])
    await linkPerson(tenantId, officer, company, people.surety, ["SURETY"])
    await ensureDocument(tenantId, officer, company.id, "CIPC_REGISTRATION", "CIPC registration - Ridgeback Earthmoving (Pty) Ltd")
    await ensureDocument(tenantId, officer, company.id, "RESOLUTION", "Board resolution to finance - Ridgeback Earthmoving (Pty) Ltd")
    const afs = await ensureDocument(tenantId, officer, company.id, "AFS", "Audited AFS FY2026 (turnover R25 000 000) - Ridgeback Earthmoving (Pty) Ltd")
    await verifyDocument(tenantId, adminOne, company.id, afs)
    await setFinancialsEvidence(tenantId, officer, company.id, [afs])
    const excavator = await ensureAsset(tenantId, officer, EXCAVATOR)
    const parties = { entityId: company.id, assetId: excavator, supplierId, productId }

    const today = sastCalendarDate(new Date())
    const dealId = await originateCompanyDeal(tenantId, staff, parties, today)
    await executeCompanyDeal(tenantId, staff, dealId, { directorId: people.director, entityId: company.id }, today)

    // (d) The leases, on the entities above.
    await seedLeases({
      tenantId, staff, supplierId,
      company: { entityId: company.id, directorId: people.director },
      trust: { entityId: trust.id, trusteeId: people.trusteeOne },
    })

    // (e) Recoveries (slice 4a): the TLB through its legal matter to a shortfall, the company's lease listed.
    await seedRecoveries({ tenantId, staff, tlb: { clientId: people.director, assetId: tlb }, companyEntityId: company.id })
  })
}
