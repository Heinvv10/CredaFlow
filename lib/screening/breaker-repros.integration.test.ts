/**
 * Round-1 review breaker repros (PR #81), against real Postgres. Each test was
 * written to fail on the round-0 code and pass after its fix:
 *
 *   REPRO 1 (H1)  a run is bound to the identity it screened
 *   REPRO 2 (H2)  a REJECTED or confirmed-sanctions block survives a later CLEAR run
 *   REPRO 3 (M1)  a decision never carries onto a CONFIRMED_MATCH
 *   REPRO 4 (M2)  a match with no usable list-entry ids never carries
 *   REPRO 5 (H3)  an entity application is not approvable without entity screening
 *
 *   RUN_SCREENING_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/screening/breaker-repros.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { PrismaClient } from "@prisma/client"
import { runScreening } from "./run"
import { reviewScreeningCheck } from "./review"
import { readSubjectScreening } from "./gate"
import { registerScreeningProvider } from "./registry"
import type { ScreeningProviderResult, ScreeningTypeResult } from "./types"

const RUN = process.env.RUN_SCREENING_IT === "1"
const suite = RUN ? describe.sequential : describe.skip
const db = new PrismaClient()
const token = randomUUID().replaceAll("-", "").slice(0, 16)
const tenantId = `tenant_brk_${token}`
const maker = { id: `maker_${token}`, email: `maker-${token}@test.invalid` }
const checker = { id: `checker_${token}`, email: `checker-${token}@test.invalid`, role: "ADMIN" as const, totpVerified: true }

/** A provider whose next answer the test sets. Real adapters are never this. */
let scripted: ScreeningTypeResult[] = []
registerScreeningProvider({
  id: `scripted_${token}`,
  label: "Scripted (test)",
  simulated: false,
  supportedTypes: ["PEP", "SANCTIONS", "ADVERSE_MEDIA"],
  async screen(): Promise<ScreeningProviderResult> {
    return { results: scripted, providerReference: "scripted" }
  },
})
const clear = (): ScreeningTypeResult[] => (["PEP", "SANCTIONS", "ADVERSE_MEDIA"] as const).map((type) => ({ type, result: "CLEAR", matches: [] }))
const withMatch = (m: ScreeningTypeResult): ScreeningTypeResult[] => clear().map((r) => (r.type === m.type ? m : r))
const entry = (listEntryId: string) => ({ listEntryId, listName: "Test list", matchedName: "TEST PERSON", score: 90, detail: null })

async function client(lastName: string): Promise<string> {
  const id = `brk_${lastName.toLowerCase().replace(/[^a-z]/g, "")}_${randomUUID().slice(0, 8)}`
  await db.client.create({ data: {
    id, tenantId, reference: `REF-${id}`, idNumber: `ID-${id}`, firstName: "Synthetic", lastName,
    email: `${id}@test.invalid`, phone: "+27820000000",
  } })
  return id
}
const run = (clientId: string) => runScreening({ tenantId, subject: { clientId }, trigger: "MANUAL", actor: maker })
const decide = (checkId: string, decision: "FALSE_POSITIVE" | "ACCEPTED" | "REJECTED") =>
  reviewScreeningCheck({ tenantId, checkId, decision, reason: "Synthetic reviewer reason for the breaker repro.", actor: checker, totpWaived: false })
const latestMatch = async (clientId: string) =>
  (await db.screeningCheck.findFirst({ where: { tenantId, clientId, result: { in: ["POSSIBLE_MATCH", "CONFIRMED_MATCH"] } }, orderBy: { createdAt: "desc" } }))!
const stateOf = async (clientId: string) => (await readSubjectScreening(tenantId, { clientId })).state.state

/** Approve with every OTHER LoanApplication trigger and CHECK out of the way; always rolled back. */
async function approvalRefusal(appId: string): Promise<string | null> {
  const others = await db.$queryRawUnsafe<Array<{ tgname: string }>>(
    `SELECT tgname FROM pg_trigger WHERE tgrelid = '"LoanApplication"'::regclass AND NOT tgisinternal AND tgname <> 'LoanApplication_a1_guard_screening'`)
  const checks = await db.$queryRawUnsafe<Array<{ conname: string }>>(
    `SELECT conname FROM pg_constraint WHERE conrelid = '"LoanApplication"'::regclass AND contype = 'c'`)
  const rollback = new Error("rollback")
  try {
    await db.$transaction(async (tx) => {
      for (const t of others) await tx.$executeRawUnsafe(`ALTER TABLE "LoanApplication" DISABLE TRIGGER "${t.tgname}"`)
      for (const c of checks) await tx.$executeRawUnsafe(`ALTER TABLE "LoanApplication" DROP CONSTRAINT "${c.conname}"`)
      await tx.$executeRawUnsafe(`UPDATE "LoanApplication" SET status = 'APPROVED', "repaymentMethod" = 'EFT', "approvedAt" = now() WHERE id = $1`, appId)
      throw rollback
    })
  } catch (error) {
    if (error === rollback) return null
    return String(error)
  }
  return null
}

async function application(borrower: { clientId: string } | { entityId: string }): Promise<string> {
  const id = `brk_app_${randomUUID().slice(0, 8)}`
  await db.$executeRawUnsafe(
    `INSERT INTO "LoanApplication" ("id", "tenantId", "reference", "clientId", "entityId", "productId", "appliedAmount", "appliedTermDays", "status", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $6, 500000, 30, 'UNDER_REVIEW', now())`,
    id, tenantId, `APP-${id}`, "clientId" in borrower ? borrower.clientId : null, "entityId" in borrower ? borrower.entityId : null, `product_brk_${token}`)
  return id
}

suite("round-1 breaker repros", () => {
  beforeAll(async () => {
    await db.tenant.create({ data: { id: tenantId, slug: `brk-${token}`, name: "Breaker repros" } })
    await db.tenantConfig.create({ data: { tenantId, screeningProvider: `scripted_${token}`, screeningReviewMinRole: "ADMIN", requireStaffTotp: true } })
    await db.user.createMany({ data: [
      { id: maker.id, tenantId, email: maker.email, password: "synthetic", role: "CREDIT_OFFICER" },
      { id: checker.id, tenantId, email: checker.email, password: "synthetic", role: "ADMIN" },
    ] })
    await db.$executeRawUnsafe(
      `INSERT INTO "LoanProduct" ("id", "tenantId", "code", "name", "productType", "minAmount", "maxAmount", "minTermDays", "maxTermDays", "interestRatePm", "interestModel")
       VALUES ($1, $2, $3, 'Breaker product', 'PERSONAL', 100000, 1000000, 30, 90, 0.03, 'DAILY_ACCRUAL')`,
      `product_brk_${token}`, tenantId, `BRK-${token}`)
  })
  afterAll(async () => db.$disconnect())

  it("REPRO 1: renaming a clear-screened client to a sanctioned name is not still CLEAR, and approval is refused", async () => {
    const id = await client("Example")
    scripted = clear()
    await run(id)
    expect(await stateOf(id)).toBe("CLEAR")
    await db.client.update({ where: { id }, data: { lastName: "Different Person", idNumber: `ID-other-${id}` } })
    expect(await stateOf(id)).toBe("NOT_SCREENED")
    const appId = await application({ clientId: id })
    expect(await approvalRefusal(appId)).toContain("has not been screened")
  })

  it("REPRO 2a: a confirmed sanctions match stays blocking after a later CLEAR run", async () => {
    const id = await client("Example")
    scripted = withMatch({ type: "SANCTIONS", result: "CONFIRMED_MATCH", matches: [entry("SAN-1")] })
    await run(id)
    scripted = clear()
    await run(id)
    expect(await stateOf(id)).toBe("BLOCKED")
    expect(await approvalRefusal(await application({ clientId: id }))).toContain("screening blocks approval")
  })

  it("REPRO 2b: a REJECTED match stays blocking after a later CLEAR run", async () => {
    const id = await client("Example")
    scripted = withMatch({ type: "PEP", result: "CONFIRMED_MATCH", matches: [entry("PEP-1")] })
    await run(id)
    expect(await decide((await latestMatch(id)).id, "REJECTED")).toMatchObject({ ok: true })
    scripted = clear()
    await run(id)
    expect(await stateOf(id)).toBe("BLOCKED")
    expect(await approvalRefusal(await application({ clientId: id }))).toContain("screening blocks approval")
  })

  it("REPRO 3: a decision on a match never carries onto a CONFIRMED_MATCH re-run", async () => {
    const id = await client("Example")
    scripted = withMatch({ type: "PEP", result: "CONFIRMED_MATCH", matches: [entry("PEP-2")] })
    await run(id)
    expect(await decide((await latestMatch(id)).id, "FALSE_POSITIVE")).toMatchObject({ ok: true })
    await run(id)
    expect(await stateOf(id)).toBe("REFER")
    expect((await latestMatch(id)).carriedFromCheckId).toBeNull()
  })

  it("REPRO 3b: a decision on a POSSIBLE_MATCH does not carry onto a CONFIRMED_MATCH of the same entry", async () => {
    const id = await client("Example")
    scripted = withMatch({ type: "PEP", result: "POSSIBLE_MATCH", matches: [entry("PEP-3")] })
    await run(id)
    expect(await decide((await latestMatch(id)).id, "FALSE_POSITIVE")).toMatchObject({ ok: true })
    scripted = withMatch({ type: "PEP", result: "CONFIRMED_MATCH", matches: [entry("PEP-3")] })
    await run(id)
    expect(await stateOf(id)).toBe("REFER")
  })

  it("REPRO 4: a possible match with no list entries, or entries without ids, always refers", async () => {
    for (const matches of [[], [entry("")]]) {
      const id = await client("Example")
      scripted = withMatch({ type: "SANCTIONS", result: "POSSIBLE_MATCH", matches })
      await run(id)
      expect(await decide((await latestMatch(id)).id, "FALSE_POSITIVE")).toMatchObject({ ok: true })
      await run(id)
      expect(await stateOf(id), JSON.stringify(matches)).toBe("REFER")
    }
  })

  it("REPRO 5: an entity application is refused while the entity has no screening", async () => {
    const entityId = `brk_ent_${randomUUID().slice(0, 8)}`
    await db.$executeRawUnsafe(
      `INSERT INTO "BusinessEntity" ("id", "tenantId", "type", "legalName", "registrationNumber", "updatedAt")
       VALUES ($1, $2, 'COMPANY', 'Synthetic Holdings (Pty) Ltd', $3, now())`, entityId, tenantId, `REG-${entityId}`)
    const refusal = await approvalRefusal(await application({ entityId }))
    expect(refusal).toContain("has not been screened")
  })
})
