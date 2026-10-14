/**
 * The lease demo deals of the asset-finance seed (slice 3, goal C12), written
 * through the real lib functions (./asset-finance-leases-deal.ts originates and
 * books, ./asset-finance-leases-servicing.ts services) on the entities and
 * people of ./asset-finance.ts, after its instalment deals:
 *
 *   1. TEST Earthmoving (Pty) Ltd: full-maintenance lease of a TLB, maintenance
 *      risk with the lender; three rentals paid and invoiced; two maintenance
 *      claims (one paid, one submitted) and three meter readings.
 *   2. TEST sole proprietor (a Client): operating lease of a registered bakkie,
 *      CPA applies; an early-termination quote, QUOTED and not accepted.
 *   3. TEST Family Farming Trust: full-maintenance lease of a forklift, fund
 *      settled by the lessee; a 5-rental term, so the end-of-term choice is
 *      open at booking: RETURN elected and inspected (a damage line, excess
 *      usage), not yet invoiced.
 *
 * Idempotent: every step runs only from the state before it.
 */
import { getLenderIdentity } from "@/lib/config/identity"
import { sastCalendarDate } from "@/lib/date/sast"
import { ensureAsset } from "./asset-finance-book"
import type { SeedStaff } from "./asset-finance-deal"
import { LEASES, LEASE_BAKKIE, LEASE_FORKLIFT, LEASE_TLB, type LeaseAsset, type LeaseSpec } from "./asset-finance-leases-data"
import { ensureLeaseClient, ensureLeaseProduct, executeLease, originateLease, type LeaseParties } from "./asset-finance-leases-deal"
import { seedCompanyFmlServicing, seedSoleQuote, seedTrustEndOfTerm } from "./asset-finance-leases-servicing"

export interface LeaseSeedContext {
  tenantId: string
  staff: SeedStaff
  supplierId: string
  company: { entityId: string; directorId: string }
  trust: { entityId: string; trusteeId: string }
}

/** The lessor owns a registered vehicle: its eNaTIS titleholder and owner are the lender. */
async function ensureLeaseAsset(ctx: LeaseSeedContext, asset: LeaseAsset, lenderName: string): Promise<string> {
  const lessorOwned = asset.registrationNumber ? { natisTitleholder: lenderName, natisOwner: lenderName } : {}
  return ensureAsset(ctx.tenantId, ctx.staff.officer, { ...asset, ...lessorOwned })
}

async function bookLease(ctx: LeaseSeedContext, spec: LeaseSpec, parties: LeaseParties, representativeId: string): Promise<string> {
  const dealId = await originateLease(ctx.tenantId, ctx.staff, spec, parties, sastCalendarDate(new Date()))
  return executeLease(ctx.tenantId, ctx.staff, spec, dealId, { representativeId, entityId: parties.entityId, clientId: parties.clientId })
}

export async function seedLeases(ctx: LeaseSeedContext): Promise<void> {
  const { tenantId, staff, supplierId } = ctx
  const productId = await ensureLeaseProduct(tenantId)
  const lenderName = (await getLenderIdentity(tenantId)).legalName

  const tlb = await ensureLeaseAsset(ctx, LEASE_TLB, lenderName)
  const companyLoan = await bookLease(ctx, LEASES.companyFml, { entityId: ctx.company.entityId, clientId: null, assetId: tlb, supplierId, productId }, ctx.company.directorId)
  await seedCompanyFmlServicing(tenantId, staff, { loanId: companyLoan, entityId: ctx.company.entityId, supplierId, directorId: ctx.company.directorId })

  const lesseeId = await ensureLeaseClient(tenantId)
  const bakkie = await ensureLeaseAsset(ctx, LEASE_BAKKIE, lenderName)
  const soleLoan = await bookLease(ctx, LEASES.soleOl, { entityId: null, clientId: lesseeId, assetId: bakkie, supplierId, productId }, lesseeId)
  await seedSoleQuote(tenantId, staff.officer, soleLoan)

  const forklift = await ensureLeaseAsset(ctx, LEASE_FORKLIFT, lenderName)
  const trustLoan = await bookLease(ctx, LEASES.trustFml, { entityId: ctx.trust.entityId, clientId: null, assetId: forklift, supplierId, productId }, ctx.trust.trusteeId)
  await seedTrustEndOfTerm(tenantId, staff.officer, trustLoan)
}
