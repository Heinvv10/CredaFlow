/**
 * Real-Postgres proof of the per-client holds (lib/collections/client-holds.ts):
 * Section 129 is blocked, and a staff message refused, when a debt-review notice
 * is recorded on ANY loan of the client; a death refuses a staff message;
 * arrangement and attorney-referred loans stay open to staff messages.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/collections/client-holds.integration.test.ts
 */
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createChargesTenant, type ChargesTenant } from "@/lib/loan/charges.integration-fixture"
import { runWithTenant } from "@/lib/tenant-scope"
import { createSecondProduct, seedHoldLoan } from "@/lib/collections/dunning-holds.integration-fixture"
import { prisma } from "@/lib/prisma"
import { clientIdsUnderDebtReview, isLoanHeld, section129DebtReviewReason, staffMessageRefusal } from "@/lib/collections/client-holds"

const suite = process.env.RUN_DB_IT === "1" ? describe : describe.skip
const db = new PrismaClient()
let tenant: ChargesTenant
let second: string

const seed = (c: Parameters<typeof seedHoldLoan>[3]) => seedHoldLoan(db, tenant, second, c)
const inTenant = <T>(fn: () => Promise<T>) => runWithTenant(tenant.tenantId, fn)

suite.sequential("client-level holds (real Postgres)", () => {
  beforeAll(async () => {
    tenant = await createChargesTenant(db, false)
    second = await createSecondProduct(db, tenant.tenantId)
  })
  afterAll(async () => { await db.$disconnect(); await prisma.$disconnect() })

  it("a notice on the client's OTHER loan blocks Section 129 and refuses a staff message, naming the loan", async () => {
    const s = await seed({ name: "sibling", debtReviewOnSibling: true, held: true })
    const args = { tenantId: tenant.tenantId, clientId: s.clientId }

    const s129 = await inTenant(() => section129DebtReviewReason(prisma, args))
    const message = await inTenant(() => staffMessageRefusal(prisma, args))

    expect(s129).toMatch(/under debt review \(NCA s\.86 notice received 01 Oct 2026, recorded on loan LN-/)
    expect(message).toMatch(/^the client is under debt review/)
    expect(await inTenant(() => clientIdsUnderDebtReview({ tenantId: tenant.tenantId, clientIds: [s.clientId] }))).toEqual(new Set([s.clientId]))
  })

  it("a client with no notice is neither blocked nor refused, and is not in the bulk set", async () => {
    const s = await seed({ name: "clean", held: false })
    const args = { tenantId: tenant.tenantId, clientId: s.clientId }
    expect(await inTenant(() => section129DebtReviewReason(prisma, args))).toBeNull()
    expect(await inTenant(() => staffMessageRefusal(prisma, args))).toBeNull()
    expect(await inTenant(() => clientIdsUnderDebtReview({ tenantId: tenant.tenantId, clientIds: [s.clientId] }))).toEqual(new Set())
  })

  it("a death refuses a staff message but does not block Section 129", async () => {
    const s = await seed({ name: "deceased", deceased: true, held: true })
    const args = { tenantId: tenant.tenantId, clientId: s.clientId }
    expect(await inTenant(() => staffMessageRefusal(prisma, args))).toBe("a death is recorded for this client")
    expect(await inTenant(() => section129DebtReviewReason(prisma, args))).toBeNull()
  })

  it("arrangement and attorney-referred loans stay open to a staff message", async () => {
    for (const c of [
      { name: "arrangement", stage: "PAYMENT_ARRANGEMENT" as const, arrangement: "ACTIVE" as const, held: true },
      { name: "attorney", stage: "ATTORNEY_REFERRED" as const, held: true },
    ]) {
      const s = await seed(c)
      expect(await inTenant(() => staffMessageRefusal(prisma, { tenantId: tenant.tenantId, clientId: s.clientId })), c.name).toBeNull()
      // ...while automated dunning is held on both.
      expect(await inTenant(() => isLoanHeld({ tenantId: tenant.tenantId, loanId: s.loanId })), c.name).toBe(true)
    }
  })

  it("is tenant-scoped: another tenant's client id finds nothing", async () => {
    const s = await seed({ name: "debt review", debtReview: true, held: true })
    const other = await createChargesTenant(db, false)
    expect(await runWithTenant(other.tenantId, () => staffMessageRefusal(prisma, { tenantId: other.tenantId, clientId: s.clientId }))).toBeNull()
  })
})
