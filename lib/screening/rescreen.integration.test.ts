/**
 * Real-Postgres proof of re-screening: the cron's candidate query (A1, A5, A6),
 * its time budget, the gate retrying an errored run, and the advisory lock
 * that makes an approval wait for a run in flight.
 *
 *   RUN_SCREENING_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/screening/rescreen.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { prisma } from "@/lib/prisma"
import { refreshTenantScreening, rescreenCandidates } from "./refresh"
import { borrowerScreeningGate, lockedBorrowerScreeningAllows } from "./gate"
import { lockSubjectScreening } from "./store"

const RUN = process.env.RUN_SCREENING_IT === "1"
const suite = RUN ? describe.sequential : describe.skip
const token = randomUUID().replaceAll("-", "").slice(0, 12)
const t = `tenant_rs_${token}`
const product = `product_rs_${token}`
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const n = () => randomUUID().slice(0, 8)

async function client(opts: { deceased?: boolean } = {}): Promise<string> {
  const id = `c_rs_${n()}`
  await prisma.client.create({ data: {
    id, tenantId: t, reference: `REF-${id}`, idNumber: `ID-${id}`, firstName: "Synthetic", lastName: "Rescreen",
    email: `${id}@test.invalid`, phone: "+27820000000", ...(opts.deceased ? { deceasedAt: new Date() } : {}),
  } })
  return id
}
async function application(col: "clientId" | "entityId", id: string, status: string): Promise<void> {
  await prisma.$executeRawUnsafe(
    `INSERT INTO "LoanApplication" ("id", "tenantId", "reference", "${col}", "productId", "appliedAmount", "appliedTermDays", "status", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, 500000, 30, $6::"AppStatus", now())`, `a_${n()}`, t, `APP-${n()}`, id, product, status)
}
/** A run for the subject's CURRENT identity at `at`; ERROR or CLEAR on every type. */
async function runAt(col: "clientId" | "entityId", id: string, at: Date, result: "CLEAR" | "ERROR" = "CLEAR", sanctions = false): Promise<string> {
  const runId = `r_${n()}`
  for (const type of ["PEP", "SANCTIONS", "ADVERSE_MEDIA"]) {
    const r = sanctions && type === "SANCTIONS" ? "CONFIRMED_MATCH" : result
    await prisma.$executeRawUnsafe(
      `INSERT INTO "ScreeningCheck" ("id", "tenantId", "${col}", "runId", "trigger", "provider", "type", "result", "matchFingerprint", "matches", "subjectFingerprint", "createdAt")
       VALUES ($1, $2, $3, $4, 'PERIODIC', 'simulated', $5::"ScreeningType", $6::"ScreeningResult", $7, $8::jsonb,
         "screeningCurrentFingerprint"($2, $9, $10), $11::timestamp)`,
      `${runId}_${type}`, t, id, runId, type, r, r === "CONFIRMED_MATCH" ? "fp" : null,
      r === "CONFIRMED_MATCH" ? `[{"listEntryId": "S1"}]` : "[]",
      col === "clientId" ? id : null, col === "entityId" ? id : null, at.toISOString())
  }
  return runId
}
const ids = (refs: Array<{ clientId: string } | { entityId: string }>) => refs.map((r) => ("clientId" in r ? r.clientId : r.entityId))

suite("re-screening against Postgres", () => {
  beforeAll(async () => {
    await prisma.tenant.create({ data: { id: t, slug: `rs-${token}`, name: "Rescreen test" } })
    await prisma.tenantConfig.create({ data: { tenantId: t, screeningProvider: "simulated", requireStaffTotp: true } })
    await prisma.user.create({ data: { id: `officer_${token}`, tenantId: t, email: `officer-${token}@test.invalid`, password: "x", role: "CREDIT_OFFICER" } })
    await prisma.$executeRawUnsafe(
      `INSERT INTO "LoanProduct" ("id", "tenantId", "code", "name", "productType", "minAmount", "maxAmount", "minTermDays", "maxTermDays", "interestRatePm", "interestModel")
       VALUES ($1, $2, $3, 'Rescreen product', 'PERSONAL', 100000, 1000000, 30, 90, 0.03, 'DAILY_ACCRUAL')`, product, t, `RS-${token}`)
  })
  afterAll(async () => prisma.$disconnect())

  it("A6/A1: selects the active, due subjects only — unscreened, stale, changed, entity parties, errored past backoff", async () => {
    const now = new Date()
    const unscreened = await client(); await application("clientId", unscreened, "SUBMITTED")
    const fresh = await client(); await application("clientId", fresh, "UNDER_REVIEW"); await runAt("clientId", fresh, new Date(now.getTime() - DAY))
    const stale = await client(); await application("clientId", stale, "SUBMITTED"); await runAt("clientId", stale, new Date(now.getTime() - 40 * DAY))
    const changed = await client(); await application("clientId", changed, "SUBMITTED"); await runAt("clientId", changed, new Date(now.getTime() - DAY))
    await prisma.client.updateMany({ where: { id: changed, tenantId: t }, data: { lastName: "Renamed" } })
    const draftOnly = await client(); await application("clientId", draftOnly, "DRAFT")
    const deceased = await client({ deceased: true }); await application("clientId", deceased, "SUBMITTED")
    const erroredLongAgo = await client(); await application("clientId", erroredLongAgo, "SUBMITTED"); await runAt("clientId", erroredLongAgo, new Date(now.getTime() - 2 * HOUR), "ERROR")
    const erroredJustNow = await client(); await application("clientId", erroredJustNow, "SUBMITTED"); await runAt("clientId", erroredJustNow, new Date(now.getTime() - 10 * 60 * 1000), "ERROR")
    // A three-day failure streak: the backoff after the latest failure is ~2 days, so one day later is too soon.
    const streak = await client(); await application("clientId", streak, "SUBMITTED")
    await runAt("clientId", streak, new Date(now.getTime() - 3 * DAY), "ERROR")
    await runAt("clientId", streak, new Date(now.getTime() - DAY), "ERROR")
    const entityId = `e_rs_${n()}`
    await prisma.$executeRawUnsafe(`INSERT INTO "BusinessEntity" ("id", "tenantId", "type", "legalName", "registrationNumber", "updatedAt") VALUES ($1, $2, 'COMPANY', 'Synthetic Rescreen Ltd', $3, now())`, entityId, t, `REG-${entityId}`)
    const director = await client()
    await prisma.$executeRawUnsafe(`INSERT INTO "EntityRelationship" ("id", "tenantId", "entityId", "clientId", "role", "updatedAt") VALUES ($1, $2, $3, $4, 'DIRECTOR', now())`, `er_${n()}`, t, entityId, director)
    await application("entityId", entityId, "UNDER_REVIEW")

    const due = ids(await rescreenCandidates(t, now))
    for (const id of [unscreened, stale, changed, erroredLongAgo, entityId, director]) expect(due, id).toContain(id)
    for (const id of [fresh, draftOnly, deceased, erroredJustNow, streak]) expect(due, id).not.toContain(id)
    expect(due.indexOf(stale)).toBeGreaterThan(-1)
  })

  it("A5: reports the true backlog and what a spent time budget left, rather than stopping at a fixed count", async () => {
    const before = await rescreenCandidates(t, new Date())
    const spent = await refreshTenantScreening(t, new Date(), Date.now() - 1)
    expect(spent).toMatchObject({ candidates: before.length, screened: 0, remaining: before.length })
    const done = await refreshTenantScreening(t, new Date(), Date.now() + 60_000)
    expect(done.screened).toBe(before.length)
    expect(done.remaining).toBe(0)
    expect(ids(await rescreenCandidates(t, new Date()))).toEqual([])
  })

  it("A1: the approval gate retries an errored latest run at once instead of waiting 30 days", async () => {
    const id = await client()
    await runAt("clientId", id, new Date(), "ERROR")
    const gate = await borrowerScreeningGate({ tenantId: t, borrower: { clientId: id, entityId: null }, applicationId: "n/a", actor: { id: `officer_${token}`, email: "o@test.invalid" } })
    expect(gate).toMatchObject({ allowed: true, state: { state: "CLEAR" } })
  })

  it("A6: an approval re-check waits for a run in flight and sees its sanctions match", async () => {
    const id = await client()
    await runAt("clientId", id, new Date(Date.now() - DAY))
    const borrower = { clientId: id, entityId: null }
    let locked: () => void = () => undefined
    const hasLock = new Promise<void>((resolve) => { locked = resolve })
    const inFlight = prisma.$transaction(async (tx) => {
      await lockSubjectScreening(tx, t, { clientId: id })
      locked()
      await runAtTx(tx, id)
      await new Promise((r) => setTimeout(r, 300))
    })
    await hasLock
    const allowed = await prisma.$transaction((tx) => lockedBorrowerScreeningAllows(tx, t, borrower))
    await inFlight
    expect(allowed).toBe(false)
  })
})

/** A sanctions-confirmed run inside the caller's transaction. */
async function runAtTx(tx: Pick<typeof prisma, "$executeRawUnsafe">, id: string): Promise<void> {
  const runId = `r_${n()}`
  for (const type of ["PEP", "SANCTIONS", "ADVERSE_MEDIA"]) {
    const r = type === "SANCTIONS" ? "CONFIRMED_MATCH" : "CLEAR"
    await tx.$executeRawUnsafe(
      `INSERT INTO "ScreeningCheck" ("id", "tenantId", "clientId", "runId", "trigger", "provider", "type", "result", "matchFingerprint", "matches", "subjectFingerprint")
       VALUES ($1, $2, $3, $4, 'PERIODIC', 'simulated', $5::"ScreeningType", $6::"ScreeningResult", $7, $8::jsonb, "screeningCurrentFingerprint"($2, $3, NULL))`,
      `${runId}_${type}`, t, id, runId, type, r, r === "CLEAR" ? null : "fp", r === "CLEAR" ? "[]" : `[{"listEntryId": "S1"}]`)
  }
}
