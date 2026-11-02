/** The two-people rule against the breaker's attacks on #292: real routes, real Postgres, under RLS. RUN_APPROVAL_IT=1. See approval.integration.test.ts. */
import { randomUUID } from "node:crypto"
import { expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@/lib/prisma", async (importOriginal) => (await import("./approval.integration-prisma")).mockPrisma(await importOriginal<typeof import("@/lib/prisma")>()))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))
vi.mock("@/lib/notifications", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/notifications")>()), triggerNotification: vi.fn(async () => undefined) }))
vi.mock("@/lib/compliance/debit-mandate.server", () => ({
  findVerifiedBankStatementForMandate: vi.fn(async () => ({ ok: true, evidence: { documentId: "stmt", documentSha256: "x", verifiedAt: "x" } })),
}))

import { POST as publishRoute } from "@/app/api/documents/templates/[id]/versions/[versionId]/publish/route"
import { POST as createUser } from "@/app/api/settings/users/route"
import { PATCH as editUser } from "@/app/api/settings/users/[id]/route"
import { auth } from "@/lib/auth"
import { avsSubjectFingerprint } from "@/lib/compliance/avs-subject"
import { createChargesLoan, createChargesTenant } from "@/lib/loan/charges.integration-fixture"
import { createDisbursementPayout } from "@/lib/payouts/disbursement"
import { closeRecoveryUnrecoverable } from "@/lib/payouts/recovery"
import { applyProviderState, resolvePayout } from "@/lib/payouts/resolve"
import { decidePayoutRetry, requestPayoutRetry } from "@/lib/payouts/retry"
import { decideDisbursementReversal, requestDisbursementReversal } from "@/lib/payouts/reversal"
import { accountControlRefusal } from "@/lib/security/account-control"
import { resolveStaffUser } from "@/lib/sso/identity"
import { A, approveAs, as, db, ids, inTenant, MATRIX, registerApprovalFixture, suite, t, underReview, user, approveMatrix } from "./approval.integration-fixture"

type Person = { id: string; email: string; role: never; totpVerified: boolean }
const signIn = (person: Person) => vi.mocked(auth).mockResolvedValue({ user: { ...person, tenantId: ids.tenant, name: person.id, tokenVersion: 0 } } as never)
const req = (url: string, body: unknown, method = "POST") => new NextRequest(`http://localhost${url}`, { method, headers: { "x-tenant-slug": ids.tenant, "content-type": "application/json" }, body: JSON.stringify(body) })
const answer = async (res: Response) => ({ status: res.status, body: (await res.json()) as Record<string, unknown> })
const PASSWORD = "Sy8thetic-Passw0rd-long!"

/** Staff of long standing, with no audit row: nobody at the lender created them inside the window. */
async function veteran(role: string): Promise<Person> {
  const id = `v-${randomUUID().slice(0, 8)}-${t}`
  await db.user.create({ data: { id, tenantId: ids.tenant, email: `${id}@test.invalid`, password: "x", name: id, role: role as never, createdAt: new Date(Date.now() - 400 * 86_400_000) } })
  return user(id, role) as Person
}
async function mint(by: Person, role: string): Promise<Person> {
  signIn(by)
  const email = `sock-${randomUUID().slice(0, 8)}-${t}@test.invalid`
  const res = await answer(await inTenant(() => createUser(req("/api/settings/users", { name: "Second account", email, role, password: PASSWORD }))))
  expect(res.status, JSON.stringify(res.body)).toBe(201)
  return user(res.body.id as string, role) as Person
}
/** The takeover: new email and password on someone else's account, through the real staff route. */
async function takeOver(by: Person, target: Person) {
  signIn(by)
  const res = await answer(await inTenant(() => editUser(req(`/api/settings/users/${target.id}`, { email: `taken-${randomUUID().slice(0, 8)}@test.invalid`, password: PASSWORD }, "PATCH"), { params: Promise.resolve({ id: target.id }) })))
  expect(res.status, JSON.stringify(res.body)).toBe(200)
}
async function approveAsPerson(person: Person, application: string) {
  const people = as as unknown as Record<string, Person>
  const key = `p${randomUUID().slice(0, 6)}`
  people[key] = person
  try { return await approveAs(key as "la1", application) } finally { delete people[key] }
}

suite("two people, not two accounts: the attacks (real routes, real Postgres)", () => {
  registerApprovalFixture()

  it("setup: the matrix is in force", async () => {
    await approveMatrix(MATRIX)
  })

  it("one person takes over two old accounts, then uses one as maker and the other as approver: refused", async () => {
    const takeoverAdmin = await veteran("ADMIN")
    const makerAccount = await veteran("LOAN_ADMIN")
    const checkerAccount = await veteran("LOAN_ADMIN")
    await takeOver(takeoverAdmin, makerAccount)
    await takeOver(takeoverAdmin, checkerAccount)
    await underReview(A("brk-both"), { amount: 200_000, inputStaff: [makerAccount.id] })
    expect((await approveAsPerson(checkerAccount, A("brk-both"))).status).toBe(403)
  })

  it("one person mints the maker and takes over an old approver: refused", async () => {
    const takeoverAdmin = await veteran("ADMIN")
    const makerAccount = await mint(takeoverAdmin, "LOAN_ADMIN")
    const checkerAccount = await veteran("LOAN_ADMIN")
    await takeOver(takeoverAdmin, checkerAccount)
    await underReview(A("brk-mix"), { amount: 200_000, inputStaff: [makerAccount.id] })
    expect((await approveAsPerson(checkerAccount, A("brk-mix"))).status).toBe(403)
  })

  it("a document template: the account the approver minted cannot publish what they approved", async () => {
    const author = await veteran("ADMIN")
    const approver = await veteran("ADMIN")
    const sock = await mint(approver, "LOAN_ADMIN")
    const template = await db.documentTemplate.create({ data: { tenantId: ids.tenant, key: `brk-${t}`, name: "Letter", kind: "CUSTOM", requiresApproval: true } })
    const version = await db.documentTemplateVersion.create({ data: { templateId: template.id, version: 1, bodyHtml: "<p>Letter</p>", tokensUsed: [], createdById: author.id, approvedById: approver.id, approvedAt: new Date() } })
    signIn(sock)
    const res = await answer(await inTenant(() => publishRoute(req(`/api/documents/templates/${template.id}/versions/${version.id}/publish`, {}), { params: Promise.resolve({ id: template.id, versionId: version.id }) })))
    await db.documentTemplate.update({ where: { id: template.id }, data: { deletedAt: new Date() } })
    expect(res.status, JSON.stringify(res.body)).toBe(409)
  })

  it("SSO: an account provisioned through the connection a SUPER_ADMIN controls is opposite that SUPER_ADMIN under the rule", async () => {
    const superAdmin = await veteran("SUPER_ADMIN")
    const conn = { tenantId: ids.tenant, allowedEmailDomains: [], groupRoleMap: {}, jitProvisioning: true, jitDefaultRole: "LOAN_ADMIN", allowUnverifiedEmail: true } as never
    await db.auditLog.create({ data: { tenantId: ids.tenant, userId: superAdmin.id, action: "SSO_CONNECTION_UPDATED", entity: "SsoConnection", entityId: ids.tenant } })
    const outcome = await inTenant(() => resolveStaffUser({ subject: `idp|sub-${t}`, email: `jit-${t}@test.invalid`, emailVerified: true, groups: [], name: "Jit", mfaProven: true } as never, conn))
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ ok: true, created: true })
    const refusal = await accountControlRefusal(db as never, { tenantId: ids.tenant, makerIds: [superAdmin.id], checkerId: (outcome as { userId: string }).userId })
    expect(refusal).not.toBeNull()
  })

  it("a payout recovery case: the account the opener minted cannot close it unrecoverable", async () => {
    const tenant = await createChargesTenant(db, false)
    await db.tenantConfig.update({ where: { tenantId: tenant.tenantId }, data: { payoutsEngineEnabled: true, payoutProvider: "simulated" } })
    const person = (s: string) => ({ id: `${tenant.userId}${s}`, email: `${tenant.userId}${s}@test.invalid` })
    const [requester, approver, opener, sock] = [person("-req"), person("-apr"), person("-opn"), person("-sock")]
    for (const u of [requester, approver, opener, sock]) await db.user.create({ data: { id: u.id, tenantId: tenant.tenantId, email: u.email, password: "x", role: "LOAN_ADMIN" } })
    // The row POST /api/settings/users writes: the opener created this account.
    await db.auditLog.create({ data: { tenantId: tenant.tenantId, userId: opener.id, action: "USER_CREATED", entity: "User", entityId: sock.id } })
    const lid = await createChargesLoan(db, tenant)
    const loan = await db.loan.findUniqueOrThrow({ where: { id: lid.loanId }, select: { applicationId: true, reference: true, clientId: true } })
    const client = await db.client.update({ where: { id: loan.clientId! }, data: { bankName: "FNB", bankBranchCode: "250655", bankAccountNumber: "62000001111", accountType: "SAVINGS" } })
    const disburser = person("")
    const { id } = await db.$transaction((tx) => createDisbursementPayout(tx as never, {
      tenantId: tenant.tenantId, applicationId: loan.applicationId, loanId: lid.loanId, providerId: "simulated", amountCents: 200_000, reference: loan.reference,
      beneficiary: { accountHolder: "Charge Test", bankName: "FNB", branchCode: "250655", accountNumber: "62000001111", accountType: "SAVINGS" }, user: disburser, avs: { avsCheckId: "it", simulated: true },
    }))
    await db.disbursementPayout.update({ where: { id }, data: { status: "SUBMITTING", submittedAt: new Date() } })
    await db.disbursementPayout.update({ where: { id }, data: { status: "FAILED", failureReason: "account closed" } })
    await new Promise((r) => setTimeout(r, 5))
    await db.avsCheck.create({ data: { tenantId: tenant.tenantId, clientId: client.id, applicationId: loan.applicationId, provider: "netcash", subjectFingerprint: avsSubjectFingerprint(client), accountHolder: "Charge Test", bankName: "FNB", branchCode: "250655", accountNumber: "62000001111", accountType: "SAVINGS", passed: true, checks: {} } })
    const asked = await requestPayoutRetry(db as never, { tenantId: tenant.tenantId, loanId: lid.loanId, actor: requester })
    const retryId = (asked as { payoutId: string }).payoutId
    expect(await decidePayoutRetry(db as never, { tenantId: tenant.tenantId, payoutId: retryId, approve: true, note: "ok", actor: approver })).toMatchObject({ ok: true })
    await db.disbursementPayout.update({ where: { id: retryId }, data: { status: "SUBMITTING", submittedAt: new Date(), providerReference: `sim-disburse:${loan.applicationId}-1111` } })
    await db.disbursementPayout.update({ where: { id: retryId }, data: { status: "FAILED", failureReason: "account closed" } })
    const rev = await requestDisbursementReversal(db as never, { tenantId: tenant.tenantId, loanId: lid.loanId, reason: "The bank says the account is closed", actor: requester })
    expect(await decideDisbursementReversal(db as never, { tenantId: tenant.tenantId, reversalId: (rev as { reversalId: string }).reversalId, approve: true, note: "Confirmed", actor: approver })).toMatchObject({ ok: true })
    await applyProviderState(db as never, { tenantId: tenant.tenantId, payout: await db.disbursementPayout.findUniqueOrThrow({ where: { id: retryId } }), state: "PAID", source: "webhook", actor: { id: null, email: "webhook" } } as never)
    expect(await resolvePayout(db as never, { tenantId: tenant.tenantId, payoutId: retryId, actor: opener, request: { action: "resolve_conflict", outcome: "recovery", note: "Bank statement shows it left", paidAt: new Date() } } as never)).toMatchObject({ ok: true })
    const opened = await db.payoutRecoveryCase.findUniqueOrThrow({ where: { payoutId: retryId } })
    const closed = await closeRecoveryUnrecoverable(db as never, { tenantId: tenant.tenantId, caseId: opened.id, note: "Recipient account closed", actor: sock })
    expect(closed).toMatchObject({ ok: false, status: 403, error: expect.stringContaining("Two people") })
  })
})
