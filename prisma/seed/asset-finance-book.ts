/**
 * The lender-side set-up of the asset-finance demo seed: the PRIME reference
 * rate (recorded by one loan admin, approved by another through
 * decideReferenceRate), the asset-finance product, the VAT vendor, the
 * supplier with a four-eyes APPROVED bank account, and the financed assets.
 * Inputs pass the routes' parsers; writes carry the routes' audit actions.
 * Idempotent: existing rows are found and kept.
 */
import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { sastCalendarDate } from "@/lib/date/sast"
import { parseReferenceRateInput } from "@/lib/asset-finance/reference-rate-input"
import { decideReferenceRate } from "@/lib/asset-finance/reference-rate-decision"
import { parseBankAccountRequest, parseSupplierCreate } from "@/lib/asset-finance/supplier-input"
import { decideSupplierBankAccount } from "@/lib/asset-finance/supplier-bank-decision"
import { parseAssetCreate } from "@/lib/asset-finance/asset-input"
import { dbDate } from "@/lib/asset-finance/dates"
import type { SeedActor } from "./asset-finance-documents"
import { AF_PRODUCT_CODE, PRIME, SUPPLIER, SUPPLIER_ACCOUNT, SUPPLIER_ACCOUNT_NOTE, VAT_VENDOR_NUMBER, type AfAsset } from "./asset-finance-data"

/** PRIME, recorded by `requester` and approved by `approver` (four-eyes). */
export async function ensurePrime(tenantId: string, requester: SeedActor, approver: SeedActor): Promise<void> {
  const input = parseReferenceRateInput(PRIME)
  if ("errors" in input) throw new Error(`Seed reference rate refused: ${JSON.stringify(input.errors)}`)
  let rate = await prisma.referenceRate.findFirst({
    where: { tenantId, basis: input.basis, effectiveDate: dbDate(input.effectiveDate), status: { not: "REJECTED" } },
  })
  if (!rate) {
    rate = await prisma.$transaction(async (tx) => {
      const row = await tx.referenceRate.create({
        data: { tenantId, basis: input.basis, effectiveDate: dbDate(input.effectiveDate), rate: new Prisma.Decimal(input.rate), requestedById: requester.id },
      })
      await logAuditStrict({
        tenantId, userId: requester.id, userEmail: requester.email,
        action: AuditAction.REFERENCE_RATE_RECORDED, entity: "ReferenceRate", entityId: row.id,
        newValue: { basis: row.basis, effectiveDate: input.effectiveDate, rate: row.rate.toString(), status: row.status },
      }, tx)
      return row
    })
  }
  if (rate.status === "APPROVED") return
  const rateId = rate.id
  const outcome = await prisma.$transaction((tx) => decideReferenceRate(tx, {
    tenantId, rateId, decision: "APPROVE", deciderId: approver.id, deciderEmail: approver.email, today: sastCalendarDate(new Date()),
  }))
  if (outcome.kind !== "decided") throw new Error(`Seed: PRIME approval refused (${outcome.kind})`)
}

/** The asset-finance product: NON_NCA arrears terms 2% over the contract rate and a R250 collection fee. */
export async function ensureProduct(tenantId: string): Promise<string> {
  const product = await prisma.loanProduct.upsert({
    where: { tenantId_code: { tenantId, code: AF_PRODUCT_CODE } },
    update: {},
    create: {
      tenantId, code: AF_PRODUCT_CODE, name: "Plant & Vehicle Instalment Sale", productType: "PERSONAL",
      minAmount: 10_000_000, maxAmount: 1_000_000_000, minTermDays: 180, maxTermDays: 3_660,
      // Indicative only: each deal carries its own contract rate (ContractRate).
      interestRatePm: 0.01, interestModel: "REDUCING_BALANCE",
      nonNcaDefaultInterestMargin: new Prisma.Decimal("0.02"), nonNcaCollectionFeeCents: 25_000,
      active: true,
    },
    select: { id: true },
  })
  return product.id
}

/** The tenant's VAT vendor details; the registered name is the tenant's legal name. */
export async function ensureVatConfig(tenantId: string, legalName: string, address: string): Promise<void> {
  await prisma.vatConfig.upsert({
    where: { tenantId },
    update: {},
    create: { tenantId, vatNumber: VAT_VENDOR_NUMBER, registeredName: legalName, address },
  })
}

/** The supplier and its APPROVED bank account: requested by `requester`, approved by `approver`. */
export async function ensureSupplier(tenantId: string, requester: SeedActor, approver: SeedActor): Promise<string> {
  const supplierInput = parseSupplierCreate(SUPPLIER)
  if ("errors" in supplierInput) throw new Error(`Seed supplier refused: ${JSON.stringify(supplierInput.errors)}`)
  const accountInput = parseBankAccountRequest(SUPPLIER_ACCOUNT)
  if ("errors" in accountInput) throw new Error(`Seed bank account refused: ${JSON.stringify(accountInput.errors)}`)
  const data = supplierInput.data
  const supplier = await prisma.supplier.findFirst({ where: { tenantId, name: data.name }, select: { id: true } }) ??
    await prisma.$transaction(async (tx) => {
      const row = await tx.supplier.create({ data: { ...data, tenantId, createdById: requester.id }, select: { id: true } })
      await logAuditStrict({
        tenantId, userId: requester.id, userEmail: requester.email,
        action: AuditAction.SUPPLIER_CREATED, entity: "Supplier", entityId: row.id, newValue: { ...data },
      }, tx)
      return row
    })
  let account = await prisma.supplierBankAccount.findFirst({
    where: { tenantId, supplierId: supplier.id, status: { in: ["PENDING", "APPROVED"] } },
    select: { id: true, status: true },
  })
  if (!account) {
    const fields = accountInput.data
    account = await prisma.$transaction(async (tx) => {
      const row = await tx.supplierBankAccount.create({
        data: { ...fields, tenantId, supplierId: supplier.id, status: "PENDING", requestedById: requester.id },
        select: { id: true, status: true },
      })
      await logAuditStrict({
        tenantId, userId: requester.id, userEmail: requester.email,
        action: AuditAction.SUPPLIER_BANK_ACCOUNT_REQUESTED, entity: "SupplierBankAccount", entityId: row.id,
        newValue: {
          supplierId: supplier.id, bankName: fields.bankName, branchCode: fields.branchCode,
          accountNumberLast4: fields.accountNumber.slice(-4), accountHolder: fields.accountHolder, accountType: fields.accountType,
        },
      }, tx)
      return row
    })
  }
  if (account.status === "PENDING") {
    const accountId = account.id
    // The decide route's own decision: AVS recorded as not run (company AVS
    // unsupported) with the approver's manual evidence.
    const outcome = await prisma.$transaction((tx) => decideSupplierBankAccount(tx, {
      tenantId, supplierId: supplier.id, accountId, decision: "APPROVE", note: SUPPLIER_ACCOUNT_NOTE,
      decider: { id: approver.id, email: approver.email },
    }))
    if (outcome.kind !== "decided") throw new Error(`Seed: supplier bank account approval refused (${outcome.kind})`)
  }
  return supplier.id
}

/** The asset with this serial number, registered (and audited) if missing. */
export async function ensureAsset(tenantId: string, actor: SeedActor, asset: AfAsset): Promise<string> {
  const parsed = parseAssetCreate(asset)
  if ("errors" in parsed) throw new Error(`Seed asset refused: ${JSON.stringify(parsed.errors)}`)
  const data = parsed.data
  const existing = await prisma.financedAsset.findFirst({ where: { tenantId, serialNumber: data.serialNumber }, select: { id: true } })
  if (existing) return existing.id
  return prisma.$transaction(async (tx) => {
    const row = await tx.financedAsset.create({ data: { ...data, tenantId, createdById: actor.id }, select: { id: true } })
    await logAuditStrict({
      tenantId, userId: actor.id, userEmail: actor.email,
      action: AuditAction.ASSET_CREATED, entity: "FinancedAsset", entityId: row.id, newValue: { ...data },
    }, tx)
    return row.id
  })
}
