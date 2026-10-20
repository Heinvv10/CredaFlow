import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

// Every staff dealer route (app/api/asset-finance/dealers/**, dealer-runs/**,
// dealer-commission/**, deals/[id]/dealer-*, deals/[id]/document-requests):
// the house guard (session, staff role, TOTP enrolment hold, tenant, module
// flag, permission) runs before any lib/dealer write, and the write gets the
// signed-in staff member as its actor. The lib functions are stubbed here and
// proven against Postgres in lib/dealer/*.integration.test.ts.
const m = vi.hoisted(() => ({
  session: null as null | { user: Record<string, unknown> },
  flag: { on: true },
  lib: {
    createDealer: vi.fn(), updateDealer: vi.fn(), deactivateDealer: vi.fn(), createDealerUser: vi.fn(), deactivateDealerUser: vi.fn(),
    issueDealerPasswordLink: vi.fn(), setCommissionRate: vi.fn(), requestDealerBankAccount: vi.fn(), decideDealerBankAccount: vi.fn(),
    createPayableRun: vi.fn(), approvePayableRun: vi.fn(), releasePayableRun: vi.fn(), cancelPayableRun: vi.fn(),
    acceptDealerSubmission: vi.fn(), verifyDealerConsent: vi.fn(), requestDealerDocument: vi.fn(), verifyDealerContact: vi.fn(),
    loadDealerForStaff: vi.fn(), loadRunStatement: vi.fn(), listDealersForStaff: vi.fn(), defaultRateHistory: vi.fn(),
  },
  auditRefusal: vi.fn(),
}))

vi.mock("next/navigation", () => ({ redirect: vi.fn(), notFound: vi.fn() }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => m.session) }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantConfig: { findUnique: async () => ({ featureCrm: false, featureIms: false, featureAssetFinance: m.flag.on }) },
    $transaction: (fn: (tx: unknown) => unknown) => fn({}),
  },
}))
vi.mock("@/lib/tenant", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant")>()),
  withTenantContext: (_req: unknown, fn: (t: { id: string }) => unknown) => fn({ id: "tenant-1" }),
}))
vi.mock("@/lib/dealer/staff-dealers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./staff-dealers")>()), createDealer: m.lib.createDealer, updateDealer: m.lib.updateDealer,
}))
vi.mock("@/lib/dealer/users", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./users")>()),
  deactivateDealer: m.lib.deactivateDealer, createDealerUser: m.lib.createDealerUser, deactivateDealerUser: m.lib.deactivateDealerUser,
}))
vi.mock("@/lib/dealer/password-links", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./password-links")>()), issueDealerPasswordLink: m.lib.issueDealerPasswordLink,
}))
vi.mock("@/lib/dealer/staff-rates", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./staff-rates")>()), setCommissionRate: m.lib.setCommissionRate,
}))
vi.mock("@/lib/dealer/staff-bank-accounts", () => ({
  requestDealerBankAccount: m.lib.requestDealerBankAccount, decideDealerBankAccount: m.lib.decideDealerBankAccount,
}))
vi.mock("@/lib/dealer/payable-runs", () => ({
  createPayableRun: m.lib.createPayableRun, approvePayableRun: m.lib.approvePayableRun,
  releasePayableRun: m.lib.releasePayableRun, cancelPayableRun: m.lib.cancelPayableRun,
}))
vi.mock("@/lib/dealer/submit", () => ({ acceptDealerSubmission: m.lib.acceptDealerSubmission }))
vi.mock("@/lib/dealer/consent", () => ({ verifyDealerConsent: m.lib.verifyDealerConsent }))
vi.mock("@/lib/dealer/document-requests", () => ({ requestDealerDocument: m.lib.requestDealerDocument }))
vi.mock("@/lib/dealer/contact-verification", () => ({ verifyDealerContact: m.lib.verifyDealerContact }))
vi.mock("@/lib/audit-refusals", () => ({ auditRefusal: m.auditRefusal }))
vi.mock("@/lib/dealer/staff-view", () => ({
  loadDealerForStaff: m.lib.loadDealerForStaff, loadRunStatement: m.lib.loadRunStatement,
  listDealersForStaff: m.lib.listDealersForStaff, defaultRateHistory: m.lib.defaultRateHistory,
}))
vi.mock("@/lib/asset-finance/deal-detail", () => ({ loadDealDetail: async () => ({ id: "deal-1" }) }))
vi.mock("@/lib/screening/on-submit", () => ({ screenOnSubmit: vi.fn(async () => undefined) }))

import * as dealers from "@/app/api/asset-finance/dealers/route"
import * as dealer from "@/app/api/asset-finance/dealers/[id]/route"
import * as users from "@/app/api/asset-finance/dealers/[id]/users/route"
import * as userDeactivate from "@/app/api/asset-finance/dealers/[id]/users/[userId]/deactivate/route"
import * as resetLink from "@/app/api/asset-finance/dealers/[id]/users/[userId]/reset-link/route"
import * as rates from "@/app/api/asset-finance/dealers/[id]/rates/route"
import * as defaultRate from "@/app/api/asset-finance/dealer-commission/default-rate/route"
import * as bankAccounts from "@/app/api/asset-finance/dealers/[id]/bank-accounts/route"
import * as decide from "@/app/api/asset-finance/dealers/bank-accounts/[accountId]/decide/route"
import * as runs from "@/app/api/asset-finance/dealers/[id]/runs/route"
import * as run from "@/app/api/asset-finance/dealer-runs/[runId]/route"
import * as approve from "@/app/api/asset-finance/dealer-runs/[runId]/approve/route"
import * as release from "@/app/api/asset-finance/dealer-runs/[runId]/release/route"
import * as cancel from "@/app/api/asset-finance/dealer-runs/[runId]/cancel/route"
import * as accept from "@/app/api/asset-finance/deals/[id]/dealer-submission/accept/route"
import * as verify from "@/app/api/asset-finance/deals/[id]/dealer-consents/[attestationId]/verify/route"
import * as documentRequests from "@/app/api/asset-finance/deals/[id]/document-requests/route"
import * as verifyContact from "@/app/api/asset-finance/deals/[id]/dealer-people/[clientId]/verify-contact/route"

const ACCOUNT = { bankName: "TEST Bank", branchCode: "000001", accountNumber: "62000000001", accountHolder: "TEST Motors" }
const req = (method: string, body?: unknown) => new NextRequest("http://lender.test/api/x", {
  method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})
const p = <T extends Record<string, string>>(params: T) => ({ params: Promise.resolve(params) })

type Case = { name: string; permission: "manage_dealers" | "decide_asset_finance" | "manage_asset_finance"; call: () => Promise<Response>; lib?: keyof typeof m.lib }
const CASES: Case[] = [
  { name: "GET dealers", permission: "manage_dealers", call: () => dealers.GET(req("GET")), lib: "listDealersForStaff" },
  { name: "POST dealers", permission: "manage_dealers", call: () => dealers.POST(req("POST", { name: "TEST Motors", kind: "DEALER", contactEmail: "a@b.invalid" })), lib: "createDealer" },
  { name: "GET dealer", permission: "manage_dealers", call: () => dealer.GET(req("GET"), p({ id: "dlr-1" })), lib: "loadDealerForStaff" },
  { name: "PATCH dealer", permission: "manage_dealers", call: () => dealer.PATCH(req("PATCH", { active: false }), p({ id: "dlr-1" })), lib: "deactivateDealer" },
  { name: "POST users", permission: "manage_dealers", call: () => users.POST(req("POST", { email: "u@d.invalid", name: "TEST U", role: "DEALER_ADMIN" }), p({ id: "dlr-1" })), lib: "createDealerUser" },
  { name: "POST user deactivate", permission: "manage_dealers", call: () => userDeactivate.POST(req("POST"), p({ id: "dlr-1", userId: "du-1" })), lib: "deactivateDealerUser" },
  { name: "POST reset-link", permission: "manage_dealers", call: () => resetLink.POST(req("POST"), p({ id: "dlr-1", userId: "du-1" })), lib: "issueDealerPasswordLink" },
  { name: "POST rates", permission: "manage_dealers", call: () => rates.POST(req("POST", { effectiveFrom: "2026-10-01", bps: 250, flatCents: 0 }), p({ id: "dlr-1" })), lib: "setCommissionRate" },
  { name: "POST default rate", permission: "manage_dealers", call: () => defaultRate.POST(req("POST", { effectiveFrom: "2026-10-01", bps: 100, flatCents: 0 })), lib: "setCommissionRate" },
  { name: "POST bank account", permission: "manage_dealers", call: () => bankAccounts.POST(req("POST", ACCOUNT), p({ id: "dlr-1" })), lib: "requestDealerBankAccount" },
  { name: "POST decide", permission: "decide_asset_finance", call: () => decide.POST(req("POST", { decision: "APPROVE", note: "TEST letter checked" }), p({ accountId: "dba-1" })), lib: "decideDealerBankAccount" },
  { name: "POST runs", permission: "manage_dealers", call: () => runs.POST(req("POST", { periodEnd: "2026-09-30" }), p({ id: "dlr-1" })), lib: "createPayableRun" },
  { name: "GET run", permission: "manage_dealers", call: () => run.GET(req("GET"), p({ runId: "run-1" })), lib: "loadRunStatement" },
  { name: "POST approve", permission: "decide_asset_finance", call: () => approve.POST(req("POST"), p({ runId: "run-1" })), lib: "approvePayableRun" },
  { name: "POST release", permission: "decide_asset_finance", call: () => release.POST(req("POST", { releaseReference: "EFT-1" }), p({ runId: "run-1" })), lib: "releasePayableRun" },
  { name: "POST cancel", permission: "decide_asset_finance", call: () => cancel.POST(req("POST"), p({ runId: "run-1" })), lib: "cancelPayableRun" },
  { name: "POST accept", permission: "manage_asset_finance", call: () => accept.POST(req("POST"), p({ id: "deal-1" })), lib: "acceptDealerSubmission" },
  { name: "POST verify", permission: "manage_asset_finance", call: () => verify.POST(req("POST"), p({ id: "deal-1", attestationId: "att-1" })), lib: "verifyDealerConsent" },
  { name: "POST document request", permission: "manage_asset_finance", call: () => documentRequests.POST(req("POST", { docType: "AFS", note: "Latest AFS" }), p({ id: "deal-1" })), lib: "requestDealerDocument" },
  { name: "POST verify contact", permission: "manage_asset_finance", call: () => verifyContact.POST(req("POST"), p({ id: "deal-1", clientId: "c-1" })), lib: "verifyDealerContact" },
]

const signIn = (role: string, extra: Record<string, unknown> = {}) => {
  m.session = { user: { id: `user-${role}`, email: `${role.toLowerCase()}@lender.test`, role, tenantId: "tenant-1", ...extra } }
}
const BELOW: Record<Case["permission"], string> = { manage_dealers: "CREDIT_OFFICER", decide_asset_finance: "CREDIT_OFFICER", manage_asset_finance: "READONLY" }
const libCalls = () => Object.values(m.lib).reduce((n, fn) => n + fn.mock.calls.length, 0)

beforeEach(() => {
  vi.clearAllMocks()
  m.flag.on = true
  process.env.NEXTAUTH_URL = "https://staff.lender.test"
  process.env.DEALER_APP_HOST = "dealer.lender.test"
  const refused = { kind: "refused", status: 409, error: "TEST refusal" }
  for (const fn of Object.values(m.lib)) fn.mockResolvedValue(refused)
  m.lib.loadDealerForStaff.mockResolvedValue({ id: "dlr-1" })
  m.lib.loadRunStatement.mockResolvedValue({ id: "run-1", bankAccount: { accountNumber: "62000000001" } })
  m.lib.listDealersForStaff.mockResolvedValue([])
  m.lib.defaultRateHistory.mockResolvedValue([])
})

describe.each(CASES)("$name", (c) => {
  it("answers 401 with no session and refuses DEALER and CLIENT sessions, writing nothing", async () => {
    m.session = null
    expect((await c.call()).status).toBe(401)
    for (const role of ["DEALER", "CLIENT"]) {
      signIn(role, { dealerId: "dlr-1", dealerRole: "DEALER_ADMIN" })
      expect((await c.call()).status).toBe(403)
    }
    expect(libCalls()).toBe(0)
  })

  it("holds a user awaiting TOTP enrolment, 404s with the module off, 403s below the permission", async () => {
    signIn("ADMIN", { totpEnrolmentRequired: true })
    expect((await c.call()).status).toBeGreaterThanOrEqual(400)
    signIn("ADMIN")
    m.flag.on = false
    expect((await c.call()).status).toBe(404)
    m.flag.on = true
    signIn(BELOW[c.permission])
    expect((await c.call()).status).toBe(403)
    expect(libCalls()).toBe(0)
  })

  it("lets a LOAN_ADMIN through to the lib function, as the staff actor of the session's tenant", async () => {
    signIn("LOAN_ADMIN")
    const res = await c.call()
    expect(res.status).toBeLessThan(500)
    const fn = m.lib[c.lib!]
    expect(fn).toHaveBeenCalledTimes(1)
    const args = JSON.stringify(fn.mock.calls[0])
    expect(args).toContain("tenant-1")
    if (!/^(load|list|default)/.test(c.lib!)) expect(args).toContain("user-LOAN_ADMIN")
  })
})

describe("route specifics", () => {
  beforeEach(() => signIn("LOAN_ADMIN"))

  it("answers a lib refusal with its status and sentence", async () => {
    const res = await approve.POST(req("POST"), p({ runId: "run-1" }))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: "TEST refusal" })
  })

  it("refuses self-approval of a run and self-decision of an account 403, and audits each refusal", async () => {
    m.lib.approvePayableRun.mockResolvedValue({ kind: "self_approval" })
    expect((await approve.POST(req("POST"), p({ runId: "run-1" }))).status).toBe(403)
    expect(m.auditRefusal).toHaveBeenLastCalledWith(expect.objectContaining({
      action: "DEALER_PAYABLE_RUN_APPROVAL_REFUSED", entity: "DealerPayableRun", entityId: "run-1", tenantId: "tenant-1",
      userId: "user-LOAN_ADMIN", reason: "four_eyes_self_approval", status: 403,
    }))
    m.lib.decideDealerBankAccount.mockResolvedValue({ kind: "self_decision" })
    expect((await decide.POST(req("POST", { decision: "APPROVE", note: "TEST letter checked" }), p({ accountId: "dba-1" }))).status).toBe(403)
    expect(m.auditRefusal).toHaveBeenLastCalledWith(expect.objectContaining({
      action: "DEALER_BANK_ACCOUNT_DECISION_REFUSED", entity: "DealerBankAccount", entityId: "dba-1", tenantId: "tenant-1",
      userId: "user-LOAN_ADMIN", reason: "four_eyes_self_decision", status: 403,
    }))
    expect(m.auditRefusal).toHaveBeenCalledTimes(2)
  })

  it("shows a new user's set-password link once, uncached; refuses before writing when the dealer host is not configured", async () => {
    m.lib.createDealerUser.mockResolvedValue({ kind: "created", userId: "du-9", token: "ab".repeat(32), expiresAt: new Date("2026-10-22T10:00:00Z") })
    const res = await users.POST(req("POST", { email: "u@d.invalid", name: "TEST U", role: "DEALER_ADMIN" }), p({ id: "dlr-1" }))
    expect(res.status).toBe(201)
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(await res.json()).toMatchObject({ setPasswordUrl: `https://dealer.lender.test/dealer/set-password?token=${"ab".repeat(32)}` })
    expect(m.lib.createDealerUser).toHaveBeenCalledWith({ kind: "staff", staff: { tenantId: "tenant-1", userId: "user-LOAN_ADMIN", userEmail: "loan_admin@lender.test" } },
      "dlr-1", { email: "u@d.invalid", name: "TEST U", role: "DEALER_ADMIN" })
    delete process.env.DEALER_APP_HOST
    m.lib.createDealerUser.mockClear()
    expect((await users.POST(req("POST", { email: "u@d.invalid", name: "TEST U", role: "DEALER_ADMIN" }), p({ id: "dlr-1" }))).status).toBe(409)
    expect((await resetLink.POST(req("POST"), p({ id: "dlr-1", userId: "du-1" }))).status).toBe(409)
    expect(m.lib.createDealerUser).not.toHaveBeenCalled()
    expect(m.lib.issueDealerPasswordLink).not.toHaveBeenCalled()
  })

  it("PATCH: { active: false } alone deactivates, details edit, a mix is 400", async () => {
    m.lib.updateDealer.mockResolvedValue({ kind: "updated" })
    expect((await dealer.PATCH(req("PATCH", { active: false, name: "X" }), p({ id: "dlr-1" }))).status).toBe(400)
    expect((await dealer.PATCH(req("PATCH", { active: true }), p({ id: "dlr-1" }))).status).toBe(400)
    expect((await dealer.PATCH(req("PATCH", { contactPhone: "+27110000000" }), p({ id: "dlr-1" }))).status).toBe(200)
    expect(m.lib.updateDealer).toHaveBeenCalledWith(expect.objectContaining({ userId: "user-LOAN_ADMIN" }), "dlr-1", { contactPhone: "+27110000000" })
    expect(m.lib.deactivateDealer).not.toHaveBeenCalled()
  })

  it("rejects an invalid body 400 before any write", async () => {
    expect((await dealers.POST(req("POST", { name: "" }))).status).toBe(400)
    expect((await rates.POST(req("POST", { effectiveFrom: "x", bps: 1, flatCents: 0 }), p({ id: "dlr-1" }))).status).toBe(400)
    expect((await bankAccounts.POST(req("POST", { ...ACCOUNT, branchCode: "1" }), p({ id: "dlr-1" }))).status).toBe(400)
    expect((await decide.POST(req("POST", { decision: "APPROVE", note: "short" }), p({ accountId: "dba-1" }))).status).toBe(400)
    expect(libCalls()).toBe(0)
  })

  it("shows the run's full account number to the roles that read it (all hold decide_asset_finance)", async () => {
    const res = await run.GET(req("GET"), p({ runId: "run-1" }))
    expect((await res.json()).bankAccount.accountNumber).toBe("62000000001")
  })

  it("accept answers as the staff submit does and screens the borrower", async () => {
    m.lib.acceptDealerSubmission.mockResolvedValue({ kind: "submitted", awaitingRegimeApproval: false, regime: "NCA", rule: "NATURAL_PERSON_NCA" })
    const res = await accept.POST(req("POST"), p({ id: "deal-1" }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ refusedNca: false, awaitingRegimeApproval: false, deal: { id: "deal-1" } })
    m.lib.acceptDealerSubmission.mockResolvedValue({ kind: "not_draft", status: "SUBMITTED" })
    expect((await accept.POST(req("POST"), p({ id: "deal-1" }))).status).toBe(409)
  })
})
