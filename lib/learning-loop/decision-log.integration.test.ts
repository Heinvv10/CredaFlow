/**
 * Real-Postgres proof of the decision log (migration
 * 20261021090000_credit_decision_record): a record commits with its decision
 * and rolls back with it, the table refuses UPDATE, DELETE and TRUNCATE, its
 * CHECKs refuse an unexplained override, a nameless staff decision, a bad
 * hash and an impossible probability, and row-level security keeps one
 * lender's records from another's (under a role RLS binds, as
 * lib/tenant-isolation.integration.test.ts). The asset-finance route writes
 * through the real stack in lib/asset-finance/deal-decision.integration.test.ts.
 *
 *   RUN_DECISION_LOG_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/learning-loop/decision-log.integration.test.ts
 */
import { randomBytes, randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { createAppPrismaClient } from "@/lib/prisma"
import { runWithTenant } from "@/lib/tenant-scope"
import { recordData, recordDecisions, type DecisionLogDb } from "./decision-log"
import { consumerApprovalRecords, consumerDeclineRecord } from "./records"

const RUN = process.env.RUN_DECISION_LOG_IT === "1"
const suite = RUN ? describe.sequential : describe.skip
const db = new PrismaClient()
const ROLE = "cf_decision_log_it"
const t = randomUUID().replaceAll("-", "").slice(0, 12)
const tenantA = `dl-a-${t}`
const tenantB = `dl-b-${t}`
let app: ReturnType<typeof createAppPrismaClient>
// The writer is typed for the app's extended client; a plain one serves here.
const plain = (tx: unknown) => tx as DecisionLogDb

const decidedAt = new Date("2026-10-21T08:00:00.000Z")
const approval = (tenantId: string, applicationId: string) => consumerApprovalRecords({
  tenantId, applicationId, clientId: `client-${applicationId}`, actor: { userId: "user-1", role: "LOAN_ADMIN" }, decidedAt,
  productType: "PERSONAL", interestRatePm: 0.05, principalCents: 1_500_000, termDays: 180, instalmentCents: 310_000,
  creditLifePremiumCents: 0, repaymentMethod: "EFT", monthlyIncomeCents: 2_500_000,
  thresholds: { bureauMinScore: 580, bureauBlockAdverse: false, ndiBufferPct: 110, bureauMaxAgeDays: 60 },
  bureau: { id: "bureau-1", provider: "experian", score: 640, unscoreable: false, hasAdverse: false, deceased: false, underDebtReview: false, hasJudgement: false, hasNotice: false, obligations: { totalMonthly: 0 } },
  bureauGateBlocked: false, bureauOverrideReason: null,
  affordability: { ndiCents: 600_000, requiredNdiCents: 341_000 }, screeningState: "CLEAR", creditCheckFlags: [],
  affordabilitySnapshot: { policyVersion: "approval-ndi-v3", inputFingerprint: "a".repeat(64), decisionFingerprint: "b".repeat(64) },
})
const valid = () => recordData(consumerDeclineRecord({
  tenantId: tenantA, applicationId: `app-check-${randomUUID()}`, clientId: null, actor: { userId: "user-1", role: "LOAN_ADMIN" }, decidedAt, declineCategory: "OTHER",
}))

async function createAppRole(): Promise<string> {
  const password = randomBytes(12).toString("hex")
  const exists = await db.$queryRaw<unknown[]>`SELECT 1 FROM pg_roles WHERE rolname = ${ROLE}`
  if (exists.length === 0) await db.$executeRawUnsafe(`CREATE ROLE ${ROLE} LOGIN NOSUPERUSER NOBYPASSRLS`)
  await db.$executeRawUnsafe(`ALTER ROLE ${ROLE} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`)
  await db.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${ROLE}`)
  await db.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${ROLE}`)
  await db.$executeRawUnsafe(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${ROLE}`)
  return password
}

function roleUrl(password: string): string {
  const url = new URL(process.env.DATABASE_URL ?? "")
  url.username = ROLE
  url.password = password
  url.searchParams.set("connection_limit", "1")
  return url.toString()
}

suite("decision log (real Postgres)", () => {
  beforeAll(async () => {
    for (const id of [tenantA, tenantB]) await db.tenant.create({ data: { id, slug: id, name: `Decision log IT ${id}` } })
    await db.$transaction((tx) => recordDecisions(plain(tx), approval(tenantA, "app-a")))
    await db.$transaction((tx) => recordDecisions(plain(tx), approval(tenantB, "app-b")))
    vi.stubEnv("TENANT_RLS", "on")
    app = createAppPrismaClient(roleUrl(await createAppRole()))
  }, 60_000)

  afterAll(async () => {
    vi.unstubAllEnvs()
    await app?.$disconnect()
    // Append-only: the replica role skips its trigger, as cleanupDealFixture does.
    await db.$transaction([
      db.$executeRawUnsafe("SET LOCAL session_replication_role = replica"),
      db.creditDecisionRecord.deleteMany({ where: { tenantId: { in: [tenantA, tenantB] } } }),
      db.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB] } } }),
    ])
    if (app) {
      await db.$executeRawUnsafe(`DROP OWNED BY ${ROLE}`)
      await db.$executeRawUnsafe(`DROP ROLE ${ROLE}`)
    }
    await db.$disconnect()
  })

  it("writes the decision and its offer, each with a canonical hash of its inputs and the policy", async () => {
    const rows = await db.creditDecisionRecord.findMany({ where: { tenantId: tenantA }, orderBy: { kind: "asc" } })
    expect(rows.map((r) => [r.kind, r.decision, r.recommendation, r.overridden])).toEqual([
      ["CREDIT_DECISION", "APPROVE", "PASS", false],
      ["OFFER", "APPROVED_TERMS", "NONE", false],
    ])
    for (const row of rows) {
      expect(row.inputsHash).toMatch(/^[0-9a-f]{64}$/)
      expect(row.policyHash).toMatch(/^[0-9a-f]{64}$/)
      expect(row.predictedProbability).toBeNull()
    }
  })

  it("rolls the record back with a decision that does not commit", async () => {
    await expect(db.$transaction(async (tx) => {
      await recordDecisions(plain(tx), approval(tenantA, "app-rolled-back"))
      throw new Error("the decision failed after its record was written")
    })).rejects.toThrow("the decision failed")
    expect(await db.creditDecisionRecord.count({ where: { applicationId: "app-rolled-back" } })).toBe(0)
  })

  it("refuses to change, remove or truncate a record", async () => {
    await expect(db.$executeRawUnsafe(`UPDATE "CreditDecisionRecord" SET "overridden" = true WHERE "tenantId" = $1`, tenantA)).rejects.toThrow(/append-only/)
    await expect(db.$executeRawUnsafe(`DELETE FROM "CreditDecisionRecord" WHERE "tenantId" = $1`, tenantA)).rejects.toThrow(/append-only/)
    // CASCADE: DecisionOutcome references the table, and a plain TRUNCATE stops at that before the trigger runs.
    await expect(db.$executeRawUnsafe(`TRUNCATE "CreditDecisionRecord" CASCADE`)).rejects.toThrow(/append-only/)
    await expect(db.creditDecisionRecord.updateMany({ where: { tenantId: tenantA }, data: { decision: "DECLINE" } })).rejects.toThrow(/append-only/)
    expect(await db.creditDecisionRecord.count({ where: { tenantId: tenantA } })).toBe(2)
  })

  it.each([
    ["an override with no reason", { overridden: true, overrideReason: null }, "CreditDecisionRecord_override_reason"],
    ["an override with a reason under 10 characters", { overridden: true, overrideReason: "  short  " }, "CreditDecisionRecord_override_reason"],
    ["a reason with no override", { overridden: false, overrideReason: "A reason for nothing at all." }, "CreditDecisionRecord_override_reason"],
    ["a staff decision naming nobody", { actorType: "STAFF" as const, actorUserId: null }, "CreditDecisionRecord_actor"],
    ["an automated decision naming a person", { actorType: "SYSTEM" as const, actorUserId: "user-1" }, "CreditDecisionRecord_actor"],
    ["a hash that is not sha256 hex", { inputsHash: "Z".repeat(64) }, "CreditDecisionRecord_hashes_sha256"],
    ["a probability above 1", { predictedProbability: 1.5 }, "CreditDecisionRecord_probability_range"],
    ["a decision about no one", { applicationId: null, loanId: null, clientId: null }, "CreditDecisionRecord_has_subject"],
    ["a lower-case decision code", { decision: "approve" }, "CreditDecisionRecord_decision_code"],
    ["a snapshot that is not an object", { inputsSnapshot: [] }, "CreditDecisionRecord_json_objects"],
  ])("refuses %s", async (_name, change, constraint) => {
    await expect(db.creditDecisionRecord.create({ data: { ...valid(), ...change } })).rejects.toThrow(constraint)
  })

  it("accepts a probability in [0, 1] and an automated decision naming nobody", async () => {
    await db.creditDecisionRecord.create({ data: { ...valid(), predictedProbability: 0.12345, actorType: "SYSTEM", actorUserId: null, actorRole: null } })
  })

  it("connects the isolation checks as a role RLS binds (otherwise they prove nothing)", async () => {
    const [me] = await app.$queryRaw<{ su: boolean; bypass: boolean }[]>`
      SELECT rolsuper AS su, rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user`
    expect(me).toEqual({ su: false, bypass: false })
  })

  it("shows a lender only its own records, through the client and through raw SQL", async () => {
    const asB = await runWithTenant(tenantB, async () => ({
      rows: await app.creditDecisionRecord.findMany({ select: { tenantId: true } }),
      raw: await app.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM "CreditDecisionRecord" WHERE "tenantId" = ${tenantA}`,
    }))
    expect(new Set(asB.rows.map((r) => r.tenantId))).toEqual(new Set([tenantB]))
    expect(asB.raw[0].n).toBe(0)
  })

  it("refuses a record written into another lender from a lender's frame", async () => {
    // Awaited inside the frame: a PrismaPromise runs when awaited, which outside it would be with no tenant.
    await expect(runWithTenant(tenantB, async () => await app.$executeRaw`
      INSERT INTO "CreditDecisionRecord" ("id", "tenantId", "kind", "decision", "recommendation", "overridden", "actorType", "actorUserId",
        "applicationId", "sourceEntityType", "sourceEntityId", "ruleVersion", "policyHash", "inputsSnapshot", "evidenceRefs", "inputsHash", "decidedAt")
      VALUES (${randomUUID()}, ${tenantA}, 'CREDIT_DECISION', 'DECLINE', 'NONE', false, 'STAFF', 'user-1',
        'app-x', 'LoanApplication', 'app-x', 'v1', ${"c".repeat(64)}, '{}', '{}', ${"d".repeat(64)}, now())`))
      .rejects.toThrow(/row-level security/)
  })
})
