/**
 * Fair Score audit (2026-10-16): an INSURANCE_OFFICER recorded a loan payment
 * (POST /api/payments 200) and was shown Amend loan amount, Cancel application
 * and Update affordability. Each loan-money write is refused to that role by
 * an explicit permission (lib/registry/permissions/040-loan-money.ts).
 *
 * The REAL lib/auth-guards runs here; only the session (lib/auth), the tenant
 * frame and the database are stubbed. A refused request must never reach the
 * database, so any Prisma access throws.
 */
import { NextRequest } from "next/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

const session = vi.hoisted(() => ({ role: "INSURANCE_OFFICER" }))
vi.mock("@/lib/auth", () => ({
  auth: vi.fn(async () => ({
    user: { id: "staff-1", email: "staff@test.invalid", role: session.role, tenantId: "tenant-1", totpVerified: true },
  })),
}))
vi.mock("@/lib/tenant", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant")>()),
  withTenantContext: async (_req: unknown, handler: (tenant: { id: string; name: string }) => Promise<unknown>) =>
    handler({ id: "tenant-1", name: "RBAC Test Lender" }),
}))
const touched = vi.hoisted(() => ({ prisma: false }))
vi.mock("@/lib/prisma", () => ({
  prisma: new Proxy({}, {
    get() {
      touched.prisma = true
      throw new Error("a refused request reached the database")
    },
  }),
}))

import { POST as capturePayment } from "@/app/api/payments/route"
import { DELETE as cancelApplication, PATCH as editApplication } from "@/app/api/applications/[id]/route"
import { POST as decide } from "@/app/api/applications/[id]/decide/route"
import { PATCH as editAffordability } from "@/app/api/applications/[id]/affordability/route"

const params = { params: Promise.resolve({ id: "app-1" }) }
const json = (url: string, method: string, body: unknown) =>
  new NextRequest(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
function returnToDraft() {
  const form = new FormData()
  form.set("action", "return_to_draft")
  form.set("reason", "Client asked for a smaller amount")
  return new NextRequest("http://localhost/api/applications/app-1/decide", { method: "POST", body: form })
}

const ENDPOINTS: Array<[string, string, () => Promise<Response>]> = [
  ["POST /api/payments", "COLLECTIONS_AGENT", () => capturePayment(json("http://localhost/api/payments", "POST", { loanId: "loan-1", amount: 100, method: "EFT" }))],
  ["POST /api/applications/[id]/decide return_to_draft (Amend loan amount)", "LOAN_ADMIN", () => decide(returnToDraft(), params)],
  ["PATCH /api/applications/[id]", "CREDIT_OFFICER", () => editApplication(json("http://localhost/api/applications/app-1", "PATCH", { status: "SUBMITTED" }), params)],
  ["DELETE /api/applications/[id] (Cancel application)", "CREDIT_OFFICER", () => cancelApplication(new NextRequest("http://localhost/api/applications/app-1", { method: "DELETE" }), params)],
  ["PATCH /api/applications/[id]/affordability (Update affordability)", "CREDIT_OFFICER", () => editAffordability(json("http://localhost/api/applications/app-1/affordability", "PATCH", { debts: [] }), params)],
]

beforeEach(() => {
  touched.prisma = false
})

describe.each(ENDPOINTS)("%s", (_name, allowedRole, call) => {
  it("refuses INSURANCE_OFFICER with 403 before touching the database", async () => {
    session.role = "INSURANCE_OFFICER"
    const res = await call()
    expect(res.status).toBe(403)
    expect(touched.prisma).toBe(false)
  })

  it(`still lets ${allowedRole} past the permission check`, async () => {
    session.role = allowedRole
    // Past the check the handler goes on to the (stubbed) database, which some
    // routes surface as a 500 and others as a thrown error: either is not a 403.
    const outcome = await call().then((res) => res.status, (err: Error) => err.message)
    expect(outcome).not.toBe(403)
  })
})
