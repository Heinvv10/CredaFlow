/**
 * Round-2 breaker repros (PR #81 at 885c5531), against real Postgres. Each
 * test was written to fail on 885c5531 and pass after its fix:
 *
 *   N2   a clearance never carries onto a different identity
 *   N1   identity fingerprints are unambiguous ('|' in a name)
 *   N7   deactivating or deleting a sanctioned related person does not free the entity
 *   LOW  a clearance does not carry when the matched name changed (R3: a score change alone carries)
 *
 *   RUN_SCREENING_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/screening/breaker-repros-round2.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { PrismaClient } from "@prisma/client"
import { runScreening } from "./run"
import { reviewScreeningCheck } from "./review"
import { readBorrowerScreening, readSubjectScreening } from "./gate"
import { screenOnSubmit } from "./on-submit"
import { registerScreeningProvider } from "./registry"
import type { ScreeningMatch, ScreeningProviderResult, ScreeningTypeResult } from "./types"

const RUN = process.env.RUN_SCREENING_IT === "1"
const suite = RUN ? describe.sequential : describe.skip
const db = new PrismaClient()
const token = randomUUID().replaceAll("-", "").slice(0, 16)
const tenantId = `tenant_brk2_${token}`
const product = `product_brk2_${token}`
const maker = { id: `maker2_${token}`, email: `maker2-${token}@test.invalid` }
const checker = { id: `checker2_${token}`, email: `checker2-${token}@test.invalid`, role: "ADMIN" as const, totpVerified: true }
const n = () => randomUUID().slice(0, 8)

/** A provider whose answer depends on the subject's surname or legal name. Test-only. */
const answers = new Map<string, ScreeningTypeResult[]>()
registerScreeningProvider({
  id: `scripted2_${token}`,
  label: "Scripted (test)",
  simulated: false,
  supportedTypes: ["PEP", "SANCTIONS", "ADVERSE_MEDIA"],
  async screen(subject): Promise<ScreeningProviderResult> {
    const key = subject.kind === "PERSON" ? subject.lastName : subject.legalName
    return { results: answers.get(key) ?? clear(), providerReference: "scripted2" }
  },
})
function clear(): ScreeningTypeResult[] {
  return (["PEP", "SANCTIONS", "ADVERSE_MEDIA"] as const).map((type) => ({ type, result: "CLEAR", matches: [] }))
}
const withMatch = (m: ScreeningTypeResult) => clear().map((r) => (r.type === m.type ? m : r))
const entry = (listEntryId: string, over: Partial<ScreeningMatch> = {}): ScreeningMatch =>
  ({ listEntryId, listName: "Test list", matchedName: "TEST PERSON", score: 90, detail: null, ...over })

async function client(firstName: string, lastName: string): Promise<string> {
  const id = `brk2_${n()}`
  await db.client.create({ data: {
    id, tenantId, reference: `REF-${id}`, idNumber: `ID-${id}`, firstName, lastName, email: `${id}@test.invalid`, phone: "+27820000000",
  } })
  return id
}
const run = (clientId: string) => runScreening({ tenantId, subject: { clientId }, trigger: "MANUAL", actor: maker })
const decide = (checkId: string, decision: "FALSE_POSITIVE" | "ACCEPTED") =>
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

suite("round-2 breaker repros", () => {
  beforeAll(async () => {
    await db.tenant.create({ data: { id: tenantId, slug: `brk2-${token}`, name: "Breaker repros round 2" } })
    await db.tenantConfig.create({ data: { tenantId, screeningProvider: `scripted2_${token}`, screeningReviewMinRole: "ADMIN", requireStaffTotp: true } })
    await db.user.createMany({ data: [
      { id: maker.id, tenantId, email: maker.email, password: "synthetic", role: "CREDIT_OFFICER" },
      { id: checker.id, tenantId, email: checker.email, password: "synthetic", role: "ADMIN" },
    ] })
    await db.$executeRawUnsafe(
      `INSERT INTO "LoanProduct" ("id", "tenantId", "code", "name", "productType", "minAmount", "maxAmount", "minTermDays", "maxTermDays", "interestRatePm", "interestModel")
       VALUES ($1, $2, $3, 'Breaker 2 product', 'PERSONAL', 100000, 1000000, 30, 90, 0.03, 'DAILY_ACCRUAL')`, product, tenantId, `BRK2-${token}`)
  })
  afterAll(async () => db.$disconnect())

  it("N2: a clearance made for one identity does not carry onto the client after its identity changed", async () => {
    const id = await client("Synthetic", `Before-${n()}`)
    const before = (await db.client.findUniqueOrThrow({ where: { id } })).lastName
    answers.set(before, withMatch({ type: "PEP", result: "POSSIBLE_MATCH", matches: [entry("PEP-N2")] }))
    await run(id)
    expect(await decide((await latestMatch(id)).id, "FALSE_POSITIVE")).toMatchObject({ ok: true })
    const after = `After-${n()}`
    await db.client.updateMany({ where: { id, tenantId }, data: { lastName: after, idNumber: `ID-other-${id}` } })
    answers.set(after, withMatch({ type: "PEP", result: "POSSIBLE_MATCH", matches: [entry("PEP-N2")] }))
    await run(id)
    expect(await stateOf(id)).toBe("REFER")
    expect((await latestMatch(id)).carriedFromCheckId).toBeNull()
  })

  it("N1: moving '|' between name fields is an identity change, not a collision", async () => {
    const [same] = await db.$queryRawUnsafe<Array<{ same: boolean }>>(
      `SELECT "screeningPersonFingerprint"('A|B', 'C', 'X1', NULL) = "screeningPersonFingerprint"('A', 'B|C', 'X1', NULL) AS same`)
    expect(same.same).toBe(false)
    const id = await client("Pipe|Name", `Pipe-${n()}`)
    const last = (await db.client.findUniqueOrThrow({ where: { id } })).lastName
    await run(id)
    expect(await stateOf(id)).toBe("CLEAR")
    await db.client.updateMany({ where: { id, tenantId }, data: { firstName: "Pipe", lastName: `Name|${last}` } })
    expect(await stateOf(id)).toBe("NOT_SCREENED")
  })

  for (const removal of ["deactivated", "deleted"] as const) {
    it(`N7: a sanctioned related person ${removal} after screening still blocks the entity's approval`, async () => {
      const entityId = `brk2_ent_${n()}`
      const legalName = `Entity-${n()}`
      await db.$executeRawUnsafe(
        `INSERT INTO "BusinessEntity" ("id", "tenantId", "type", "legalName", "registrationNumber", "updatedAt") VALUES ($1, $2, 'COMPANY', $3, $4, now())`,
        entityId, tenantId, legalName, `REG-${entityId}`)
      const director = await client("Synthetic", `Sanctioned-${n()}`)
      const directorName = (await db.client.findUniqueOrThrow({ where: { id: director } })).lastName
      answers.set(directorName, withMatch({ type: "SANCTIONS", result: "CONFIRMED_MATCH", matches: [entry("SAN-N7")] }))
      const relId = `er_${n()}`
      await db.$executeRawUnsafe(`INSERT INTO "EntityRelationship" ("id", "tenantId", "entityId", "clientId", "role", "updatedAt") VALUES ($1, $2, $3, $4, 'DIRECTOR', now())`,
        relId, tenantId, entityId, director)
      const appId = `brk2_app_${n()}`
      await db.$executeRawUnsafe(
        `INSERT INTO "LoanApplication" ("id", "tenantId", "reference", "entityId", "productId", "appliedAmount", "appliedTermDays", "status", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, 500000, 30, 'SUBMITTED', now())`, appId, tenantId, `APP-${appId}`, entityId, product)
      await screenOnSubmit({ tenantId, applicationId: appId, actor: maker })
      expect(await approvalRefusal(appId)).toContain("screening blocks approval")

      if (removal === "deactivated") {
        await db.$executeRawUnsafe(`UPDATE "EntityRelationship" SET active = false WHERE id = $1`, relId)
      } else {
        await db.$executeRawUnsafe(`DELETE FROM "EntityRelationship" WHERE id = $1`, relId)
      }
      expect((await readBorrowerScreening(tenantId, { clientId: null, entityId })).allowed).toBe(false)
      expect(await approvalRefusal(appId)).toContain("screening blocks approval")
    })
  }

  it("LOW: a clearance does not carry when the matched name of the same entry changed; R3: a score-only change carries", async () => {
    const cases: Array<[Partial<ScreeningMatch>, string]> = [[{ matchedName: "SOMEONE ELSE" }, "REFER"], [{ score: 99 }, "CLEAR"]]
    for (const [changed, expected] of cases) {
      const id = await client("Synthetic", `Low-${n()}`)
      const last = (await db.client.findUniqueOrThrow({ where: { id } })).lastName
      answers.set(last, withMatch({ type: "PEP", result: "POSSIBLE_MATCH", matches: [entry("PEP-LOW")] }))
      await run(id)
      expect(await decide((await latestMatch(id)).id, "FALSE_POSITIVE")).toMatchObject({ ok: true })
      answers.set(last, withMatch({ type: "PEP", result: "POSSIBLE_MATCH", matches: [entry("PEP-LOW", changed)] }))
      await run(id)
      expect(await stateOf(id), JSON.stringify(changed)).toBe(expected)
    }
  })
})
