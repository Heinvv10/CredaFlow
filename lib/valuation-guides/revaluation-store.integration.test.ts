/**
 * The book revaluation loader against real Postgres (review, PR #229): it
 * lists every live loan (ACTIVE, DEFAULTED, PENDING_WRITE_OFF, RESTRUCTURED)
 * and no settled, written-off or cancelled one; it values on the current
 * (PUBLISHED) guide only; it keeps the variant of the asset's NEWEST guide
 * valuation; and the matching is PostgreSQL's lower(), as on the asset page.
 *
 *   RUN_ASSET_FINANCE_VALUATION_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/valuation-guides/revaluation-store.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient, type LoanStatus } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { testSetup } from "@/lib/asset-finance/lease-servicing.integration-fixture"
import {
  cleanupRecoveryFixture, createRecoveryFixture, newLoan, recoveryFixtureTenantId, type RecoveryFixture,
} from "@/lib/asset-finance/recovery.integration-fixture"
import { cleanupGuides, day, draftGuide, guideValuationData, publishedGuide, publishGuideRow, supersedeGuideRow, type GuideRowSeed } from "./guide.integration-fixture"
import { loadRevaluation } from "./revaluation-store"

vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))

const RUN = process.env.RUN_ASSET_FINANCE_VALUATION_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
const database = (): PrismaClient => {
  if (!db) throw new Error("RUN_ASSET_FINANCE_VALUATION_IT=1 is required")
  return db
}
const NAME = "TEST Book Guide"
/** The current guide: two EX-R variants and one EX-S row. */
const CURRENT: GuideRowSeed[] = [
  { make: "TEST", model: "EX-R", year: 2025, variant: "", tradeCents: 130_000_000, retailCents: 150_000_000 },
  { make: "TEST", model: "EX-R", year: 2025, variant: "Long reach", tradeCents: 140_000_000, retailCents: 160_000_000 },
  { make: "TEST", model: "EX-S", year: 2025, variant: "", tradeCents: 70_000_000, retailCents: 80_000_000 },
]
/** The guide it superseded: another EX-S row, which must never be read. */
const OLD: GuideRowSeed[] = [{ make: "TEST", model: "EX-S", year: 2025, variant: "Old", tradeCents: 50_000_000, retailCents: 60_000_000 }]
let fx: RecoveryFixture
const loans = {} as Record<"active" | "defaulted" | "pendingWriteOff" | "restructured" | "completed" | "writtenOff" | "cancelled", string>

async function loanOf(status: LoanStatus, model = "EX-R", make = "TEST"): Promise<{ loanId: string; assetId: string }> {
  const asset = await database().financedAsset.create({
    data: {
      tenantId: fx.tenantId, assetClass: "EXCAVATOR", make, model, year: 2025, serialNumber: `RVL${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`,
      cashPriceExclVatCents: 150_000_000, vatCents: 22_500_000,
    },
  })
  const loan = await newLoan(database(), fx, "NON_NCA", "INSTALMENT_SALE", { assetId: asset.id })
  if (status !== "ACTIVE") await testSetup(database(), [`UPDATE "Loan" SET "status" = $1::"LoanStatus" WHERE "id" = $2`, status, loan.loanId])
  return { loanId: loan.loanId, assetId: asset.id }
}

suite("book revaluation loader (real Postgres)", () => {
  let activeAsset = ""
  beforeAll(async () => {
    fx = await createRecoveryFixture(database(), t)
    const old = await publishedGuide(database(), fx.tenantId, fx.adminA, fx.adminB, { name: NAME, effectiveOn: day(-10), rows: OLD })
    const current = await draftGuide(database(), fx.tenantId, fx.adminA, { name: NAME, effectiveOn: day(-1), rows: CURRENT })
    await database().$transaction(async (tx) => {
      await supersedeGuideRow(tx, old.id, current.id)
      await publishGuideRow(tx, current.id, fx.adminB)
    })
    const active = await loanOf("ACTIVE", "ex-r ", " test") // stored as typed; matched with lower(btrim())
    activeAsset = active.assetId
    loans.active = active.loanId
    // Two guide values on the active loan's asset: "Long reach" first, then no variant (the newest).
    for (const row of [1, 0]) {
      await database().assetValuation.create({ data: guideValuationData(fx.tenantId, activeAsset, current.id, current.rowIds[row], CURRENT[row].tradeCents, fx.officer) })
    }
    loans.defaulted = (await loanOf("DEFAULTED", "EX-S")).loanId
    loans.pendingWriteOff = (await loanOf("PENDING_WRITE_OFF")).loanId
    loans.restructured = (await loanOf("RESTRUCTURED")).loanId
    loans.completed = (await loanOf("COMPLETED")).loanId
    loans.writtenOff = (await loanOf("WRITTEN_OFF")).loanId
    loans.cancelled = (await loanOf("CANCELLED")).loanId
  }, 300_000)

  afterAll(async () => {
    if (!db) return
    await cleanupGuides(db, fx?.tenantId ?? recoveryFixtureTenantId(t)).catch(() => undefined)
    await cleanupRecoveryFixture(db, fx?.tenantId ?? recoveryFixtureTenantId(t)).catch(() => undefined)
    await db.$disconnect()
  }, 120_000)

  it("lists every live loan and no settled, written-off or cancelled one", async () => {
    const ids = (await loadRevaluation(fx.tenantId)).map((r) => r.loanId).sort()
    expect(ids).toEqual([loans.active, loans.defaulted, loans.pendingWriteOff, loans.restructured].sort())
  })

  it("keeps the variant of the asset's newest guide value, matched with lower(btrim()) as on the asset page", async () => {
    const row = (await loadRevaluation(fx.tenantId)).find((r) => r.loanId === loans.active)
    expect(row?.match).toMatchObject({ kind: "matched", basis: "recorded_variant", row: { variant: "", tradeCents: 130_000_000 }, changeCents: 0 })
  })

  it("values on the current guide only, never the one it superseded", async () => {
    const rows = await loadRevaluation(fx.tenantId)
    expect(rows.find((r) => r.loanId === loans.defaulted)?.match).toMatchObject({ kind: "matched", basis: "only_row", row: { tradeCents: 70_000_000 } })
    expect(rows.find((r) => r.loanId === loans.pendingWriteOff)?.match).toEqual({ kind: "ambiguous", count: 2 })
  })
})
