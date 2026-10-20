import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * The reschedule of a dunning message that has to wait for the 07:00 window is a conditional write: a row
 * that changed since the sweep read it (sent, suppressed, retried by another sweep) must win. The fake
 * table below evaluates the `where` it is given, as Postgres would, so dropping a guard from the write
 * makes the concurrent change lose.
 */
type Row = { id: string; tenantId: string; status: string; retryCount: number; nextRetryAt: Date | null; [k: string]: unknown }

const state = vi.hoisted(() => ({ live: null as unknown, concurrent: null as null | (() => void) }))
const live = () => state.live as Row

vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }))
vi.mock("@/lib/prisma", () => {
  const matches = (row: Row, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => (v !== null && typeof v === "object" ? true : row[k] === v))
  const tx = {
    $queryRaw: async () => [{ acquired: true }],
    notificationLog: { updateMany: async () => ({ count: 0 }) },
    message: {
      findMany: async () => {
        const snapshot = { ...live() }
        state.concurrent?.() // another sweep, or a send, gets to the row after this one has read it
        return [snapshot]
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Partial<Row> }) => {
        if ("createdAt" in where) return { count: 0 } // the bulk expiry
        if (!matches(live(), where)) return { count: 0 }
        Object.assign(live(), data)
        return { count: 1 }
      },
    },
  }
  return { prisma: { $transaction: async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx) } }
})

import { processRetryBatch } from "./retry"

const DUE = new Date("2000-01-01T00:00:00Z")
const NOW = new Date("2026-11-03T03:00:00Z") // 05:00 SAST: outside the dunning window

beforeEach(() => {
  state.concurrent = null
  state.live = {
    id: "m1", tenantId: "t1", status: "RETRYING", retryCount: 1, nextRetryAt: DUE, channel: "SMS", dunning: true,
    createdAt: new Date("2026-11-03T00:30:00Z"), idempotencyKey: "manual-reminder:loan_1:op:SMS", templateId: "tpl",
  } satisfies Row
})

describe("rescheduling a dunning message that has to wait", () => {
  it("moves a waiting row to the next 07:00 SAST", async () => {
    await processRetryBatch({ limit: 10, now: NOW })
    expect(live().nextRetryAt).toEqual(new Date("2026-11-03T05:00:00Z"))
  })

  it("does not touch a row another sweep has retried since it was read (retryCount moved)", async () => {
    state.concurrent = () => { live().retryCount = 2; live().nextRetryAt = new Date("2026-11-03T04:00:00Z") }
    await processRetryBatch({ limit: 10, now: NOW })
    expect(live().nextRetryAt).toEqual(new Date("2026-11-03T04:00:00Z"))
  })

  it("does not touch a row that has left RETRYING since it was read", async () => {
    state.concurrent = () => { live().status = "SENT"; live().nextRetryAt = null }
    await processRetryBatch({ limit: 10, now: NOW })
    expect(live()).toMatchObject({ status: "SENT", nextRetryAt: null })
  })

  it("does not touch another tenant's row of the same id", async () => {
    state.concurrent = () => { live().tenantId = "t2" }
    await processRetryBatch({ limit: 10, now: NOW })
    expect(live().nextRetryAt).toEqual(DUE)
  })
})
