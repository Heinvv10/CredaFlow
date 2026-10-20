/**
 * The REAL lib/auth-guards runs here (route.test.ts stubs it): a staff user who
 * still has to enrol TOTP is refused before the database is touched, on both the
 * record and the clear action. Staff write paths must not skip 2FA
 * (lib/auth-guards.ts, lib/proxy/totp-enrolment.ts).
 */
import { NextRequest } from "next/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

const session = vi.hoisted(() => ({ enrolmentRequired: true }))
vi.mock("@/lib/auth", () => ({
  auth: vi.fn(async () => ({
    user: {
      id: "staff-1", email: "staff@test.invalid", role: "COLLECTIONS_OFFICER", tenantId: "tenant-1",
      totpEnrolmentRequired: session.enrolmentRequired,
    },
  })),
}))
vi.mock("@/lib/tenant", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant")>()),
  withTenantContext: async (_req: unknown, handler: (tenant: { id: string; name: string }) => Promise<unknown>) =>
    handler({ id: "tenant-1", name: "2FA Test Lender" }),
}))
vi.mock("@/lib/security/loan-book-guard", () => ({ refusesLoanBook: async () => false }))
const touched = vi.hoisted(() => ({ prisma: false }))
vi.mock("@/lib/prisma", () => ({
  prisma: new Proxy({}, {
    get() {
      touched.prisma = true
      throw new Error("a refused request reached the database")
    },
  }),
}))

import { DELETE, POST } from "./route"

const ctx = { params: Promise.resolve({ id: "loan-1" }) }
const json = (method: string, body: unknown) =>
  new NextRequest("http://localhost/api/loans/loan-1/debt-review", {
    method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  })

beforeEach(() => {
  touched.prisma = false
  session.enrolmentRequired = true
})

describe.each([
  ["POST", () => POST(json("POST", { noticeDate: "2026-10-01" }), ctx)],
  ["DELETE", () => DELETE(json("DELETE", { reason: "withdrawn" }), ctx)],
] as const)("%s debt-review with staff TOTP enrolment outstanding", (_m, call) => {
  it("is refused with 403 before the database is touched", async () => {
    const res = await call()
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ code: expect.stringMatching(/totp|enrol/i) })
    expect(touched.prisma).toBe(false)
  })

  it("control: an enrolled user gets past the gate (and only then reaches the database)", async () => {
    session.enrolmentRequired = false
    await call()
    expect(touched.prisma).toBe(true)
  })
})
