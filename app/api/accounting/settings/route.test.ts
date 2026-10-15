import { NextRequest } from "next/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  batches: 0,
  calls: [] as string[],
  mappingReadOn: null as string | null,
}))

vi.mock("@/lib/auth-guards", () => ({ requireApiRole: vi.fn(async () => ({ user: { id: "u-1", email: "a@x.invalid", totpVerified: true } })) }))
vi.mock("@/lib/tenant", () => ({ withTenantContext: (_req: unknown, run: (t: { id: string }) => unknown) => run({ id: "t-1" }) }))
vi.mock("@/lib/audit", () => ({ AuditAction: { ACCOUNTING_SETTINGS_UPDATED: "S", ACCOUNTING_MAPPING_CONFIRMED: "M" }, logAuditStrict: vi.fn(async () => undefined) }))
vi.mock("@/lib/security/staff-totp-policy", () => ({ isStaffTotpRequired: vi.fn(async () => false) }))
vi.mock("@/lib/prisma", () => {
  const tx = (name: string) => ({
    $executeRaw: vi.fn(async () => { state.calls.push(`${name}:lock`) }),
    accountingExportBatch: { count: vi.fn(async () => { state.calls.push(`${name}:count`); return state.batches }) },
    accountingSettings: { findUnique: vi.fn(async () => null), upsert: vi.fn(async () => { state.calls.push(`${name}:upsert`) }) },
    accountingAccountMapping: { findMany: vi.fn(async () => { state.mappingReadOn = name; state.calls.push(`${name}:mapping`); return [] }) },
  })
  const root = {
    ...tx("root"),
    $transaction: vi.fn(async (run: (t: unknown) => unknown) => run(tx("tx"))),
  }
  return { prisma: root }
})

import { POST, PUT } from "./route"

const put = (body: unknown) => PUT(new NextRequest("http://x.invalid/api/accounting/settings", { method: "PUT", body: JSON.stringify(body), headers: { "content-type": "application/json" } }))
const post = (body: unknown) => POST(new NextRequest("http://x.invalid/api/accounting/settings", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }))

describe("accounting settings route", () => {
  beforeEach(() => { state.batches = 0; state.calls = []; state.mappingReadOn = null })

  it.each([[null], [[]], ["x"], [7], [true]])("a body that is not a JSON object is a 400: %j", async (body) => {
    expect((await put(body)).status).toBe(400)
    expect(state.calls).toEqual([])
  })

  it("an empty object is accepted and changes nothing but the actor", async () => {
    expect((await put({})).status).toBe(200)
  })

  it("counts the closed months inside the transaction, after taking the close lock", async () => {
    state.batches = 1
    const res = await put({ goLiveMonth: "2026-09" })
    expect(res.status).toBe(409)
    expect(state.calls.slice(0, 2)).toEqual(["tx:lock", "tx:count"])
    expect(state.calls).not.toContain("tx:upsert")
  })

  it("writes the go-live month when no month has closed", async () => {
    expect((await put({ goLiveMonth: "2026-09" })).status).toBe(200)
    expect(state.calls.filter((c) => c.startsWith("tx:"))).toEqual(["tx:lock", "tx:count", "tx:upsert"])
  })

  it("confirms the mapping it reads inside the transaction, under the lock", async () => {
    expect((await post({ action: "confirm_mapping" })).status).toBe(200)
    expect(state.mappingReadOn).toBe("tx")
    expect(state.calls.slice(0, 2)).toEqual(["tx:lock", "tx:mapping"])
  })
})
