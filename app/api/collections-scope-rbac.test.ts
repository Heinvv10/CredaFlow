/**
 * Fair Score audit (2026-10-16): INSURANCE_OFFICER ranked above the
 * collections roles, so the COLLECTIONS_OFFICER minimum handed it payment
 * arrangements, Section 129 issue, collections stage, attorney referral and
 * reminders. Each is now act_on_collections
 * (lib/registry/permissions/050-insurance-officer-scope.ts).
 *
 * The REAL lib/auth-guards runs; only the session, the tenant frame and the
 * database are stubbed. A refused request must never reach the database.
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
// These routes are all in the loan book, which the guards' second layer
// (lib/security/loan-book-guard.ts) already refuses to INSURANCE_OFFICER. It
// is turned off here so the act_on_collections permission is proved on its
// own; the scope has its own tests (lib/__tests__/auth-guards.loan-book.test.ts).
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

import { POST as arrangement } from "@/app/api/loans/[id]/payment-arrangement/route"
import { POST as section129 } from "@/app/api/loans/section129/route"
import { POST as section129Bulk } from "@/app/api/loans/section129/bulk/route"
import { PATCH as collectionsStage } from "@/app/api/loans/[id]/collections-stage/route"
import { POST as attorneyReferral } from "@/app/api/loans/[id]/attorney-referral/route"
import { POST as reminder } from "@/app/api/collections/[loanId]/reminder/route"

const loan = { params: Promise.resolve({ id: "loan-1" }) }
const json = (url: string, method: string, body: unknown) =>
  new NextRequest(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

const ENDPOINTS: Array<[string, () => Promise<Response>]> = [
  ["POST /api/loans/[id]/payment-arrangement", () => arrangement(json("http://localhost/api/loans/loan-1/payment-arrangement", "POST", {}), loan)],
  ["POST /api/loans/section129", () => section129(json("http://localhost/api/loans/section129", "POST", { loanId: "loan-1" }))],
  ["POST /api/loans/section129/bulk", () => section129Bulk(json("http://localhost/api/loans/section129/bulk", "POST", { loanIds: ["loan-1"] }))],
  ["PATCH /api/loans/[id]/collections-stage", () => collectionsStage(json("http://localhost/api/loans/loan-1/collections-stage", "PATCH", { stage: "EARLY" }), loan)],
  ["POST /api/loans/[id]/attorney-referral", () => attorneyReferral(json("http://localhost/api/loans/loan-1/attorney-referral", "POST", {}), loan)],
  ["POST /api/collections/[loanId]/reminder", () => reminder(json("http://localhost/api/collections/loan-1/reminder", "POST", {}), { params: Promise.resolve({ loanId: "loan-1" }) })],
]

beforeEach(() => {
  touched.prisma = false
})

describe.each(ENDPOINTS)("%s", (_name, call) => {
  it("refuses INSURANCE_OFFICER with 403 before touching the database", async () => {
    session.role = "INSURANCE_OFFICER"
    const res = await call()
    expect(res.status).toBe(403)
    expect(touched.prisma).toBe(false)
  })

  it("still lets COLLECTIONS_OFFICER past the permission check", async () => {
    session.role = "COLLECTIONS_OFFICER"
    const outcome = await call().then((res) => res.status, (err: Error) => err.message)
    expect(outcome).not.toBe(403)
  })
})
