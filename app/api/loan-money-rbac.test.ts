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
// These routes are in the loan book, which the guards' second layer
// (lib/security/loan-book-guard.ts, #145) also refuses to INSURANCE_OFFICER.
// It is turned off here so each permission is proved on its own.
vi.mock("@/lib/security/loan-book-guard", () => ({ refusesLoanBook: async () => false }))
// Any Prisma access throws unless a test installed that model: a refused
// request must never reach the database.
const db = vi.hoisted(() => ({ models: {} as Record<string, unknown>, touched: [] as string[] }))
vi.mock("@/lib/prisma", () => ({
  prisma: new Proxy({}, {
    get(_target, model: string) {
      db.touched.push(model)
      if (model in db.models) return db.models[model]
      throw new Error(`a request reached the database (${model})`)
    },
  }),
}))
const receipt = vi.hoisted(() => vi.fn())
vi.mock("@/lib/loan/apply-payment", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/loan/apply-payment")>()),
  applyManualReceipt: receipt,
}))
vi.mock("@/lib/notifications", () => ({ triggerNotification: vi.fn(async () => undefined) }))

import { POST as capturePayment } from "@/app/api/payments/route"
import { DELETE as cancelApplication, PATCH as editApplication } from "@/app/api/applications/[id]/route"
import { POST as decide } from "@/app/api/applications/[id]/decide/route"
import { PATCH as editAffordability } from "@/app/api/applications/[id]/affordability/route"
import { PAYMENT_IDEMPOTENCY_HEADER } from "@/lib/payments/idempotency"

const params = { params: Promise.resolve({ id: "app-1" }) }
const json = (url: string, method: string, body: unknown, headers: Record<string, string> = {}) =>
  new NextRequest(url, { method, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) })
function returnToDraft() {
  const form = new FormData()
  form.set("action", "return_to_draft")
  form.set("reason", "Client asked for a smaller amount")
  return new NextRequest("http://localhost/api/applications/app-1/decide", { method: "POST", body: form })
}

/**
 * - "permission": the permission is the ONLY thing refusing INSURANCE_OFFICER
 *   (the route's ladder minimum, COLLECTIONS_AGENT, ranks below it).
 * - "defence in depth": the route's ladder minimum (CREDIT_OFFICER /
 *   LOAN_ADMIN) already refused INSURANCE_OFFICER before this change; the
 *   explicit permission is a second, deliberate layer and the row passes with
 *   or without it.
 *
 * Past the guards: payment capture and cancel run to their real success
 * status. The other three are long handlers whose success paths are covered
 * by their own route tests with mocked guards; here they are shown to get
 * past every guard by reaching their first database read of the application.
 */
type Row = {
  name: string
  layer: "permission" | "defence in depth"
  allowedRole: string
  call: () => Promise<Response>
  past: () => Promise<void>
}

const ROWS: Row[] = [
  {
    name: "POST /api/payments",
    layer: "permission",
    allowedRole: "COLLECTIONS_AGENT",
    call: () => capturePayment(json("http://localhost/api/payments", "POST", { loanId: "loan-1", amount: 100, paymentMethod: "EFT" }, { [PAYMENT_IDEMPOTENCY_HEADER]: "rbac-test-key-0001" })),
    past: async () => {
      receipt.mockResolvedValue({ idempotentReplay: false, payment: { id: "pay-1", amount: 100, allocationStatus: "ALLOCATED" }, excessPayment: null })
      const res = await capturePayment(json("http://localhost/api/payments", "POST", { loanId: "loan-1", amount: 100, paymentMethod: "EFT" }, { [PAYMENT_IDEMPOTENCY_HEADER]: "rbac-test-key-0001" }))
      expect(res.status).toBe(200)
      expect(receipt).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ loanId: "loan-1", amount: 100, capturedById: "staff-1" }))
    },
  },
  {
    name: "DELETE /api/applications/[id] (Cancel application)",
    layer: "defence in depth",
    allowedRole: "CREDIT_OFFICER",
    call: () => cancelApplication(new NextRequest("http://localhost/api/applications/app-1", { method: "DELETE" }), params),
    past: async () => {
      const tx = { loanApplication: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) }, auditLog: { create: vi.fn().mockResolvedValue({}) } }
      db.models.loanApplication = { findUnique: vi.fn().mockResolvedValue({ id: "app-1", reference: "APP-1", status: "SUBMITTED", loan: null }) }
      db.models.$transaction = (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)
      const res = await cancelApplication(new NextRequest("http://localhost/api/applications/app-1", { method: "DELETE" }), params)
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ ok: true, status: "CANCELLED" })
    },
  },
  {
    name: "POST /api/applications/[id]/decide return_to_draft (Amend loan amount)",
    layer: "defence in depth",
    allowedRole: "LOAN_ADMIN",
    call: () => decide(returnToDraft(), params),
    past: async () => {
      await decide(returnToDraft(), params).catch(() => undefined)
      expect(db.touched).toContain("loanApplication")
    },
  },
  {
    name: "PATCH /api/applications/[id] (submit a draft)",
    layer: "defence in depth",
    allowedRole: "CREDIT_OFFICER",
    call: () => editApplication(json("http://localhost/api/applications/app-1", "PATCH", { status: "SUBMITTED" }), params),
    past: async () => {
      await editApplication(json("http://localhost/api/applications/app-1", "PATCH", { status: "SUBMITTED" }), params).catch(() => undefined)
      expect(db.touched.length).toBeGreaterThan(0)
    },
  },
  {
    name: "PATCH /api/applications/[id]/affordability (Update affordability)",
    layer: "defence in depth",
    allowedRole: "CREDIT_OFFICER",
    call: () => editAffordability(json("http://localhost/api/applications/app-1/affordability", "PATCH", { existingDebtObligations: [] }), params),
    past: async () => {
      await editAffordability(json("http://localhost/api/applications/app-1/affordability", "PATCH", { existingDebtObligations: [] }), params).catch(() => undefined)
      expect(db.touched.length).toBeGreaterThan(0)
    },
  },
]

beforeEach(() => {
  db.models = {}
  db.touched = []
  receipt.mockReset()
})

describe.each(ROWS)("$name ($layer)", ({ allowedRole, call, past }) => {
  it("refuses INSURANCE_OFFICER with 403 before touching the database", async () => {
    session.role = "INSURANCE_OFFICER"
    const res = await call()
    expect(res.status).toBe(403)
    // The refusal's own security audit row (SECURITY_PERMISSION_DENIED) is the one write allowed.
    expect(db.touched.filter((model) => model !== "auditLog")).toEqual([])
    expect(receipt).not.toHaveBeenCalled()
  })

  it(`still lets ${allowedRole} past every guard`, async () => {
    session.role = allowedRole
    await past()
  })
})
