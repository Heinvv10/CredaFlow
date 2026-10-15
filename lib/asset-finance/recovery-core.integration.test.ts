/**
 * Slice 4a recovery core, end to end through the real route handlers against a
 * migrated Postgres: the s127 flow on the existing surrender routes (the
 * recovery links the surrender, reuses its valuation and notice, lists; the
 * standalone proceeds route is then refused), the s131 valuation and final
 * notices (rendered, stored, served with a digest check, the cost table
 * printed), the s127 final notice carrying the recovery's cost table, and a
 * NON_NCA recovery (no NCA notice; a plain post-sale statement on demand).
 *
 *   RUN_ASSET_FINANCE_RECOVERY_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/recovery-core.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { writeFile } from "node:fs/promises"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { deleteFile } from "@/lib/storage"
import { DRAFT_WATERMARK } from "./documents/pdf-layout"
import type { SessionUser } from "./payout-booking.integration-fixture"
import { testSetup } from "./lease-servicing.integration-fixture"
import { cleanupRecoveryFixture, createRecoveryFixture, newLoan, recoveryFixtureTenantId, today, type RecoveryFixture } from "./recovery.integration-fixture"
import { advance, ladderRecovery, recordDecidedCost } from "./recovery-path.integration-fixture"
import { readRecoveryDocument } from "./recovery-notices"
import { pdfTexts, recoveryRoutes } from "./recovery-routes.integration-fixture"

const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))

const RUN = process.env.RUN_ASSET_FINANCE_RECOVERY_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: RecoveryFixture
const database = (): PrismaClient => {
  if (!db) throw new Error("RUN_ASSET_FINANCE_RECOVERY_IT=1 is required")
  return db
}
const as = (id: string, role: "LOAN_ADMIN" | "CREDIT_OFFICER") => { session.current = { user: { id, email: `${id}@recovery-it.test`, role, tenantId: fx.tenantId } } }
const officer = () => as(fx.officer, "CREDIT_OFFICER")
const routes = () => recoveryRoutes(fx.host)
const recoveryOf = (id: string) => database().recovery.findUniqueOrThrow({ where: { id } })

suite.sequential("recovery core: routes, notices and documents (real Postgres)", () => {
  beforeAll(async () => {
    process.env.TRUSTED_PROXY = "1"
    fx = await createRecoveryFixture(database(), t)
  }, 120_000)
  afterAll(async () => {
    if (!db) return
    // The notices these tests stored under uploads/.
    const [recoveries, surrenders] = await Promise.all([
      db.recovery.findMany({ where: { tenantId: fx.tenantId }, select: { valuationNoticePath: true, finalNoticePath: true } }),
      db.surrenderRequest.findMany({ where: { tenantId: fx.tenantId }, select: { valuationNoticePath: true, finalNoticePath: true } }),
    ])
    for (const row of [...recoveries, ...surrenders]) {
      for (const path of [row.valuationNoticePath, row.finalNoticePath]) if (path?.startsWith(process.cwd())) await deleteFile(path)
    }
    await cleanupRecoveryFixture(db, recoveryFixtureTenantId(t))
    await db.$disconnect()
  }, 120_000)

  it("s127: the surrender flow, then a recovery that links it, reuses its valuation and notice, and lists", async () => {
    officer()
    const loan = await newLoan(database(), fx, "NCA")
    const { requestSurrender } = await import("./surrender-store")
    const requested = await requestSurrender({ tenantId: fx.tenantId, userId: fx.officer }, loan.loanId, "Synthetic: running", "STAFF")
    if (requested.kind !== "done") throw new Error("surrender not requested")
    const surrenderId = requested.id
    const r = routes()

    // A recovery needs its yard details and its own surrender.
    expect((await r.create(loan.loanId, { route: "NCA_S127_SURRENDER", recoveredOn: today(), location: "TEST Yard", condition: "Synthetic: fair", surrenderRequestId: "nope" })).status).toBe(404)
    const created = await r.create(loan.loanId, { route: "NCA_S127_SURRENDER", recoveredOn: today(), location: "TEST Yard", condition: "Synthetic: fair", surrenderRequestId: surrenderId })
    expect(created.status).toBe(201)
    const id = created.body.id as string
    expect((await recoveryOf(id)).surrenderRequestId).toBe(surrenderId)
    expect((await database().financedAsset.findUniqueOrThrow({ where: { id: loan.assetId } })).lessorStatus).toBe("RECOVERED")

    // The surrender is not valued yet: nothing to reuse.
    expect((await r.valuation(id)).status).toBe(409)
    expect((await r.surrenderValuation(surrenderId, { valuedOn: today(), source: "ASSESSOR", valuerName: "TEST Valuers", amountCents: 100_000_000 })).status).toBe(200)
    const valued = await r.valuation(id)
    expect(valued.status).toBe(200)
    expect((await recoveryOf(id)).valuationId).toBe((await database().surrenderRequest.findUniqueOrThrow({ where: { id: surrenderId } })).valuationId)
    expect((await database().assetValuation.count({ where: { assetId: loan.assetId } }))).toBe(1)

    // The surrender's notice is issued through the existing surrender route first.
    const early = await r.valuationNotice(id)
    expect(early.status).toBe(409)
    expect(String(early.body.error)).toMatch(/surrender's valuation notice/)
    expect((await r.surrenderValuationNotice(surrenderId)).status).toBe(200)
    expect((await r.valuationNotice(id)).status).toBe(200)
    expect((await recoveryOf(id)).valuationNoticePath).toBeNull()
    const document = await r.document(id, "valuation")
    expect(document.status).toBe(200)
    expect((await pdfTexts(new Uint8Array(await document.arrayBuffer()))).join(" ")).toContain("VOLUNTARY SURRENDER VALUATION NOTICE")
    expect((await r.listForSale(id)).status).toBe(200)
    expect((await recoveryOf(id)).status).toBe("LISTED")

    // The sale now goes through the recovery: the standalone proceeds route refuses.
    as(fx.officer, "CREDIT_OFFICER")
    const proceeds = await r.surrenderProceeds(surrenderId, { saleProceedsCents: 100_000 })
    expect(proceeds.status).toBe(409)
    expect(proceeds.body.error).toBe("Sale proceeds for this surrender go through its recovery")
  }, 120_000)

  it("s127: the final notice carries the recovery's cost table and advances the recovery with the 10-business-day freeze", async () => {
    officer()
    const { id, surrenderId, loan } = await ladderRecovery(database(), fx, true, "PROCEEDS_APPLIED", {
      costs: [{ type: "TOWING", treatment: "DEDUCT_FROM_PROCEEDS", grossCents: 500_000 }],
    }, true).then((l) => ({ ...l, loan: l.loan }))
    const row = await recoveryOf(id)
    // The sale module moves the surrender to PROCEEDS_CREDITED with the same figures; set that up directly.
    await testSetup(database(), [
      `UPDATE "SurrenderRequest" SET "status" = 'PROCEEDS_CREDITED', "saleProceedsCents" = $2, "proceedsPaymentId" = $3, "shortfallCents" = $4, "refundCents" = $5 WHERE "id" = $1`,
      surrenderId, (await database().payment.findUniqueOrThrow({ where: { id: row.proceedsPaymentId ?? "" } })).amount, row.proceedsPaymentId, row.shortfallCents, row.surplusCents,
    ])
    const r = routes()
    const issued = await r.finalNotice(id)
    expect(issued.status).toBe(200)
    const after = await recoveryOf(id)
    expect(after.status).toBe("FINAL_NOTICE_ISSUED")
    expect(after.finalNoticeIssuedOn?.toISOString().slice(0, 10)).toBe(today())
    expect(after.chargesFrozenUntil && after.chargesFrozenUntil > after.finalNoticeIssuedOn!).toBe(true)
    expect(after.finalNoticePath).toBeNull()
    const document = await r.document(id, "final")
    expect(document.status).toBe(200)
    const printed = await pdfTexts(new Uint8Array(await document.arrayBuffer()))
    expect(printed).toEqual(expect.arrayContaining(["RECOVERY COSTS", "Towing and transport", "R 5,000.00", "Cost lines: DRAFT — require lender legal approval", DRAFT_WATERMARK]))
    // The linked recovery's sale and account lines follow the existing ones, marked draft.
    expect(printed).toEqual(expect.arrayContaining(["Settlement due at sale", "Gross sale price", "Net proceeds", "Account shortfall", "Sale and account lines: DRAFT — require lender legal approval"]))
    expect(printed.indexOf("Settlement due at sale")).toBeGreaterThan(printed.lastIndexOf("Refund due"))
    expect((await r.finalNotice(id)).status).toBe(409)
    expect(loan.regime).toBe("NCA")
  }, 120_000)

  it("s131: the valuation and final notices are rendered, stored with a digest, served, and refuse tampered bytes", async () => {
    officer()
    const { id } = await ladderRecovery(database(), fx, true, "VALUED")
    const r = routes()
    expect((await r.valuationNotice(id)).status).toBe(200)
    const stored = await recoveryOf(id)
    expect(stored.status).toBe("VALUATION_NOTICE_ISSUED")
    expect(stored.valuationNoticeSha256).toMatch(/^[0-9a-f]{64}$/)
    const response = await r.document(id, "valuation")
    expect(response.status).toBe(200)
    const printed = await pdfTexts(new Uint8Array(await response.arrayBuffer()))
    expect(printed.join(" ")).toContain("REPOSSESSED GOODS VALUATION NOTICE")
    expect(printed).toContain(DRAFT_WATERMARK)
    expect(await readRecoveryDocument(fx.tenantId, id, "valuation")).toMatchObject({ sha256: stored.valuationNoticeSha256 })
    await writeFile(stored.valuationNoticePath ?? "", Buffer.from("tampered"))
    await expect(readRecoveryDocument(fx.tenantId, id, "valuation")).rejects.toThrow(/integrity/)

    const final = await ladderRecovery(database(), fx, true, "SOLD", { costs: [{ type: "TOWING", treatment: "DEDUCT_FROM_PROCEEDS", grossCents: 500_000 }] })
    // A rejected cost stays on the ledger but is on no notice and in no figure.
    await recordDecidedCost(database(), fx, final.id, { type: "STORAGE", treatment: "DEDUCT_FROM_PROCEEDS", grossCents: 777_700 }, "REJECTED")
    await advance(database(), fx, final.loan, final.id, "PROCEEDS_APPLIED")
    expect((await r.finalNotice(final.id)).status).toBe(200)
    const done = await recoveryOf(final.id)
    expect(done.status).toBe("FINAL_NOTICE_ISSUED")
    expect(done.finalNoticePath).not.toBeNull()
    const text = await pdfTexts(new Uint8Array(await (await r.document(final.id, "final")).arrayBuffer()))
    expect(text.join(" ")).toContain("REPOSSESSED GOODS FINAL ACCOUNT NOTICE")
    expect(text).toEqual(expect.arrayContaining(["RECOVERY COSTS", "R 5,000.00"]))
    expect(text).not.toContain("Storage")
    expect(text).not.toContain("R 7,777.00")
    expect(done.deductedCostsCents).toBe(500_000)
    expect((await r.document(final.id, "statement")).status).toBe(404)
  }, 120_000)

  it("NON_NCA: no valuation or final notice; listed once valued; the post-sale statement on demand, no status change", async () => {
    officer()
    const { id } = await ladderRecovery(database(), fx, false, "VALUED")
    const r = routes()
    const notice = await r.valuationNotice(id)
    expect(notice.status).toBe(409)
    expect(String(notice.body.error)).toMatch(/NON_NCA recovery has no NCA notice/)
    expect((await r.listForSale(id)).status).toBe(200)
    expect((await r.document(id, "statement")).status).toBe(404)

    const sold = await ladderRecovery(database(), fx, false, "PROCEEDS_APPLIED")
    expect((await r.finalNotice(sold.id)).status).toBe(409)
    const statement = await r.document(sold.id, "statement")
    expect(statement.status).toBe(200)
    const printed = await pdfTexts(new Uint8Array(await statement.arrayBuffer()))
    expect(printed.join(" ")).toContain("POST-SALE ACCOUNT STATEMENT")
    expect(printed).not.toContain(DRAFT_WATERMARK)
    expect((await r.document(sold.id, "final")).status).toBe(404)
    expect((await recoveryOf(sold.id)).status).toBe("PROCEEDS_APPLIED")
  }, 120_000)
})
