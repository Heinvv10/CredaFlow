/**
 * Real-Postgres proof of the asset register's and supplier bank accounts'
 * database rules (DESIGN D8, goal §4.6), migration
 * 20261013110500_asset_finance_assets_suppliers:
 *  - book-wide duplicate serial / VIN while the asset is unreleased;
 *  - one APPROVED account per supplier, four-eyes, born PENDING, frozen once decided.
 * The last block drives the real routes (only the session is stubbed) to prove
 * the 409 mapping and the supersede-on-approve against the real indexes.
 *
 *   RUN_ASSET_FINANCE_ASSETS_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/assets-suppliers.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { Prisma, PrismaClient } from "@prisma/client"
import { NextRequest } from "next/server"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

const { session } = vi.hoisted(() => ({
  session: { current: null as null | { user: { id: string; email: string; role: string; tenantId: string } } },
}))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))

import { POST as createAsset } from "@/app/api/asset-finance/assets/route"
import { POST as decideAccount } from "@/app/api/asset-finance/suppliers/bank-accounts/[accountId]/decide/route"

const RUN = process.env.RUN_ASSET_FINANCE_ASSETS_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null

const t = randomUUID().replaceAll("-", "").slice(0, 16)
const tenantId = `t_af_assets_${t}`
const host = `af-assets-${t}.assets-it.test`
const ids = { officer: "", admin: "", supplier: "" }

function database(): PrismaClient {
  if (!db) throw new Error("RUN_ASSET_FINANCE_ASSETS_IT=1 is required")
  return db
}

const asset = (serialNumber: string, vin: string | null = null) => database().financedAsset.create({
  data: {
    tenantId, assetClass: "EXCAVATOR", make: "TEST Make", model: "TX-200", year: 2024,
    serialNumber, vin, cashPriceExclVatCents: 150_000_000, vatCents: 22_500_000,
  },
})
const account = (accountNumber: string) => database().supplierBankAccount.create({
  data: {
    tenantId, supplierId: ids.supplier, bankName: "TEST Bank", branchCode: "250655",
    accountNumber, accountHolder: "TEST Plant Sales", requestedById: ids.officer,
  },
})
const approveRaw = (id: string, decidedById: string) => database().$executeRaw(Prisma.sql`
  UPDATE "SupplierBankAccount"
  SET "status" = 'APPROVED', "decidedById" = ${decidedById}, "decidedAt" = now(), "avsResult" = '{"status":"NOT_RUN"}'::jsonb
  WHERE "id" = ${id}
`)
const request = (path: string, body: unknown) => new NextRequest(`http://${host}${path}`, {
  method: "POST", headers: { host, "content-type": "application/json" }, body: JSON.stringify(body),
})
const signIn = (userId: string, role: "LOAN_ADMIN" | "CREDIT_OFFICER") => {
  session.current = { user: { id: userId, email: `${userId}@assets-it.test`, role, tenantId } }
}

suite.sequential("asset register and supplier bank accounts (real Postgres)", () => {
  beforeAll(async () => {
    const prisma = database()
    await prisma.tenant.create({ data: { id: tenantId, slug: `af-assets-${t}`, name: "Assets IT", domain: host } })
    await prisma.tenantConfig.create({ data: { tenantId, featureAssetFinance: true } })
    const user = (label: string, role: "LOAN_ADMIN" | "CREDIT_OFFICER") =>
      prisma.user.create({ data: { tenantId, email: `${label}-${t}@staff.invalid`, password: "x", role } })
    ids.officer = (await user("officer", "CREDIT_OFFICER")).id
    ids.admin = (await user("admin", "LOAN_ADMIN")).id
    ids.supplier = (await prisma.supplier.create({ data: { tenantId, name: "TEST Plant Sales (Pty) Ltd" } })).id
  })

  afterAll(async () => {
    if (!db) return
    await db.auditLog.deleteMany({ where: { tenantId } })
    await db.supplierBankAccount.deleteMany({ where: { tenantId } })
    await db.supplier.deleteMany({ where: { tenantId } })
    await db.assetValuation.deleteMany({ where: { tenantId } })
    await db.financedAsset.deleteMany({ where: { tenantId } })
    await db.tenantConfig.deleteMany({ where: { tenantId } })
    await db.user.deleteMany({ where: { tenantId } })
    await db.tenant.deleteMany({ where: { id: tenantId } })
    await db.$disconnect()
  })

  it("refuses a second unreleased asset with the same serial in any case or padding", async () => {
    await asset("TEST-SER-0001")
    for (const variant of ["TEST-SER-0001", "test-ser-0001", "  Test-Ser-0001  "]) {
      await expect(asset(variant)).rejects.toMatchObject({ code: "P2002" })
    }
    await expect(asset("TEST-SER-0002")).resolves.toMatchObject({ serialNumber: "TEST-SER-0002" })
  })

  it("refuses a second unreleased asset with the same VIN; NULL VINs never collide", async () => {
    await asset("TEST-SER-0100", "TESTVIN0000000001")
    await expect(asset("TEST-SER-0101", " testvin0000000001")).rejects.toMatchObject({ code: "P2002" })
    await asset("TEST-SER-0102")
    await expect(asset("TEST-SER-0103")).resolves.toMatchObject({ vin: null })
  })

  it("allows the serial and VIN again once the first asset is released", async () => {
    const first = await asset("TEST-SER-0200", "TESTVIN0000000200")
    await database().financedAsset.update({ where: { id: first.id }, data: { releasedAt: new Date() } })
    await expect(asset("test-ser-0200", "testvin0000000200")).resolves.toMatchObject({ serialNumber: "test-ser-0200" })
  })

  it("is per tenant: another tenant may finance the same serial", async () => {
    const other = `${tenantId}_b`
    await database().tenant.create({ data: { id: other, slug: `af-assets-b-${t}`, name: "Assets IT B" } })
    try {
      await asset("TEST-SER-0300")
      const row = await database().financedAsset.create({
        data: { tenantId: other, assetClass: "TLB", make: "M", model: "M", year: 2020, serialNumber: "TEST-SER-0300", cashPriceExclVatCents: 1, vatCents: 0 },
      })
      expect(row.tenantId).toBe(other)
    } finally {
      await database().financedAsset.deleteMany({ where: { tenantId: other } })
      await database().tenant.delete({ where: { id: other } })
    }
  })

  it("enforces the asset and valuation CHECKs", async () => {
    await expect(asset("   ")).rejects.toThrow(/FinancedAsset_identifiers_present/)
    await expect(database().$executeRaw(Prisma.sql`
      UPDATE "FinancedAsset" SET "year" = 1900 WHERE "tenantId" = ${tenantId}
    `)).rejects.toThrow(/FinancedAsset_year_range/)
    await expect(database().$executeRaw(Prisma.sql`
      UPDATE "FinancedAsset" SET "cashPriceExclVatCents" = -1, "vatCents" = 0 WHERE "tenantId" = ${tenantId}
    `)).rejects.toThrow(/FinancedAsset_amounts_non_negative/)
    await expect(database().$executeRaw(Prisma.sql`
      UPDATE "FinancedAsset" SET "hours" = -1 WHERE "tenantId" = ${tenantId}
    `)).rejects.toThrow(/FinancedAsset_usage_non_negative/)
    const target = await asset("TEST-SER-0400")
    await expect(database().assetValuation.create({
      data: { tenantId, assetId: target.id, valuedOn: new Date("2026-10-01"), source: "DEALER", valuerName: "TEST", amountCents: 0 },
    })).rejects.toThrow(/AssetValuation_amount_positive/)
  })

  it("refuses an account inserted already APPROVED", async () => {
    await expect(database().$executeRaw(Prisma.sql`
      INSERT INTO "SupplierBankAccount" ("id", "tenantId", "supplierId", "bankName", "branchCode", "accountNumber", "accountHolder",
        "status", "requestedById", "decidedById", "decidedAt", "avsResult")
      VALUES (${`acc_${t}_ins`}, ${tenantId}, ${ids.supplier}, 'TEST Bank', '250655', '62000000099', 'TEST',
        'APPROVED', ${ids.officer}, ${ids.admin}, now(), '{}'::jsonb)
    `)).rejects.toThrow(/created PENDING/)
  })

  it("refuses the requester approving their own account (any case or padding)", async () => {
    const row = await account("62000000001")
    await expect(approveRaw(row.id, ids.officer)).rejects.toThrow(/SupplierBankAccount_four_eyes/)
    await expect(approveRaw(row.id, `  ${ids.officer.toUpperCase()} `)).rejects.toThrow(/SupplierBankAccount_four_eyes/)
    expect((await database().supplierBankAccount.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("PENDING")
  })

  it("refuses a second APPROVED account for the supplier", async () => {
    const first = await account("62000000002")
    const second = await account("62000000003")
    expect(await approveRaw(first.id, ids.admin)).toBe(1)
    // 23505 on (tenantId, supplierId): only SupplierBankAccount_one_approved_per_supplier has that key.
    await expect(approveRaw(second.id, ids.admin)).rejects.toThrow(/23505.*Key \(\\?"tenantId\\?", \\?"supplierId\\?"\)/)
    expect((await database().supplierBankAccount.findUniqueOrThrow({ where: { id: second.id } })).status).toBe("PENDING")
  })

  it("freezes an APPROVED account's bank fields and decision; only SUPERSEDED may follow", async () => {
    const approved = await database().supplierBankAccount.findFirstOrThrow({ where: { tenantId, status: "APPROVED" } })
    const update = (set: Prisma.Sql) => database().$executeRaw(Prisma.sql`UPDATE "SupplierBankAccount" SET ${set} WHERE "id" = ${approved.id}`)
    await expect(update(Prisma.sql`"accountNumber" = '62999999999'`)).rejects.toThrow(/details are fixed/)
    await expect(update(Prisma.sql`"branchCode" = '000000'`)).rejects.toThrow(/details are fixed/)
    await expect(update(Prisma.sql`"requestedById" = ${ids.admin}`)).rejects.toThrow(/details are fixed/)
    await expect(update(Prisma.sql`"status" = 'REJECTED'`)).rejects.toThrow(/frozen/)
    await expect(update(Prisma.sql`"status" = 'PENDING', "decidedById" = NULL, "decidedAt" = NULL, "avsResult" = NULL`)).rejects.toThrow(/frozen/)
    await expect(update(Prisma.sql`"avsPassed" = true`)).rejects.toThrow(/frozen/)
    expect(await update(Prisma.sql`"status" = 'SUPERSEDED'`)).toBe(1)
    await expect(update(Prisma.sql`"status" = 'APPROVED'`)).rejects.toThrow(/frozen/)
  })

  it("never supersedes a PENDING account, and a PENDING account's details are fixed too", async () => {
    const row = await account("62000000004")
    await expect(database().$executeRaw(Prisma.sql`
      UPDATE "SupplierBankAccount" SET "status" = 'SUPERSEDED', "decidedById" = ${ids.admin}, "decidedAt" = now(), "avsResult" = '{}'::jsonb
      WHERE "id" = ${row.id}
    `)).rejects.toThrow(/never superseded/)
    await expect(database().$executeRaw(Prisma.sql`
      UPDATE "SupplierBankAccount" SET "accountNumber" = '62000000005' WHERE "id" = ${row.id}
    `)).rejects.toThrow(/details are fixed/)
  })

  it("route: a duplicate serial answers 409 with a clear message and audits the attempt", async () => {
    signIn(ids.officer, "CREDIT_OFFICER")
    const body = { assetClass: "TLB", make: "TEST", model: "T1", year: 2023, serialNumber: " test-ser-0001 ", cashPriceExclVatCents: 100, vatCents: 15 }
    const res = await createAsset(request("/api/asset-finance/assets", body))
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/serial number is already on the book/)
    expect(await database().auditLog.count({ where: { tenantId, action: "ASSET_DUPLICATE_REFUSED" } })).toBe(1)
  })

  it("route: approving supersedes the current account; the requester cannot approve their own", async () => {
    const supplier = await database().supplier.create({ data: { tenantId, name: "TEST Second Supplier" } })
    const make = (accountNumber: string) => database().supplierBankAccount.create({
      data: { tenantId, supplierId: supplier.id, bankName: "TEST Bank", branchCode: "250655", accountNumber, accountHolder: "TEST", requestedById: ids.admin },
    })
    const first = await make("63000000001")
    const second = await make("63000000002")
    const decide = (id: string, body: unknown) =>
      decideAccount(request(`/api/asset-finance/suppliers/bank-accounts/${id}/decide`, body), { params: Promise.resolve({ accountId: id }) })
    const approve = { decision: "APPROVE", note: "Bank-stamped confirmation letter on file" }

    signIn(ids.admin, "LOAN_ADMIN")
    expect((await decide(first.id, approve)).status).toBe(403)

    const otherAdmin = await database().user.create({ data: { tenantId, email: `admin2-${t}@staff.invalid`, password: "x", role: "LOAN_ADMIN" } })
    signIn(otherAdmin.id, "LOAN_ADMIN")
    expect((await decide(first.id, approve)).status).toBe(200)
    expect((await decide(second.id, approve)).status).toBe(200)
    const rows = await database().supplierBankAccount.findMany({ where: { supplierId: supplier.id }, orderBy: { accountNumber: "asc" } })
    expect(rows.map((r) => [r.accountNumber, r.status, r.decidedById, r.avsPassed])).toEqual([
      ["63000000001", "SUPERSEDED", otherAdmin.id, null],
      ["63000000002", "APPROVED", otherAdmin.id, null],
    ])
    expect(rows[1].avsResult).toMatchObject({ status: "NOT_RUN", manualVerification: { note: approve.note, verifiedById: otherAdmin.id } })
  })
})
