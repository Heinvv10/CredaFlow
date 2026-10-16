/**
 * The NCA final-notice reminder (real migrated Postgres, clock injected): an
 * NCA recovery left at PROCEEDS_APPLIED with no final notice keeps its charges
 * frozen, so the daily deadline cron bells its creator once, 5 SA business
 * days after the proceeds froze them, and changes nothing else. NON_NCA
 * recoveries and NCA ones whose final notice is out are never reminded.
 *
 *   RUN_ASSET_FINANCE_RECOVERY_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/recovery-final-notice-reminder.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { NextRequest } from "next/server"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { addSouthAfricanBusinessDays } from "@/lib/compliance/sa-business-days"
import { GET as deadlineCron } from "@/app/api/cron/asset-finance-recovery-deadlines/route"
import { fromDayNumber, isoOfDbDate, toDayNumber } from "./dates"
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
const noon = (iso: string) => new Date(`${iso}T12:00:00+02:00`)
const plus = (iso: string, days: number) => fromDayNumber(toDayNumber(iso) + days)

/** The deadline cron as it runs on SAST calendar day `day`. */
async function runOn(day: string): Promise<{ status: number; body: Record<string, unknown> }> {
  vi.useFakeTimers({ toFake: ["Date"], now: noon(day) })
  try {
    const response = await deadlineCron(new NextRequest("http://localhost/api/cron/asset-finance-recovery-deadlines", { headers: { "x-cron-secret": CRON_SECRET } }))
    return { status: response.status, body: (await response.json()) as Record<string, unknown> }
  } finally {
    vi.useRealTimers()
  }
}

suite.sequential("NCA final-notice reminder (real Postgres, injected clock)", () => {
  beforeAll(async () => {
    process.env.CRON_SECRET = CRON_SECRET
    fx = await createRecoveryFixture(database(), t)
  }, 120_000)

  afterAll(async () => {
    vi.useRealTimers()
    await cleanupRecoveryFixture(database(), recoveryFixtureTenantId(t)).catch(() => undefined)
    await db?.$disconnect()
  }, 60_000)

  it("bells the creator once at 5 business days after the freeze, none before, and changes no recovery or loan", async () => {
    const s131 = await ladderRecovery(database(), fx, true, "PROCEEDS_APPLIED")
    const s127 = await ladderRecovery(database(), fx, true, "PROCEEDS_APPLIED", {}, true)
    const nonNca = await ladderRecovery(database(), fx, false, "PROCEEDS_APPLIED")
    const noticed = await ladderRecovery(database(), fx, true, "FINAL_NOTICE_ISSUED")
    const due = [s131, s127]
    const all = [s131, s127, nonNca, noticed]

    const recoveries = () => database().recovery.findMany({ where: { id: { in: all.map((r) => r.id) } }, orderBy: { id: "asc" } })
    const loans = () => database().loan.findMany({ where: { id: { in: all.map((r) => r.loan.loanId) } }, orderBy: { id: "asc" } })
    const bells = (id: string) => database().notification.findMany({ where: { tenantId: fx.tenantId, type: "RECOVERY_FINAL_NOTICE_DUE", entityId: id } })
    const markers = (id: string) => database().auditLog.count({ where: { tenantId: fx.tenantId, action: "ASSET_RECOVERY_FINAL_NOTICE_REMINDED", entityId: id } })
    const recoveriesBefore = await recoveries()
    const loansBefore = await loans()

    const frozen = isoOfDbDate(recoveriesBefore.find((r) => r.id === s131.id)!.chargesFrozenFrom!)
    for (const r of recoveriesBefore.filter((row) => due.some((d) => d.id === row.id))) expect(isoOfDbDate(r.chargesFrozenFrom!)).toBe(frozen)
    const fifth = addSouthAfricanBusinessDays(frozen, 5)

    // Four business days on, and the calendar day before the fifth: nothing yet.
    for (const day of [addSouthAfricanBusinessDays(frozen, 4), plus(fifth, -1)]) {
      expect(await runOn(day), day).toMatchObject({ status: 200, body: { ok: true, failed: 0 } })
      for (const r of all) expect(await bells(r.id), `${day} ${r.id}`).toHaveLength(0)
    }

    const first = await runOn(fifth)
    expect(first).toMatchObject({ status: 200, body: { ok: true, failed: 0 } })
    expect(first.body.reminded).toBeGreaterThanOrEqual(2)
    for (const r of due) {
      const items = await bells(r.id)
      expect(items).toHaveLength(1)
      expect(items[0]).toMatchObject({ userId: fx.officer, entityType: "Recovery", readAt: null })
      // No borrower name (the fixture's are TEST / Debtor…) and no ID or registration number.
      expect(`${items[0].title} ${items[0].body}`).not.toMatch(/TEST|Debtor/)
      expect(`${items[0].title} ${items[0].body}`).not.toContain(r.loan.borrowerKey)
      expect(`${items[0].title} ${items[0].body}`).not.toMatch(/\d{13}/)
      expect(await markers(r.id)).toBe(1)
    }
    for (const r of [nonNca, noticed]) {
      expect(await bells(r.id)).toHaveLength(0)
      expect(await markers(r.id)).toBe(0)
    }

    // The next day, and again the same day: still one each.
    for (const day of [plus(fifth, 1), plus(fifth, 1)]) {
      const again = await runOn(day)
      expect(again).toMatchObject({ status: 200, body: { ok: true, failed: 0 } })
      expect(again.body.alreadyReminded).toBeGreaterThanOrEqual(2)
      for (const r of due) {
        expect(await bells(r.id)).toHaveLength(1)
        expect(await markers(r.id)).toBe(1)
      }
    }

    // No state change: every recovery and loan row reads exactly as before the runs.
    expect(await recoveries()).toEqual(recoveriesBefore)
    expect(await loans()).toEqual(loansBefore)
  }, 240_000)
})
