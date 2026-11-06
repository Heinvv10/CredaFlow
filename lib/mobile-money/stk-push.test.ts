import { beforeEach, describe, expect, it, vi } from "vitest"

const { ingest } = vi.hoisted(() => ({ ingest: vi.fn() }))
vi.mock("./c2b-ingest", () => ({ ingestMobileMoneyCallback: ingest }))
vi.mock("@/lib/loan/lock", () => ({ lockLoanForUpdate: vi.fn() }))

import { startStkPush, STK_PENDING_WINDOW_MS } from "./stk-push"
import { registerMobileMoneyProvider } from "./registry"
import type { MobileMoneyDb } from "./book"
import type { MobileMoneyProvider, StkPushRequest, StkPushResult } from "./types"

type Row = Record<string, unknown> & { id: string }
const T = "t_ke"
const PHONE = "0712 345 678"
const FULL = "254712345678"

function fakeDb() {
  const state = { rows: [] as Row[], writes: [] as unknown[] }
  const matches = (where: Record<string, unknown>) => (r: Row) => Object.entries(where).every(([k, v]) => {
    if (v && typeof v === "object" && "gt" in v) return (r[k] as Date) > (v as { gt: Date }).gt
    return r[k] === v
  })
  const db = {
    mobileMoneyTransaction: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => state.rows.find(matches(where)) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        state.writes.push(data)
        const row: Row = { id: `mm${state.rows.length + 1}`, createdAt: new Date(), checkoutRequestId: null, ...data }
        state.rows.push(row)
        return row
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        state.writes.push(data)
        const hit = state.rows.filter(matches(where))
        hit.forEach((r) => Object.assign(r, data))
        return { count: hit.length }
      },
    },
    auditLog: { create: async ({ data }: { data: unknown }) => { state.writes.push(data); return data } },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
  }
  return { db: db as unknown as MobileMoneyDb, state }
}

let seenAtRequest: Row[] = []
let answer: StkPushResult = { kind: "accepted", checkoutRequestId: "ws_CO_FAKE_1", callback: { rawBody: "{}", headers: new Headers() } }
let current: ReturnType<typeof fakeDb>
const fake: MobileMoneyProvider = {
  id: "fake-push",
  displayName: "Fake",
  signatureHeader: "x-fake",
  simulation: () => null,
  requestStkPush: vi.fn(async (_request: StkPushRequest) => {
    seenAtRequest = current.state.rows.map((r) => ({ ...r }))
    return answer
  }),
  parseCallback: vi.fn(() => ({ kind: "STK_CANCELLED" as const, checkoutRequestId: "ws_CO_FAKE_1", reason: "x" })),
}
registerMobileMoneyProvider(fake)

const push = (db: MobileMoneyDb, phone = PHONE) => startStkPush(db, {
  tenantId: T, providerId: "fake-push", loan: { id: "l1", reference: "NRB-LN-1" }, amountCents: 120_000, phone, actorEmail: "b@test.invalid",
})

beforeEach(() => {
  current = fakeDb()
  answer = { kind: "accepted", checkoutRequestId: "ws_CO_FAKE_1", callback: { rawBody: "{}", headers: new Headers() } }
  ingest.mockReset().mockResolvedValue({ outcome: "CANCELLED", transactionId: "mm1" })
  vi.mocked(fake.requestStkPush).mockClear()
  vi.mocked(fake.parseCallback).mockClear()
})

describe("startStkPush", () => {
  it("claims the push PENDING (audited) before the provider is asked, then records its checkout id", async () => {
    expect(await push(current.db)).toEqual({ ok: true, transactionId: "mm1", status: "CANCELLED" })
    expect(seenAtRequest).toEqual([expect.objectContaining({ status: "PENDING", loanId: "l1", amount: 120_000, checkoutRequestId: null })])
    expect(current.state.rows[0]).toMatchObject({ checkoutRequestId: "ws_CO_FAKE_1" })
    expect(current.state.writes).toContainEqual(expect.objectContaining({ action: "MOBILE_MONEY_STK_REQUESTED" }))
  })

  it("stores the phone's last four digits only; the provider alone sees the number", async () => {
    await push(current.db)
    expect(vi.mocked(fake.requestStkPush).mock.calls[0][0]).toMatchObject({ msisdn: FULL, tenantId: T })
    expect(current.state.rows[0].msisdnLast4).toBe("5678")
    const written = JSON.stringify(current.state.writes)
    expect(written).not.toContain(FULL)
    expect(written).not.toContain("712345678")
  })

  it("delivers the provider's callback for this lender", async () => {
    await push(current.db)
    expect(vi.mocked(fake.parseCallback).mock.calls[0][0]).toMatchObject({ tenantId: T })
    expect(ingest.mock.calls[0][1]).toMatchObject({ tenantId: T })
  })

  it("refuses a second push while one is PENDING for the loan, and allows one once that is stale", async () => {
    current.state.rows.push({ id: "open", tenantId: T, loanId: "l1", status: "PENDING", createdAt: new Date() })
    expect(await push(current.db)).toMatchObject({ ok: false, reason: "PUSH_PENDING" })
    expect(fake.requestStkPush).not.toHaveBeenCalled()
    current.state.rows[0].createdAt = new Date(Date.now() - STK_PENDING_WINDOW_MS - 1000)
    expect(await push(current.db)).toMatchObject({ ok: true })
  })

  it("records a push the provider rejected CANCELLED", async () => {
    answer = { kind: "rejected", reason: "Simulated secret missing" }
    expect(await push(current.db)).toMatchObject({ ok: false, reason: "REJECTED" })
    expect(current.state.rows[0]).toMatchObject({ status: "CANCELLED", checkoutRequestId: null })
    expect(ingest).not.toHaveBeenCalled()
  })

  it("refuses a number M-Pesa cannot prompt before claiming anything", async () => {
    expect(await push(current.db, "0821234567")).toMatchObject({ ok: false, reason: "INVALID_PHONE" })
    expect(current.state.rows).toEqual([])
  })
})
