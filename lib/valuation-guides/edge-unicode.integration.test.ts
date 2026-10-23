/**
 * Case folding (review repro, PR #229): the CSV reader folds case with JS
 * toLowerCase, the database (ValuationGuideRow_key, the lookup) with
 * PostgreSQL lower(), and they disagree on a few letters (İ, final sigma). The
 * store re-checks the rows with lower() before it writes, so a clash the
 * reader missed is a refusal with line reasons, never a 500. The reverse (JS
 * folds two keys together that lower() keeps apart) is refused by the reader:
 * a documented false refusal (SLICE5.md Part C, known limitations).
 *
 *   RUN_ASSET_FINANCE_VALUATION_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/valuation-guides/edge-unicode.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { cleanupDealFixture, createDealFixture, type DealFixture } from "@/lib/asset-finance/deal.integration-fixture"
import { cleanupGuides } from "./guide.integration-fixture"
import { createDraftGuide } from "./guide-store"
import { csvGuideProvider } from "./providers/csv-guide"

vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))

const RUN = process.env.RUN_ASSET_FINANCE_VALUATION_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
const csv = (...lines: string[]) => new TextEncoder().encode(["make,model,year,variant,trade_cents,retail_cents", ...lines].join("\n") + "\n")
let fx: DealFixture

suite("guide CSV case folding agrees with the database", () => {
  beforeAll(async () => { fx = await createDealFixture(db as PrismaClient, t, { templates: false }) })
  afterAll(async () => {
    await cleanupGuides(db as PrismaClient, fx.tenantId)
    await cleanupDealFixture(db as PrismaClient, fx)
    await db?.$disconnect()
  })

  it("a file with İsuzu and Isuzu rows (the same key to lower()) is refused with a 422-style result, not a thrown 23505", async () => {
    const actor = { tenantId: fx.tenantId, userId: fx.adminA, userEmail: "a@example.test" }
    const result = await createDraftGuide(actor, {
      name: "TEST Unicode", effectiveOn: "2026-01-01", provider: csvGuideProvider,
      bytes: csv("İsuzu,FTR,2025,,1,2", "Isuzu,FTR,2025,,1,2"),
    })
    expect(result).toMatchObject({ kind: "refused", total: 1, problems: [{ line: 3, reason: "duplicates line 2 when letter case is ignored (rows that differ only by letter case)" }] })
    const [refusal] = await (db as PrismaClient).auditLog.findMany({ where: { tenantId: fx.tenantId, action: "VALUATION_GUIDE_UPLOAD_REFUSED" } })
    expect(refusal.newValue).toMatchObject({ reason: "malformed_guide", problems: 1, lines: [3] })
  })

  it("a file with Greek ΑΣ and ας rows (distinct to lower(), the same to JS) is refused by the reader: a known false refusal", async () => {
    const actor = { tenantId: fx.tenantId, userId: fx.adminA, userEmail: "a@example.test" }
    const result = await createDraftGuide(actor, {
      name: "TEST Sigma", effectiveOn: "2026-01-01", provider: csvGuideProvider,
      bytes: csv("ΑΣ,FTR,2025,,1,2", "ας,FTR,2025,,1,2"),
    })
    expect(result).toMatchObject({ kind: "refused", problems: [{ line: 3, reason: "duplicates line 2 (same make, model, year and variant)" }] })
  })
})
