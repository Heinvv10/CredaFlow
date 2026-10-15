import { NextRequest } from "next/server"
import { describe, expect, it, vi } from "vitest"

const audits = vi.hoisted(() => [] as Array<{ action: string; newValue: { code: string } }>)

vi.mock("@/lib/auth-guards", () => ({ requireApiRole: vi.fn(async () => ({ user: { id: "u-1", email: "a@x.invalid", totpVerified: true } })) }))
vi.mock("@/lib/tenant", () => ({ withTenantContext: (_req: unknown, run: (t: { id: string }) => unknown) => run({ id: "t-1" }) }))
vi.mock("@/lib/security/staff-totp-policy", () => ({ isStaffTotpRequired: vi.fn(async () => false) }))
vi.mock("@/lib/audit", () => ({ AuditAction: { ACCOUNTING_CLOSE_REFUSED: "CLOSE_REFUSED" }, logAudit: vi.fn(async (entry: (typeof audits)[number]) => { audits.push(entry) }) }))
vi.mock("@/lib/prisma", () => ({ prisma: {} }))
vi.mock("@/lib/accounting/generate", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/accounting/generate")>()
  return {
    ...real,
    closePeriod: vi.fn(async () => { throw new real.AccountingPeriodError("CONCURRENT_CHANGE", "The accounting settings changed again while the month was closing: try again") }),
  }
})

import { POST } from "./route"

describe("closing a month", () => {
  it("answers 409, not 422 or 500, when the settings kept changing while it closed, and audits the refusal", async () => {
    const res = await POST(new NextRequest("http://x.invalid/api/accounting/periods", { method: "POST", body: JSON.stringify({ period: "2026-08" }), headers: { "content-type": "application/json" } }))
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: "CONCURRENT_CHANGE" })
    expect(audits[0]).toMatchObject({ action: "CLOSE_REFUSED", newValue: { code: "CONCURRENT_CHANGE" } })
  })
})
