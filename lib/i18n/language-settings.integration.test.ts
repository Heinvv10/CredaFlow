/**
 * Real-Postgres proof of the borrower-language write path: the advisory lock
 * SQL runs, the review record lands in the TenantConfig.languageReviews JSONB
 * column next to enabledLanguages, the audit row commits with it, and an
 * unacknowledged language is refused with nothing written.
 *
 * Run only against a fully migrated throwaway database:
 *   RUN_TENANT_LANGUAGES_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/i18n/language-settings.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { prisma } from "@/lib/prisma"
import { applyTenantLanguages } from "./language-settings"
import { servableLocales } from "./language-reviews"
import { catalogueHash } from "./catalogue-hash"
import { purgeAuditRowsForTest } from "@/lib/audit/audit-rows.test-helpers"

const RUN = process.env.RUN_TENANT_LANGUAGES_IT === "1"
const suite = RUN ? describe : describe.skip

const token = randomUUID().replaceAll("-", "")
const tenantId = `tenant_languages_${token}`
const actor = { id: null, email: "root@test.invalid" }

suite("applyTenantLanguages against Postgres", () => {
  beforeAll(async () => {
    await prisma.tenant.create({ data: { id: tenantId, slug: `languages-${token}`, name: "Languages Test" } })
  })

  afterAll(async () => {
    await purgeAuditRowsForTest(prisma, { tenantId })
    await prisma.tenantConfig.deleteMany({ where: { tenantId } })
    await prisma.tenant.delete({ where: { id: tenantId } })
    await prisma.$disconnect()
  })

  const run = (input: { enabledLanguages: unknown; acknowledgements: unknown }) =>
    prisma.$transaction((tx) => applyTenantLanguages(tx, { tenantId, actor, input, now: new Date("2026-10-14T09:00:00Z") }))

  it("refuses an unacknowledged language and writes nothing", async () => {
    const r = await run({ enabledLanguages: ["en", "zu"], acknowledgements: undefined })
    expect(r).toEqual({ ok: false, error: "Acknowledge a native-speaker review before enabling: zu" })
    expect(await prisma.tenantConfig.findUnique({ where: { tenantId } })).toBeNull()
    expect(await prisma.auditLog.count({ where: { tenantId } })).toBe(0)
  })

  it("stores the review with the list, audits it, and the language becomes servable", async () => {
    const r = await run({ enabledLanguages: ["en", "zu"], acknowledgements: { zu: { reviewer: "T. Reviewer", confirmed: true } } })
    expect(r).toMatchObject({ ok: true, changed: true, enabled: ["en", "zu"] })

    const row = await prisma.tenantConfig.findUniqueOrThrow({ where: { tenantId }, select: { enabledLanguages: true, languageReviews: true } })
    expect(row.enabledLanguages).toEqual(["en", "zu"])
    expect(row.languageReviews).toEqual({
      zu: {
        reviewer: "T. Reviewer", acknowledgedAt: "2026-10-14T09:00:00.000Z", acknowledgedById: null,
        acknowledgedByEmail: "root@test.invalid", catalogueHash: catalogueHash("zu"),
      },
    })
    expect(servableLocales(row.enabledLanguages, row.languageReviews)).toEqual(["en", "zu"])

    const audits = await prisma.auditLog.findMany({ where: { tenantId, action: "TENANT_LANGUAGES_UPDATED" } })
    expect(audits).toHaveLength(1)

    // Switching it off and on again needs no second acknowledgement: the record stays.
    expect(await run({ enabledLanguages: ["en"], acknowledgements: {} })).toMatchObject({ ok: true, changed: true })
    expect(await run({ enabledLanguages: ["en", "zu"], acknowledgements: {} })).toMatchObject({ ok: true, changed: true })
    expect(await prisma.auditLog.count({ where: { tenantId, action: "TENANT_LANGUAGES_UPDATED" } })).toBe(3)
  })
})
