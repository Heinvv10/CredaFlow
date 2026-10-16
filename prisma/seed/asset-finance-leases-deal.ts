/**
 * Origination and booking of the lease demo deals, through the lib functions
 * the deal, signing, payout and booking routes call (parseDealCreate →
 * createDeal, submitDeal, recordDealFinancials, decideDeal, then the shared
 * signing / checklist / payout / book steps of ./asset-finance-execution.ts).
 * Each step runs only from the state before it, so a rerun writes nothing.
 *
 * "History" is not backdated: no trigger is bypassed. A booked lease's first
 * rental falls due a month out, so the seed pays its first rentals by early
 * receipts (applyManualReceipt, the manual-receipt path), and the receipt path
 * invoices each rental it reached (time of supply = the receipt; lib/
 * asset-finance/lease-invoices.ts), which is also what funds a maintenance fund.
 */
import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { sastCalendarDate } from "@/lib/date/sast"
import { applyManualReceipt } from "@/lib/loan/apply-payment"
import { parseDealCreate } from "@/lib/asset-finance/deal-input"
import { createDeal } from "@/lib/asset-finance/deal-create"
import { submitDeal } from "@/lib/asset-finance/deal-submit"
import { parseCreditMemoInput } from "@/lib/asset-finance/credit-memo-input"
import { recordDealFinancials } from "@/lib/asset-finance/deal-financials"
import { decideDeal } from "@/lib/asset-finance/deal-decision"
import { addMonthsClamped, isoOfDbDate } from "@/lib/asset-finance/dates"
import { demoLender } from "../demo-lender"
import type { SeedActor } from "./asset-finance-documents"
import { dealActor, type SeedStaff } from "./asset-finance-deal"
import { confirmChecklist, payOutAndBook, signAndContract } from "./asset-finance-execution"
import { LEASE_PRODUCT_CODE, LEASE_SOLE_PROP, type LeaseSpec } from "./asset-finance-leases-data"

/**
 * The lease product: as the instalment-sale product (./asset-finance-book.ts) with a 90-day
 * minimum term, so a 5-rental lease is bookable. UNTESTED: legal — the lender's minimum lease term.
 */
export async function ensureLeaseProduct(tenantId: string): Promise<string> {
  const product = await prisma.loanProduct.upsert({
    where: { tenantId_code: { tenantId, code: LEASE_PRODUCT_CODE } },
    update: {},
    create: {
      tenantId, code: LEASE_PRODUCT_CODE, name: "Plant & Vehicle Lease", productType: "PERSONAL",
      minAmount: 10_000_000, maxAmount: 1_000_000_000, minTermDays: 90, maxTermDays: 3_660,
      interestRatePm: 0.01, interestModel: "REDUCING_BALANCE",
      nonNcaDefaultInterestMargin: new Prisma.Decimal("0.02"), nonNcaCollectionFeeCents: 25_000,
      active: true,
    },
    select: { id: true },
  })
  return product.id
}

export interface LeaseParties {
  entityId: string | null
  clientId: string | null
  assetId: string
  supplierId: string
  productId: string
}

/** On the demo lender's client domain, as the other synthetic clients (prisma/demo-lender.ts). */
export const leaseClientEmail = () => `zanele.baker@${demoLender().clientDomain}`

/** The sole proprietor lessee (a Client with an address, as a tax invoice needs). KYC stays PENDING, no portal login. */
export async function ensureLeaseClient(tenantId: string): Promise<string> {
  const p = LEASE_SOLE_PROP
  const existing = await prisma.client.findFirst({ where: { tenantId, idNumber: p.idNumber }, select: { id: true } })
  if (existing) return existing.id
  const created = await prisma.client.create({
    data: {
      tenantId, reference: p.reference, idNumber: p.idNumber, firstName: p.firstName, lastName: p.lastName,
      dateOfBirth: new Date(p.dob), gender: p.gender, email: leaseClientEmail(), phone: p.phone, whatsapp: p.phone,
      addressLine1: "5 Bakery Lane", city: "Benoni", province: "Gauteng", postalCode: "0005",
      employmentStatus: "SELF_EMPLOYED", kycStatus: "PENDING", popiaConsentGiven: true, popiaConsentAt: new Date(),
    },
    select: { id: true },
  })
  return created.id
}

function leaseBody(spec: LeaseSpec, parties: LeaseParties, today: string): Record<string, unknown> {
  return {
    assetId: parties.assetId, supplierId: parties.supplierId, productId: parties.productId,
    ...(parties.entityId ? { entityId: parties.entityId } : { clientId: parties.clientId }),
    contractType: spec.contractType, rentalTiming: spec.rentalTiming, balloonCents: spec.residualCents,
    firstDueDate: addMonthsClamped(today, 1), preset: { kind: "MONTHLY", periods: spec.periods },
    rateBasis: "PRIME", rateMargin: "0.0100", escalationRate: "0.08", earlyTerminationPenaltyRate: "0.1",
    ...(spec.fml ? { ...spec.fml, maintenanceEscalationRate: "0.065" } : {}),
  }
}

async function createLeaseDeal(tenantId: string, officer: SeedActor, spec: LeaseSpec, parties: LeaseParties, today: string): Promise<string> {
  const parsed = parseDealCreate(leaseBody(spec, parties, today), today)
  if ("errors" in parsed) throw new Error(`Seed lease refused: ${JSON.stringify(parsed.errors)}`)
  const result = await prisma.$transaction((tx) => createDeal(tx, { ...dealActor(tenantId, officer), input: parsed.data }))
  if (result.kind !== "created") throw new Error(`Seed lease refused (${result.status}): ${result.error}`)
  return result.dealId
}

/** The lease deal to APPROVED: created and submitted by the officer, memo recorded, approved by the first loan admin. */
export async function originateLease(tenantId: string, staff: SeedStaff, spec: LeaseSpec, parties: LeaseParties, today: string): Promise<string> {
  const found = await prisma.assetFinanceDeal.findFirst({
    where: { tenantId, assetId: parties.assetId, ...(parties.entityId ? { entityId: parties.entityId } : { clientId: parties.clientId }) },
    orderBy: { createdAt: "desc" },
    select: { id: true, status: true, financials: { select: { id: true } } },
  })
  const dealId = found?.id ?? await createLeaseDeal(tenantId, staff.officer, spec, parties, today)
  const officer = dealActor(tenantId, staff.officer)
  if (!found || found.status === "DRAFT") {
    const submitted = await prisma.$transaction((tx) => submitDeal(tx, officer, dealId))
    if (submitted.kind !== "submitted") throw new Error(`Seed: the ${spec.key} lease should be submitted, got ${JSON.stringify(submitted)}`)
  }
  const deal = await prisma.assetFinanceDeal.findFirstOrThrow({ where: { id: dealId, tenantId }, select: { status: true, financials: { select: { id: true } } } })
  if (deal.status !== "SUBMITTED") return dealId
  if (!deal.financials) {
    const memo = parseCreditMemoInput({ periodEnd: "2026-02-28", returnedDebitsCount: 0, ...spec.memo }, today)
    if ("errors" in memo) throw new Error(`Seed lease credit memo refused: ${JSON.stringify(memo.errors)}`)
    const recorded = await prisma.$transaction((tx) => recordDealFinancials(tx, officer, dealId, memo.data))
    if (recorded.kind !== "recorded") throw new Error(`Seed: ${spec.key} lease credit memo not recorded (${recorded.kind})`)
  }
  const decided = await prisma.$transaction((tx) => decideDeal(tx, dealActor(tenantId, staff.adminOne), dealId, {
    decision: "APPROVE", reasons: ["Lessee cash flow comfortably covers the rental", "Lessor-owned asset, insured with the lender's interest noted and tracked"],
  }))
  if (decided.kind !== "decided" || decided.status !== "APPROVED") throw new Error(`Seed: ${spec.key} lease approval refused (${JSON.stringify(decided)})`)
  return dealId
}

/** Pay the first `count` rentals by early receipts (each rental once), through the manual-receipt path, which invoices them. */
async function payFirstRentals(tenantId: string, officer: SeedActor, loanId: string, count: number): Promise<void> {
  const loan = await prisma.loan.findFirstOrThrow({ where: { id: loanId, tenantId }, select: { reference: true } })
  const rows = await prisma.repaymentSchedule.findMany({
    where: { tenantId, loanId, totalDue: { gt: 0 } }, orderBy: { installmentNo: "asc" }, take: count,
    select: { installmentNo: true, totalDue: true, totalPaid: true },
  })
  for (const row of rows.filter((r) => r.totalPaid < r.totalDue)) {
    await applyManualReceipt(prisma, {
      loanId, tenantId, amount: row.totalDue - row.totalPaid, paymentMethod: "EFT", reference: loan.reference,
      notes: `Early receipt of rental ${row.installmentNo}`,
      capturedById: officer.id, capturedByEmail: officer.email,
      idempotencyKey: `seed-af-${loan.reference}-${row.installmentNo}`,
    })
  }
}

/** The loan's start: the booking day, or the first due date for a rental in advance (it falls due on commencement). */
async function plannedStart(tenantId: string, dealId: string, today: string): Promise<string> {
  const deal = await prisma.assetFinanceDeal.findFirstOrThrow({ where: { id: dealId, tenantId }, select: { rentalTiming: true, firstDueDate: true } })
  return deal.rentalTiming === "ADVANCE" ? isoOfDbDate(deal.firstDueDate) : today
}

/** APPROVED → BOOKED today (signed by the lessee's representative), then its first rentals paid and invoiced. Returns the loan id. */
export async function executeLease(
  tenantId: string, staff: SeedStaff, spec: LeaseSpec, dealId: string,
  lessee: { representativeId: string; entityId: string | null; clientId: string | null },
): Promise<string> {
  const today = sastCalendarDate(new Date())
  const status = async () => (await prisma.assetFinanceDeal.findFirstOrThrow({ where: { id: dealId, tenantId }, select: { status: true } })).status
  if ((await status()) === "APPROVED") await signAndContract(tenantId, staff, dealId, lessee.representativeId, await plannedStart(tenantId, dealId, today))
  if ((await status()) === "CONTRACTED") {
    await confirmChecklist(tenantId, staff.officer, dealId, { entityId: lessee.entityId, clientId: lessee.clientId })
    await payOutAndBook(tenantId, staff, dealId, today)
  }
  const deal = await prisma.assetFinanceDeal.findFirstOrThrow({ where: { id: dealId, tenantId }, select: { status: true, loanId: true } })
  if (deal.status !== "BOOKED" || !deal.loanId) throw new Error(`Seed: the ${spec.key} lease should be BOOKED, it is ${deal.status}`)
  await payFirstRentals(tenantId, staff.officer, deal.loanId, spec.rentalsPaidEarly)
  return deal.loanId
}
