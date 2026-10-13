import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

// The review-round routes' HTTP mapping: book (every refusal → 409 or 422,
// audited), cancel, the payout refusals that are now audited, the prepare
// body, and the surety/signatory deactivation refused on an open deal. The
// gates and the real permission map run; the session, the flag row and the
// lib operations are stubbed. Real-database proof:
// lib/asset-finance/booking-terms.integration.test.ts and
// lib/asset-finance/review-gates.integration.test.ts.
const m = vi.hoisted(() => ({
  flag: { on: true },
  requireApiRole: vi.fn(),
  auditRefusal: vi.fn(),
  bookDeal: vi.fn(),
  cancelDeal: vi.fn(),
  createPayout: vi.fn(),
  approvePayout: vi.fn(),
  prepare: vi.fn(),
  tx: {
    entityRelationship: { findFirst: vi.fn(), updateMany: vi.fn() },
    assetFinanceDeal: { findFirst: vi.fn() },
  },
}))

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantConfig: { findUnique: async () => ({ featureCrm: false, featureIms: false, featureAssetFinance: m.flag.on }) },
    $transaction: (fn: (tx: unknown) => unknown) => fn(m.tx),
  },
}))
vi.mock("@/lib/tenant", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant")>()),
  withTenantContext: (_req: unknown, fn: (t: { id: string; name: string }) => unknown) => fn({ id: "tenant-1", name: "T" }),
}))
vi.mock("@/lib/auth-guards", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-guards")>()),
  requireApiRole: () => m.requireApiRole(),
}))
vi.mock("@/lib/audit-refusals", () => ({ auditRefusal: m.auditRefusal }))
vi.mock("@/lib/audit", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/audit")>()), logAuditStrict: vi.fn() }))
vi.mock("@/lib/asset-finance/booking", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/asset-finance/booking")>()),
  bookDeal: m.bookDeal,
}))
vi.mock("@/lib/asset-finance/deal-cancel", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/asset-finance/deal-cancel")>()),
  cancelDeal: m.cancelDeal,
}))
vi.mock("@/lib/asset-finance/payout", () => ({ createPayout: m.createPayout, approvePayout: m.approvePayout }))
vi.mock("@/lib/asset-finance/signing-prepare", () => ({ prepareDealDocuments: m.prepare }))
vi.mock("@/lib/asset-finance/payout-view", () => ({ loadPayoutPanel: async () => ({ panel: true }) }))
vi.mock("@/lib/asset-finance/signing-view", () => ({ loadStaffSigningPanel: async () => ({ signers: [] }) }))
vi.mock("@/lib/asset-finance/deal-detail", () => ({ loadDealDetail: async (_t: string, id: string) => ({ id }) }))
vi.mock("@/lib/asset-finance/entity-detail", () => ({ loadEntityPeople: async () => [] }))

import { POST as book } from "../book/route"
import { POST as cancel } from "./route"
import { POST as createPayout } from "../payout/route"
import { POST as approvePayout } from "../payout/approve/route"
import { POST as prepare } from "../signing/route"
import { DELETE as deactivate } from "../../../entities/[id]/people/[relationshipId]/route"

const signIn = (role: string, id = "user-1") =>
  m.requireApiRole.mockResolvedValue({ user: { id, email: `${id}@lender.test`, role, tenantId: "tenant-1" } })
const req = (body?: unknown, raw?: string) => new NextRequest("http://localhost/api/asset-finance/deals/deal-1/x", {
  method: "POST", headers: { "content-type": "application/json" }, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
})
const deal = { params: Promise.resolve({ id: "deal-1" }) }
const refusal = (reason: string, status: number, action: string) => expect.objectContaining({ reason, status, action, entityId: "deal-1" })

beforeEach(() => {
  vi.clearAllMocks()
  m.flag.on = true
  signIn("LOAN_ADMIN")
})

describe("POST …/book", () => {
  it.each([
    ["no_payout", 409], ["payout_not_approved", 409], ["account_not_approved", 409], ["application_not_ready", 409],
    ["asset_changed", 409], ["terms_changed", 409], ["not_prepared", 409], ["already_booked", 409], ["not_contracted", 409],
    ["first_due_passed", 422], ["rate_unavailable", 422], ["entity_address_missing", 422],
  ])("refusal %s answers %i and is audited as ASSET_PAYOUT_REFUSED", async (reason, status) => {
    m.bookDeal.mockResolvedValue({ kind: "refused", reason, error: `refused: ${reason}` })
    const res = await book(req({}), deal)
    expect(res.status).toBe(status)
    expect((await res.json()).error).toBe(`refused: ${reason}`)
    expect(m.auditRefusal).toHaveBeenCalledWith(refusal(reason, status, "ASSET_PAYOUT_REFUSED"))
  })
})

describe("POST …/cancel", () => {
  it("needs decide_asset_finance (403, audited) and a reason of at least 10 characters (400)", async () => {
    signIn("CREDIT_OFFICER")
    expect((await cancel(req({ reason: "Borrower withdrew" }), deal)).status).toBe(403)
    expect(m.auditRefusal).toHaveBeenCalledWith(expect.objectContaining({ action: "ASSET_DEAL_CANCEL_REFUSED", reason: "insufficient_role" }))
    signIn("LOAN_ADMIN")
    expect((await cancel(req({ reason: " too short " }), deal)).status).toBe(400)
    expect(m.cancelDeal).not.toHaveBeenCalled()
  })

  it("cancels with the trimmed reason; a deal that cannot be cancelled is 409 and audited", async () => {
    m.cancelDeal.mockResolvedValue({ kind: "cancelled", payoutCancelled: true, applicationStatus: "CANCELLED" })
    expect((await cancel(req({ reason: "  Borrower withdrew the order  " }), deal)).status).toBe(200)
    expect(m.cancelDeal).toHaveBeenCalledWith(expect.objectContaining({ userId: "user-1" }), "deal-1", "Borrower withdrew the order")
    m.cancelDeal.mockResolvedValue({ kind: "not_cancellable", status: "BOOKED" })
    const res = await cancel(req({ reason: "Borrower withdrew the order" }), deal)
    expect(res.status).toBe(409)
    expect(m.auditRefusal).toHaveBeenCalledWith(refusal("not_cancellable", 409, "ASSET_DEAL_CANCEL_REFUSED"))
  })

  it("a database guard refusal mid-cancel is 409, audited as a race", async () => {
    m.cancelDeal.mockRejectedValue(Object.assign(new Error("A deal is cancelled only once its payout is cancelled"), { code: "23514" }))
    expect((await cancel(req({ reason: "Borrower withdrew the order" }), deal)).status).toBe(409)
    expect(m.auditRefusal).toHaveBeenCalledWith(expect.objectContaining({ reason: "race", status: 409 }))
  })
})

describe("payout refusals are audited", () => {
  it("create: an existing payout is 409 and audited", async () => {
    m.createPayout.mockResolvedValue({ kind: "exists" })
    expect((await createPayout(req({}), deal)).status).toBe(409)
    expect(m.auditRefusal).toHaveBeenCalledWith(refusal("exists", 409, "ASSET_PAYOUT_REFUSED"))
  })

  it("create: not contracted is 409 and audited", async () => {
    m.createPayout.mockResolvedValue({ kind: "not_contracted", status: "APPROVED" })
    expect((await createPayout(req({}), deal)).status).toBe(409)
    expect(m.auditRefusal).toHaveBeenCalledWith(refusal("not_contracted", 409, "ASSET_PAYOUT_REFUSED"))
  })

  it("approve: a payout not awaiting approval is 409 and audited", async () => {
    m.approvePayout.mockResolvedValue({ kind: "not_pending", status: "APPROVED" })
    expect((await approvePayout(req({}), deal)).status).toBe(409)
    expect(m.auditRefusal).toHaveBeenCalledWith(refusal("not_pending", 409, "ASSET_PAYOUT_REFUSED"))
  })
})

describe("POST …/signing (prepare)", () => {
  it("passes the chosen start date; an empty body means today; a malformed one is 400", async () => {
    signIn("CREDIT_OFFICER")
    m.prepare.mockResolvedValue({ kind: "prepared", signers: 2 })
    expect((await prepare(req({ plannedStartDate: "2026-11-01" }), deal)).status).toBe(200)
    expect(m.prepare).toHaveBeenLastCalledWith(expect.anything(), "deal-1", "2026-11-01")
    expect((await prepare(req(undefined, ""), deal)).status).toBe(200)
    expect(m.prepare.mock.calls.at(-1)?.[2]).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect((await prepare(req({ plannedStartDate: "1 Nov" }), deal)).status).toBe(400)
    expect((await prepare(req(undefined, "{nope"), deal)).status).toBe(400)
  })

  it("a start not before the first instalment is 422 and audited", async () => {
    signIn("CREDIT_OFFICER")
    m.prepare.mockResolvedValue({ kind: "invalid_start", error: "The planned start date must be before the first instalment (2026-11-13)" })
    expect((await prepare(req({ plannedStartDate: "2026-11-13" }), deal)).status).toBe(422)
    expect(m.auditRefusal).toHaveBeenCalledWith(expect.objectContaining({ reason: "invalid_start", status: 422 }))
  })
})

describe("DELETE …/people/[relationshipId] on an open deal", () => {
  const params = { params: Promise.resolve({ id: "entity-1", relationshipId: "rel-1" }) }
  const del = () => deactivate(new NextRequest("http://localhost/x", { method: "DELETE" }), params)

  it("refuses to deactivate a surety while the entity has an APPROVED or CONTRACTED deal (409, audited, nothing written)", async () => {
    signIn("CREDIT_OFFICER")
    m.tx.entityRelationship.findFirst.mockResolvedValue({ id: "rel-1", clientId: "c-1", role: "SURETY", active: true })
    m.tx.assetFinanceDeal.findFirst.mockResolvedValue({ id: "deal-1" })
    const res = await del()
    expect(res.status).toBe(409)
    expect(m.tx.entityRelationship.updateMany).not.toHaveBeenCalled()
    expect(m.tx.assetFinanceDeal.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: "tenant-1", entityId: "entity-1", status: { in: ["APPROVED", "CONTRACTED"] } },
    }))
    expect(m.auditRefusal).toHaveBeenCalledWith(expect.objectContaining({ action: "ENTITY_RELATIONSHIP_CHANGE_REFUSED", reason: "deal_open" }))
  })

  it("still deactivates a role that signs nothing (a MEMBER), and any role with no open deal", async () => {
    signIn("CREDIT_OFFICER")
    m.tx.entityRelationship.updateMany.mockResolvedValue({ count: 1 })
    m.tx.entityRelationship.findFirst.mockResolvedValue({ id: "rel-1", clientId: "c-1", role: "MEMBER", active: true })
    m.tx.assetFinanceDeal.findFirst.mockResolvedValue({ id: "deal-1" })
    expect((await del()).status).toBe(200)
    m.tx.entityRelationship.findFirst.mockResolvedValue({ id: "rel-1", clientId: "c-1", role: "SURETY", active: true })
    m.tx.assetFinanceDeal.findFirst.mockResolvedValue(null)
    expect((await del()).status).toBe(200)
    expect(m.tx.entityRelationship.updateMany).toHaveBeenCalledTimes(2)
  })
})
