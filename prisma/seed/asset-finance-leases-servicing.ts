/**
 * Servicing history of the lease demo deals (./asset-finance-leases.ts), through
 * the lib functions the lease routes call: maintenance claims (submit, approve
 * with four-eyes, paid), meter readings (staff and portal), an early-termination
 * quote, and a lease's end of term (a return elected; it is inspected once the
 * term ends, which a seed run on the booking day cannot reach). The first
 * actions of a lease happen on its booking day: a reading is dated no earlier
 * than the lease and a claim needs an ACTIVE lease, so nothing here is backdated.
 * Each step runs only from the state before it, so a rerun writes nothing.
 */
import { prisma } from "@/lib/prisma"
import { sastCalendarDate } from "@/lib/date/sast"
import { storeEntityDocument } from "@/lib/asset-finance/entity-document-io"
import { STAFF_UPLOAD_DOC_TYPES } from "@/lib/asset-finance/entity-documents"
import { recordMeterReading } from "@/lib/asset-finance/meter-readings"
import { approveMaintenanceClaim, markMaintenanceClaimPaid, submitMaintenanceClaim } from "@/lib/asset-finance/maintenance-claims"
import { quoteEarlyTermination } from "@/lib/asset-finance/lease-termination-store"
import { electEndOfTerm } from "@/lib/asset-finance/lease-end-of-term"
import { syntheticUpload, type SeedActor } from "./asset-finance-documents"
import type { SeedStaff } from "./asset-finance-deal"

const today = () => sastCalendarDate(new Date())
const actorOf = (tenantId: string, a: SeedActor) => ({ tenantId, userId: a.id, userEmail: a.email })

/** Readings of the company lease: two by staff and one reported by the director in the portal, all today. */
async function ensureReadings(tenantId: string, officer: SeedActor, loanId: string, directorId: string): Promise<string> {
  const unit = "HOURS" as const
  const record = async (value: number, who: { userId: string } | { clientId: string }): Promise<string> => {
    const existing = await prisma.assetMeterReading.findFirst({ where: { tenantId, loanId, unit, value }, select: { id: true } })
    if (existing) return existing.id
    const result = await prisma.$transaction((tx) => recordMeterReading(tx, { tenantId, ...who } as Parameters<typeof recordMeterReading>[1], {
      loanId, readingDate: today(), value, evidenceDocumentId: null, today: today(),
    }))
    if (result.kind !== "recorded") throw new Error(`Seed: meter reading ${value} refused (${JSON.stringify(result)})`)
    return result.readingId
  }
  const first = await record(52, { userId: officer.id })
  await record(58, { userId: officer.id })
  await record(61, { clientId: directorId })
  return first
}

/** Submit a claim with the provider's invoice filed on the deal; approve (four-eyes) and mark it paid when `pay`. */
async function ensureClaim(
  tenantId: string, staff: SeedStaff,
  claim: { loanId: string; entityId: string; supplierId: string; description: string; amountExclVatCents: number; meterReadingId: string; pay: boolean },
): Promise<void> {
  const fund = await prisma.maintenanceFund.findFirstOrThrow({ where: { tenantId, loanId: claim.loanId }, select: { id: true } })
  const existing = await prisma.maintenanceClaim.findFirst({ where: { tenantId, fundId: fund.id, description: claim.description }, select: { id: true, status: true } })
  let claimId = existing?.id ?? ""
  let status: string = existing?.status ?? ""
  if (!existing) {
    const deal = await prisma.assetFinanceDeal.findFirstOrThrow({ where: { tenantId, loanId: claim.loanId }, select: { id: true } })
    const upload = await syntheticUpload("OTHER", `Provider invoice: ${claim.description} (TEST)`, STAFF_UPLOAD_DOC_TYPES, deal.id)
    const doc = await storeEntityDocument({
      tenantId, entityId: claim.entityId, upload, uploader: { type: "staff", id: staff.officer.id, email: staff.officer.email },
    })
    const submitted = await prisma.$transaction((tx) => submitMaintenanceClaim(tx, actorOf(tenantId, staff.officer), {
      loanId: claim.loanId, supplierId: claim.supplierId, providerInvoiceDocumentId: doc.id, meterReadingId: claim.meterReadingId,
      amountExclVatCents: claim.amountExclVatCents, description: claim.description, today: today(),
    }))
    if (submitted.kind !== "ok") throw new Error(`Seed: claim refused (${JSON.stringify(submitted)})`)
    claimId = submitted.claimId
    status = submitted.status
  }
  if (!claim.pay || status === "PAID") return
  // Never the submitter; at or above the tenant threshold a second, different approver follows the first.
  for (const approver of [staff.adminOne, staff.adminTwo]) {
    if (status !== "SUBMITTED") break
    const approved = await prisma.$transaction((tx) => approveMaintenanceClaim(tx, actorOf(tenantId, approver), claimId))
    if (approved.kind !== "ok") throw new Error(`Seed: claim approval refused (${JSON.stringify(approved)})`)
    status = approved.status
  }
  if (status === "APPROVED") {
    const paid = await prisma.$transaction((tx) => markMaintenanceClaimPaid(tx, actorOf(tenantId, staff.adminOne), claimId, "TEST-PAY-CLAIM-0001", today()))
    if (paid.kind !== "ok") throw new Error(`Seed: claim payment refused (${JSON.stringify(paid)})`)
  }
}

/** Lease 1: two claims (the first paid, the second awaiting approval) and its readings. */
export async function seedCompanyFmlServicing(
  tenantId: string, staff: SeedStaff, lease: { loanId: string; entityId: string; supplierId: string; directorId: string },
): Promise<void> {
  const readingId = await ensureReadings(tenantId, staff.officer, lease.loanId, lease.directorId)
  const base = { loanId: lease.loanId, entityId: lease.entityId, supplierId: lease.supplierId, meterReadingId: readingId }
  await ensureClaim(tenantId, staff, { ...base, description: "Hydraulic hose and seal replacement (TEST)", amountExclVatCents: 320_000, pay: true })
  await ensureClaim(tenantId, staff, { ...base, description: "Bucket pin and bush service (TEST)", amountExclVatCents: 185_000, pay: false })
}

/** Lease 2: an early-termination quote (a CPA lessee: 20 business days' notice), left QUOTED. */
export async function seedSoleQuote(tenantId: string, officer: SeedActor, loanId: string): Promise<void> {
  if (await prisma.leaseTerminationQuote.findFirst({ where: { tenantId, loanId }, select: { id: true } })) return
  const quoted = await prisma.$transaction((tx) => quoteEarlyTermination(tx, { tenantId, userId: officer.id }, { loanId, today: today() }))
  if (quoted.kind !== "quoted") throw new Error(`Seed: early-termination quote refused (${JSON.stringify(quoted)})`)
}

/**
 * Lease 3: RETURN elected, in the six months before its last rental. The
 * inspection waits for the term to end (the asset comes back then), so the
 * seed stops at ELECTED.
 */
export async function seedTrustEndOfTerm(tenantId: string, officer: SeedActor, loanId: string): Promise<void> {
  const actor = { tenantId, userId: officer.id }
  if (await prisma.leaseEndOfTerm.findFirst({ where: { tenantId, loanId }, select: { id: true } })) return
  const elected = await prisma.$transaction((tx) => electEndOfTerm(tx, actor, { loanId, outcome: "RETURN", today: today() }))
  if (elected.kind !== "ok") throw new Error(`Seed: end-of-term election refused (${JSON.stringify(elected)})`)
}
