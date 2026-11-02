/**
 * F12: two people, not two accounts, through the real routes on real Postgres under RLS. A maker mints an account through the staff route
 * and that account is then refused as the second person, on each kind of control. See approval.integration.test.ts for the fixture.
 */
import { randomUUID } from "node:crypto"
import { expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@/lib/prisma", async (importOriginal) => (await import("./approval.integration-prisma")).mockPrisma(await importOriginal<typeof import("@/lib/prisma")>()))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))
vi.mock("@/lib/notifications", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/notifications")>()), triggerNotification: vi.fn(async () => undefined) }))

import { POST as templateApprove } from "@/app/api/documents/templates/[id]/versions/[versionId]/approve/route"
import { POST as committeeRoute } from "@/app/api/applications/[id]/committee/route"
import { POST as rateDecide } from "@/app/api/asset-finance/reference-rates/[id]/decide/route"
import { POST as makerChecker } from "@/app/api/maker-checker/[id]/[action]/route"
import { POST as createUser } from "@/app/api/settings/users/route"
import { PATCH as editUser } from "@/app/api/settings/users/[id]/route"
import { PATCH as writeOff } from "@/app/api/loans/[id]/write-off/route"
import { auth } from "@/lib/auth"
import { createDraft, submit } from "@/lib/maker-checker/service"
import { A, approveAs, as, db, ids, inTenant, MATRIX, registerApprovalFixture, statusOf, suite, t, TODAY, underReview, user } from "./approval.integration-fixture"
import { MATRIX_KIND } from "./types"

type Person = { id: string; email: string; role: never; totpVerified: boolean }
const signIn = (person: Person) => vi.mocked(auth).mockResolvedValue({ user: { ...person, tenantId: ids.tenant, name: person.id, tokenVersion: 0 } } as never)
const post = (url: string, body: unknown, method = "POST") => new NextRequest(`http://localhost${url}`, { method, headers: { "x-tenant-slug": ids.tenant, "content-type": "application/json" }, body: JSON.stringify(body) })
const answer = async (res: Response) => ({ status: res.status, body: (await res.json()) as Record<string, unknown> })

/** `by` mints a staff account through the real staff route: the audit row is the route's own. */
async function mint(by: Person, role: string): Promise<Person> {
  signIn(by)
  const email = `sock-${randomUUID().slice(0, 8)}-${t}@test.invalid`
  const res = await answer(await inTenant(() => createUser(post("/api/settings/users", { name: "Second account", email, role, password: "Sy8thetic-Passw0rd-long!" }))))
  expect(res.status, JSON.stringify(res.body)).toBe(201)
  return user((res.body.user as { id: string } | undefined)?.id ?? (res.body.id as string), role) as Person
}

const mcAction = (person: Person, id: string, action: string, body: unknown = {}) => {
  signIn(person)
  return inTenant(async () => answer(await makerChecker(post(`/api/maker-checker/${id}/${action}`, body), { params: Promise.resolve({ id, action }) })))
}

suite("two people, not two accounts (real routes, real Postgres)", () => {
  registerApprovalFixture()

  it("maker-checker (matrix, and so product versions and rule sets): the account the maker minted cannot approve; an unrelated person can", async () => {
    const sock = await mint(as.checker, "SUPER_ADMIN")
    const draft = await createDraft({ tenantId: ids.tenant, actor: as.checker, kind: MATRIX_KIND, title: "Matrix", payload: MATRIX })
    await submit({ tenantId: ids.tenant, actor: as.checker, id: draft.id })
    expect(await mcAction(sock, draft.id, "approve")).toMatchObject({ status: 403, body: { code: "MAKER_ACCOUNT_CONTROLLED" } })
    expect((await db.changeRequest.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe("SUBMITTED")
    const ok = await mcAction(as.checker2, draft.id, "approve")
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
  })

  it("the approval chain: an approver minted by the maker, or by someone who approved an earlier level, is refused, and two hops do not launder it", async () => {
    const sock = await mint(as.ad, "BRANCH_MANAGER")
    const secondHop = await mint(sock, "LOAN_ADMIN")
    await underReview(A("sock"), { amount: 500_000, inputStaff: [ids.ad] })
    const attempt = async (person: Person) => {
      const people = as as unknown as Record<string, Person>
      const key = `sock${randomUUID().slice(0, 4)}`
      people[key] = person
      try { return await approveAs(key as "la1", A("sock")) } finally { delete people[key] }
    }
    expect(await attempt(sock)).toMatchObject({ status: 403, body: { approvalMatrix: "MAKER_ACCOUNT_CONTROLLED" } })
    expect(await attempt(secondHop)).toMatchObject({ status: 403, body: { approvalMatrix: "MAKER_ACCOUNT_CONTROLLED" } })
    expect((await approveAs("bm", A("sock"))).status).toBe(200)
    // The branch manager approved level 1: an account they minted cannot give level 2.
    const levelTwoSock = await mint(as.bm, "BRANCH_MANAGER")
    expect(await attempt(levelTwoSock)).toMatchObject({ status: 403, body: { approvalMatrix: "MAKER_ACCOUNT_CONTROLLED" } })
    expect((await approveAs("ad2", A("sock"))).status).toBe(200)
    expect(await statusOf(A("sock"))).toBe("APPROVED")
  })

  it("the committee: an account minted by someone who approved a level cannot record the decision", async () => {
    await underReview(A("sock-c"), { amount: 800_000, inputStaff: [ids.officer] })
    expect((await approveAs("la2", A("sock-c"))).status).toBe(200)
    expect((await approveAs("ad", A("sock-c"))).status).toBe(200)
    const sock = await mint(as.ad, "ADMIN")
    const record = async (person: Person) => {
      signIn(person)
      return inTenant(async () => answer(await committeeRoute(post(`/api/applications/${A("sock-c")}/committee`, { decision: "APPROVED", meetingDate: TODAY, attendees: ["A. Dlamini"], conditions: [], rationale: "Approved at the sitting today" }), { params: Promise.resolve({ id: A("sock-c") }) })))
    }
    expect(await record(sock)).toMatchObject({ status: 403, body: { code: "ACCOUNT_CONTROLLED" } })
    expect((await record(as.ad2 as Person)).status).toBe(201)
  })

  it("a document template: the account the author minted cannot approve the draft", async () => {
    const sock = await mint(as.ad, "ADMIN")
    const template = await db.documentTemplate.create({ data: { tenantId: ids.tenant, key: `sock-${t}`, name: "Letter", kind: "CUSTOM", requiresApproval: true } })
    const version = await db.documentTemplateVersion.create({ data: { templateId: template.id, version: 1, bodyHtml: "<p>Letter</p>", tokensUsed: [], createdById: ids.ad } })
    const tryApprove = async (person: Person) => {
      signIn(person)
      return inTenant(async () => answer(await templateApprove(post(`/api/documents/templates/${template.id}/versions/${version.id}/approve`, {}), { params: Promise.resolve({ id: template.id, versionId: version.id }) })))
    }
    expect(await tryApprove(sock)).toMatchObject({ status: 409, body: { error: expect.stringContaining("Two people") } })
    expect((await tryApprove(as.ad2 as Person)).status).toBe(200)
    await db.documentTemplate.update({ where: { id: template.id }, data: { deletedAt: new Date() } })
  })

  it("the repo rate: a checker the recorder minted cannot approve it", async () => {
    const sock = await mint(as.ad, "ADMIN")
    const rate = await db.referenceRate.create({ data: { tenantId: ids.tenant, basis: "REPO", effectiveDate: new Date("2026-02-01T00:00:00Z"), rate: "0.0775", requestedById: ids.ad } })
    const decide = async (person: Person, decision: string) => {
      signIn(person)
      return inTenant(async () => answer(await rateDecide(post(`/api/asset-finance/reference-rates/${rate.id}/decide`, { decision }), { params: Promise.resolve({ id: rate.id }) })))
    }
    expect((await decide(sock, "APPROVE")).status).toBe(403)
    expect((await db.referenceRate.findUniqueOrThrow({ where: { id: rate.id } })).status).toBe("PENDING")
    // Refusing is not gated: it moves nothing the second person vouches for.
    const ok = await decide(as.ad2 as Person, "APPROVE")
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
  })

  it("a branch: nobody moves themselves; a move by the maker is a hold over the account through the real staff route", async () => {
    const edit = async (by: Person, target: string, body: object) => {
      signIn(by)
      return inTenant(async () => answer(await editUser(post(`/api/settings/users/${target}`, body, "PATCH"), { params: Promise.resolve({ id: target }) })))
    }
    await db.user.update({ where: { id: ids.bm }, data: { branchId: ids.branch } })
    expect(await edit(as.bm as Person, ids.bm, { branchId: null })).toMatchObject({ status: 400, body: { error: "You cannot change your own branch" } })
    expect((await db.user.findUniqueOrThrow({ where: { id: ids.bm } })).branchId).toBe(ids.branch)
    const hand = await mint(as.checker2 as Person, "LOAN_ADMIN")
    expect((await edit(as.checker2 as Person, hand.id, { branchId: ids.branch })).status).toBe(200)
    const row = await db.auditLog.findFirstOrThrow({ where: { tenantId: ids.tenant, action: "USER_UPDATED", entityId: hand.id }, orderBy: { createdAt: "desc" } })
    expect(row.newValue).toMatchObject({ branchId: ids.branch })
  })

  it("a write-off: the account the requester minted cannot approve it", async () => {
    const sock = await mint(as.ad, "LOAN_ADMIN")
    const n = `${t}${randomUUID().slice(0, 6)}`
    const client = await db.client.create({ data: { tenantId: ids.tenant, reference: `CLI-W-${n}`, idNumber: n, firstName: "Synthetic", lastName: "Borrower", email: `w-${n}@test.invalid`, phone: "+27820000001" } })
    const application = await db.loanApplication.create({ data: { tenantId: ids.tenant, reference: `APP-W-${n}`, clientId: client.id, productId: ids.product, appliedAmount: 300_000, appliedTermDays: 90 } })
    const loan = await db.loan.create({ data: {
      tenantId: ids.tenant, reference: `LN-W-${n}`, applicationId: application.id, clientId: client.id, productId: ids.product, principal: 300_000, totalInterest: 15_000, initiationFee: 0, totalRepayable: 315_000,
      outstandingPrincipal: 300_000, startDate: new Date(Date.now() - 200 * 86_400_000), maturityDate: new Date(Date.now() - 100 * 86_400_000), interestRatePm: 0.05, interestModel: "FLAT", status: "DEFAULTED",
    } })
    const act = async (person: Person, body: object) => {
      signIn(person)
      return inTenant(async () => answer(await writeOff(post(`/api/loans/${loan.id}/write-off`, body, "PATCH"), { params: Promise.resolve({ id: loan.id }) })))
    }
    const asked = await act(as.ad as Person, { action: "request", reason: "Uncollectable after legal advice" })
    expect(asked.status, JSON.stringify(asked.body)).toBe(200)
    expect(await act(sock, { action: "approve", confirm: true })).toMatchObject({ status: 403, body: { error: expect.stringContaining("Two people") } })
    expect((await db.loan.findUniqueOrThrow({ where: { id: loan.id } })).status).toBe("PENDING_WRITE_OFF")
  })

})
