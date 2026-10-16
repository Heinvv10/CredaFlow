/**
 * The NCA final-notice reminder against the calendar (real migrated Postgres,
 * clock injected through the cron route): an NCA recovery left at
 * PROCEEDS_APPLIED keeps its charges frozen, so the daily deadline cron bells
 * its creator once, 5 SA business days after the freeze began, and changes
 * nothing else. The freeze dates are pinned and every due day is written out
 * by hand, so a wrong holiday list cannot also move the expectation. NON_NCA
 * recoveries and NCA ones whose final notice is out are never reminded.
 *
 *   RUN_ASSET_FINANCE_RECOVERY_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/recovery-final-notice-reminder.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { NextRequest } from "next/server"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { GET as deadlineCron } from "@/app/api/cron/asset-finance-recovery-deadlines/route"
import { testSetup } from "./lease-servicing.integration-fixture"
import { ladderRecovery } from "./recovery-path.integration-fixture"
import { cleanupRecoveryFixture, createRecoveryFixture, recoveryFixtureTenantId, type RecoveryFixture } from "./recovery.integration-fixture"

// The deal fixture imports staff routes, which import NextAuth; the cron needs no session.
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))

const RUN = process.env.RUN_ASSET_FINANCE_RECOVERY_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: RecoveryFixture
const database = (): PrismaClient => {
  if (!db) throw new Error("RUN_ASSET_FINANCE_RECOVERY_IT=1 is required")
  return db
}
const CRON_SECRET = "final-notice-reminder-it-secret"

/** The deadline cron as it runs on SAST calendar day `day`. */
async function runOn(day: string): Promise<{ status: number; body: Record<string, unknown> }> {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date(`${day}T12:00:00+02:00`) })
  try {
    const response = await deadlineCron(new NextRequest("http://localhost/api/cron/asset-finance-recovery-deadlines", { headers: { "x-cron-secret": CRON_SECRET } }))
    return { status: response.status, body: (await response.json()) as Record<string, unknown> }
  } finally {
    vi.useRealTimers()
  }
}

suite.sequential("NCA final-notice reminder on the SA calendar (real Postgres, injected clock)", () => {
  beforeAll(async () => {
    process.env.CRON_SECRET = CRON_SECRET
    fx = await createRecoveryFixture(database(), t)
  }, 120_000)

  afterAll(async () => {
    vi.useRealTimers()
    await cleanupRecoveryFixture(database(), recoveryFixtureTenantId(t)).catch(() => undefined)
    await db?.$disconnect()
  }, 60_000)

  it("bells the creator once on the 5th business day (weekends, Human Rights Day observed, Good Friday and Family Day skipped), none before, and changes no recovery or loan", async () => {
    // Fri 2027-01-08 + 5 business days skips the weekend of 9-10 Jan: due Fri 2027-01-15.
    const weekend = await ladderRecovery(database(), fx, true, "PROCEEDS_APPLIED")
    // Thu 2027-03-18 + 5: Fri 19 (1); Mon 22 is Human Rights Day observed (21 Mar is a Sunday); Tue 23 (2),
    // Wed 24 (3), Thu 25 (4); Fri 26 Good Friday and Mon 29 Family Day; Tue 2027-03-30 (5).
    const easter = await ladderRecovery(database(), fx, true, "PROCEEDS_APPLIED", {}, true)
    const nonNca = await ladderRecovery(database(), fx, false, "PROCEEDS_APPLIED")
    const noticed = await ladderRecovery(database(), fx, true, "FINAL_NOTICE_ISSUED")
    const frozen: [string, string][] = [[weekend.id, "2027-01-08"], [easter.id, "2027-03-18"], [nonNca.id, "2027-01-08"], [noticed.id, "2027-01-08"]]
    // A freeze end already set (NON_NCA, or after the final notice) moves with its start, as the freeze-window CHECK requires.
    await testSetup(database(), ...frozen.map(([id, day]): [string, ...unknown[]] => [
      `UPDATE "Recovery" SET "chargesFrozenFrom" = $1::date, "chargesFrozenUntil" = CASE WHEN "chargesFrozenUntil" IS NULL THEN NULL ELSE $1::date + 14 END WHERE "id" = $2`, day, id,
    ]))
    const all = [weekend, easter, nonNca, noticed]

    const recoveries = () => database().recovery.findMany({ where: { id: { in: all.map((r) => r.id) } }, orderBy: { id: "asc" } })
    const loans = () => database().loan.findMany({ where: { id: { in: all.map((r) => r.loan.loanId) } }, orderBy: { id: "asc" } })
    const bells = (id: string) => database().notification.findMany({ where: { tenantId: fx.tenantId, type: "RECOVERY_FINAL_NOTICE_DUE", entityId: id } })
    const markers = (id: string) => database().auditLog.count({ where: { tenantId: fx.tenantId, action: "ASSET_RECOVERY_FINAL_NOTICE_REMINDED", entityId: id } })
    const counts = async () => Promise.all(all.map(async (r) => (await bells(r.id)).length))
    const recoveriesBefore = await recoveries()
    const loansBefore = await loans()

    const ok = { status: 200, body: { ok: true, failed: 0 } }
    expect(await runOn("2027-01-14")).toMatchObject(ok) // Thu: 4 business days
    expect(await counts()).toEqual([0, 0, 0, 0])
    expect(await runOn("2027-01-15")).toMatchObject(ok) // Fri: the 5th
    expect(await counts()).toEqual([1, 0, 0, 0])
    expect(await runOn("2027-01-16")).toMatchObject(ok) // the day after: still one
    expect(await counts()).toEqual([1, 0, 0, 0])
    for (const day of ["2027-03-25", "2027-03-26", "2027-03-29"]) {
      expect(await runOn(day), day).toMatchObject(ok)
      expect(await counts(), day).toEqual([1, 0, 0, 0])
    }
    expect(await runOn("2027-03-30")).toMatchObject(ok) // Tue: the 5th
    expect(await counts()).toEqual([1, 1, 0, 0])
    expect(await runOn("2027-03-30")).toMatchObject(ok) // again the same day
    expect(await runOn("2027-03-31")).toMatchObject(ok)
    expect(await counts()).toEqual([1, 1, 0, 0])

    for (const r of [weekend, easter]) {
      const [item] = await bells(r.id)
      expect(item).toMatchObject({ userId: fx.officer, entityType: "Recovery", readAt: null })
      // No borrower name (the fixture's are TEST / Debtor…) and no ID or registration number.
      expect(`${item.title} ${item.body}`).not.toMatch(/TEST|Debtor/)
      expect(`${item.title} ${item.body}`).not.toContain(r.loan.borrowerKey)
      expect(`${item.title} ${item.body}`).not.toMatch(/\d{13}/)
      expect(item.body).toContain("5 or more business days")
      expect(await markers(r.id)).toBe(1)
    }
    for (const r of [nonNca, noticed]) expect(await markers(r.id)).toBe(0)

    // No state change: every recovery and loan row reads exactly as before the runs.
    expect(await recoveries()).toEqual(recoveriesBefore)
    expect(await loans()).toEqual(loansBefore)
  }, 240_000)
})
