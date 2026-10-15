/**
 * Slice 4a actor columns (migration 20261015400000): every column that names
 * who did something (created, recorded, approved, verified, released) is a
 * composite (tenantId, id) foreign key to User, like Payout. Each is proved as
 * in the lease suites: a user that does not exist, or belongs to another
 * lender, is refused, and the same write goes through with that one
 * constraint dropped, inside a rolled-back transaction.
 *
 *   RUN_ASSET_FINANCE_RECOVERY_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/recovery-rules-actors.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, it, vi } from "vitest"
import { dbDate } from "./dates"
import { ladderRecovery, saleData } from "./recovery-path.integration-fixture"
import {
  cleanupRecoveryFixture, createRecoveryFixture, legalDocument, newLoan, newMatter, newRecovery, recoveryFixtureTenantId, today, type RecoveryFixture, type RecoveryLoan,
} from "./recovery.integration-fixture"
import { rules, type Tx } from "./recovery-rules.integration-fixture"

// The deal fixture imports the real route handlers, which import the session helper.
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))

const RUN = process.env.RUN_ASSET_FINANCE_RECOVERY_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
const database = (): PrismaClient => {
  if (!db) throw new Error("RUN_ASSET_FINANCE_RECOVERY_IT=1 is required")
  return db
}
const { refuses } = rules(database)
let fx: RecoveryFixture
interface Rec { loan: RecoveryLoan; id: string }
const R = {} as Record<"open" | "listed" | "surplus", Rec>
let pendingSale = ""
let bankDocument = ""
let otherTenant = ""
let foreignUser = ""
const GHOST = "user_that_does_not_exist"
const fk = (table: string, column: string) => ({ table, constraint: `${table}_tenantId_${column}_fkey` })
const refused = (table: string, column: string, attack: (tx: Tx) => Promise<unknown>) =>
  refuses(fk(table, column), new RegExp(`${table}_tenantId_${column}_fkey|Foreign key constraint`), attack)

const refund = (tx: Tx, over: Record<string, unknown> = {}) => tx.recoveryRefund.create({
  data: {
    tenantId: fx.tenantId, recoveryId: R.surplus.id, amountCents: 40_000_000, accountHolder: "TEST Debtor", bankName: "TEST Bank", branchCode: "000001", accountNumber: "0000000001",
    bankVerifiedById: fx.adminA, bankVerificationDocumentId: bankDocument, createdById: fx.officer, ...over,
  } as never,
})
const cost = (tx: Tx, over: Record<string, unknown>) => tx.recoveryCost.create({
  data: {
    tenantId: fx.tenantId, recoveryId: R.open.id, type: "TOWING", netCents: 100_000, vatCents: 15_000, grossCents: 115_000, supplierInvoiceRef: "INV-1", incurredOn: dbDate(today()),
    treatment: "DEDUCT_FROM_PROCEEDS", recordedById: fx.officer, ...over,
  } as never,
})

suite("slice 4a actor columns are foreign keys to the lender's users", () => {
  beforeAll(async () => {
    fx = await createRecoveryFixture(database(), t)
    const loan = await newLoan(database(), fx, "NON_NCA")
    R.open = { loan, id: await newRecovery(database(), fx, loan, "NON_NCA_VOLUNTARY") }
    R.listed = await ladderRecovery(database(), fx, false, "LISTED")
    R.surplus = await ladderRecovery(database(), fx, true, "SURPLUS_HELD", { settlementCents: 80_000_000 })
    pendingSale = (await database().remarketingSale.create({ data: (await saleData(database(), fx, R.listed.loan, R.listed.id)) as never })).id
    bankDocument = await legalDocument(database(), fx, "OTHER")
    otherTenant = `t_af_actors_${t}`
    await database().tenant.create({ data: { id: otherTenant, slug: `af-actors-${t}`, name: "Actors IT" } })
    foreignUser = (await database().user.create({ data: { tenantId: otherTenant, email: `foreign-${t}@staff.invalid`, password: "x", role: "CREDIT_OFFICER" } })).id
  }, 300_000)

  afterAll(async () => {
    await cleanupRecoveryFixture(database(), recoveryFixtureTenantId(t)).catch(() => undefined)
    await database().user.deleteMany({ where: { tenantId: otherTenant } }).catch(() => undefined)
    await database().tenant.deleteMany({ where: { id: otherTenant } }).catch(() => undefined)
    await database().$disconnect()
  }, 120_000)

  it("names the user who opened a legal matter, and recorded a step; another lender's user will not do", async () => {
    const free = await newLoan(database(), fx, "NCA")
    await refused("LegalMatter", "createdById", (tx) => tx.legalMatter.create({ data: { tenantId: fx.tenantId, loanId: free.loanId, createdById: GHOST } }))
    await refused("LegalMatter", "createdById", (tx) => tx.legalMatter.create({ data: { tenantId: fx.tenantId, loanId: free.loanId, createdById: foreignUser } }))
    const matterId = await newMatter(database(), fx, (await newLoan(database(), fx, "NCA")).loanId)
    await refused("LegalMatterStep", "recordedById", (tx) =>
      tx.legalMatterStep.create({ data: { tenantId: fx.tenantId, matterId, kind: "LETTER_OF_DEMAND", stepDate: dbDate(today()), recordedById: GHOST } }))
  })

  it("names the user who opened a recovery", async () => {
    const loan = await newLoan(database(), fx, "NON_NCA")
    await refused("Recovery", "createdById", (tx) => newRecovery(tx as unknown as PrismaClient, fx, loan, "NON_NCA_VOLUNTARY", { createdById: GHOST }))
    await refused("Recovery", "createdById", (tx) => newRecovery(tx as unknown as PrismaClient, fx, loan, "NON_NCA_VOLUNTARY", { createdById: foreignUser }))
  })

  it("names the users who recorded and approved a cost", async () => {
    await refused("RecoveryCost", "recordedById", (tx) => cost(tx, { recordedById: GHOST }))
    const decide = (by: string) => async (tx: Tx) => {
      const pending = await cost(tx, {})
      await tx.recoveryCost.update({ where: { id: pending.id }, data: { status: "APPROVED", approvedById: by, approvedAt: new Date() } })
    }
    await refused("RecoveryCost", "approvedById", decide(GHOST))
    await refused("RecoveryCost", "approvedById", decide(foreignUser))
  })

  it("names the users who created and approved a sale", async () => {
    await refused("RemarketingSale", "createdById", async (tx) =>
      tx.remarketingSale.create({ data: { ...(await saleData(database(), fx, R.listed.loan, R.listed.id)), createdById: GHOST } as never }))
    await refused("RemarketingSale", "approvedById", (tx) =>
      tx.remarketingSale.update({ where: { id: pendingSale }, data: { approvedById: GHOST, approvedAt: new Date() } }))
  })

  it("names the user who recorded a VAT event", async () => {
    await refused("RecoveryVatEvent", "recordedById", (tx) => tx.recoveryVatEvent.create({
      data: {
        tenantId: fx.tenantId, recoveryId: R.open.id, kind: "REPOSSESSION_DEEMED_SUPPLY", eventDate: dbDate(today()), dealContractType: "INSTALMENT_SALE", debtorVatVendor: false,
        deemedSupplyValueCents: 11_500_000, inputTaxClaimCents: 1_500_000, outputTaxCents: 0, vatRateTenThousandths: 1500, basis: "Synthetic s8(10) basis", recordedById: GHOST,
      },
    }))
  })

  it("names the users who created, verified the bank details of, approved and released a refund", async () => {
    await refused("RecoveryRefund", "createdById", (tx) => refund(tx, { createdById: GHOST }))
    await refused("RecoveryRefund", "bankVerifiedById", (tx) => refund(tx, { bankVerifiedById: GHOST }))
    await refused("RecoveryRefund", "approvedById", async (tx) => {
      const r = await refund(tx)
      await tx.recoveryRefund.update({ where: { id: r.id }, data: { status: "APPROVED", approvedById: GHOST } })
    })
    await refused("RecoveryRefund", "releasedById", async (tx) => {
      const r = await refund(tx)
      await tx.recoveryRefund.update({ where: { id: r.id }, data: { status: "APPROVED", approvedById: fx.adminB } })
      await tx.recoveryRefund.update({ where: { id: r.id }, data: { status: "RELEASED", releasedById: GHOST, releasedAt: new Date() } })
    })
  })
})
