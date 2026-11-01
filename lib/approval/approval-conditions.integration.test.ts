/** F9: the committee's conditions hold the signature and the payout: real route, real triggers, under RLS, on the ZA path (KEY_FACTS: lib/non-nca-documents/committee-conditions.integration.test.ts). */
import { randomUUID } from "node:crypto"
import { NextRequest } from "next/server"
import { expect, it, vi } from "vitest"

vi.mock("@/lib/prisma", async (importOriginal) => (await import("./approval.integration-prisma")).mockPrisma(await importOriginal<typeof import("@/lib/prisma")>()))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))
vi.mock("@/lib/notifications", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/notifications")>()), triggerNotification: vi.fn(async () => undefined) }))

import { POST as clearRoute } from "@/app/api/applications/[id]/committee/conditions/route"
import { POST as generateAgreement } from "@/app/api/applications/[id]/agreement/route"
import { POST as signAgreement } from "@/app/api/applications/[id]/agreement/sign/route"
import { POST as disburse } from "@/app/api/applications/[id]/disburse/route"
import { auth } from "@/lib/auth"
import { recordCommitteeDecision } from "./committee"
import { committeeConditionsRefusal } from "./conditions"
import { loadApprovalProgress } from "./progress"
import { A, app, approveAs, approveMatrix, as, caseOf, db, ids, inTenant, MATRIX, refusal, registerApprovalFixture, sql, statusOf, suite, TODAY, underReview } from "./approval.integration-fixture"

const CONDITIONS = ["Obtain a signed employer letter before disbursement", "Insure the vehicle with the bank noted"]
type Person = (typeof as)["la1"]
const signIn = (person: Person) => vi.mocked(auth).mockResolvedValue({ user: { ...person, tenantId: ids.tenant, name: person.id, tokenVersion: 0 } } as never)
const request = (path: string, body: unknown) => new NextRequest(`http://localhost${path}`, { method: "POST", headers: { "x-tenant-slug": ids.tenant, "content-type": "application/json" }, body: JSON.stringify(body) })
const answer = async (res: Response) => ({ status: res.status, body: (await res.json()) as Record<string, unknown> })
const clear = (person: Person, id: string, index: number, note: string) => {
  signIn(person)
  return inTenant(async () => answer(await clearRoute(request(`/api/applications/${id}/committee/conditions`, { index, note }), { params: Promise.resolve({ id }) })))
}
const insertClearance = (caseId: string, id: string, index: number, text: string, by: string) =>
  sql(`INSERT INTO "ApprovalConditionClearance" ("id","tenantId","caseId","applicationId","conditionIndex","condition","note","clearedById") VALUES ('k-${randomUUID()}','${ids.tenant}','${caseId}','${id}',${index},'${text}','Letter on file','${by}')`)

/** An application approved through the chain with the committee's conditions on its final step. */
async function approvedWithConditions(id: string, inputStaff: string[] = [ids.officer]) {
  await underReview(id, { amount: 800_000, inputStaff })
  expect((await approveAs("la1", id)).status).toBe(200)
  expect((await approveAs("bm", id)).status).toBe(200)
  await inTenant(() => recordCommitteeDecision({ tenantId: ids.tenant, actor: as.ad, applicationId: id, decision: { decision: "APPROVED", meetingDate: TODAY, attendees: ["A. Dlamini"], conditions: CONDITIONS, rationale: "Approved on two conditions" } }))
  const done = await approveAs("ad2", id)
  expect(done.status, JSON.stringify(done.body)).toBe(200)
  expect(await statusOf(id)).toBe("APPROVED")
}

suite("committee conditions at signing and payout (real Postgres)", () => {
  registerApprovalFixture()

  it("setup: the matrix", async () => {
    await approveMatrix(MATRIX)
  })

  it("open conditions are shown, and refuse agreement generation, the borrower's signature and the payout at the routes; the database refuses the writes", async () => {
    await approvedWithConditions(A("za"))
    const progress = await inTenant(() => loadApprovalProgress({ tenantId: ids.tenant, applicationId: A("za"), viewer: { id: ids.ad2, role: "ADMIN" } }))
    expect(progress.conditions.map((c) => [c.text, c.cleared])).toEqual([[CONDITIONS[0], null], [CONDITIONS[1], null]])
    expect(progress.viewer.canClearConditions).toBe(true)
    // A credit officer sees that a condition is open, not what it says.
    const officer = await inTenant(() => loadApprovalProgress({ tenantId: ids.tenant, applicationId: A("za"), viewer: { id: ids.officer, role: "CREDIT_OFFICER" } }))
    expect(officer.conditions).toEqual([{ index: 0, text: null, cleared: null }, { index: 1, text: null, cleared: null }])

    signIn(as.la2)
    const params = { params: Promise.resolve({ id: A("za") }) }
    expect(await inTenant(async () => answer(await generateAgreement(request(`/api/applications/${A("za")}/agreement`, {}), params)))).toMatchObject({ status: 409, body: { code: "COMMITTEE_CONDITIONS" } })
    expect(await inTenant(async () => answer(await signAgreement(request(`/api/applications/${A("za")}/agreement/sign`, { method: "branch", signature: "Synthetic Borrower" }), params)))).toMatchObject({ status: 409, body: { code: "COMMITTEE_CONDITIONS" } })
    expect(await inTenant(async () => answer(await disburse(request(`/api/applications/${A("za")}/disburse`, {}), params)))).toMatchObject({ status: 409, body: { disbursementPrecondition: "committee_conditions" } })
    expect(await refusal(sql(`UPDATE "LoanApplication" SET "agreementSignedAt" = now() WHERE "id" = '${A("za")}'`))).toContain("conditions must all be cleared")
  })

  it("clearing: not by the maker, with what shows it, once, in the committee's words; the second clearance lets the signature through the condition gate", async () => {
    await approvedWithConditions(A("clear"), [ids.la2])
    expect(await clear(as.la2, A("clear"), 0, "Letter on file, 2 Nov")).toMatchObject({ status: 403, body: { code: "MAKER" } })
    expect(await clear(as.ad, A("clear"), 0, "no")).toMatchObject({ status: 422 })
    expect(await clear(as.ad, A("clear"), 7, "Letter on file, 2 Nov")).toMatchObject({ status: 404 })
    expect((await clear(as.ad, A("clear"), 0, "Letter on file, 2 Nov")).status).toBe(200)
    expect(await clear(as.ad, A("clear"), 0, "Letter on file, 2 Nov")).toMatchObject({ status: 409, body: { code: "ALREADY_CLEARED" } })
    expect(await inTenant(() => committeeConditionsRefusal(app() as never, ids.tenant, A("clear")))).toContain("1 of 2")
    const theCase = await caseOf(A("clear"))
    expect(await refusal(insertClearance(theCase.id, A("clear"), 1, "Different wording", ids.ad))).toContain("in the committee")
    expect(await refusal(insertClearance(theCase.id, A("clear"), 1, CONDITIONS[1], ids.la2))).toContain("cannot clear its conditions")
    expect(await refusal(sql(`UPDATE "ApprovalConditionClearance" SET "note" = 'Rewritten afterwards' WHERE "caseId" = '${theCase.id}'`))).toContain("append-only")
    expect((await clear(as.bm, A("clear"), 1, "Policy noted to the bank")).status).toBe(200)
    expect(await inTenant(() => committeeConditionsRefusal(app() as never, ids.tenant, A("clear")))).toBeNull()
    const audited = await db.auditLog.count({ where: { tenantId: ids.tenant, action: "COMMITTEE_CONDITION_CLEARED", entityId: A("clear") } })
    expect(audited).toBe(2)
  })

  it("whoever cleared a condition does not also pay the loan out: route and trigger", async () => {
    signIn(as.ad)
    expect(await inTenant(async () => answer(await disburse(request(`/api/applications/${A("clear")}/disburse`, {}), { params: Promise.resolve({ id: A("clear") }) })))).toMatchObject({ status: 403, body: { disbursementPrecondition: "segregation_of_duties" } })
    expect(await refusal(sql(`UPDATE "LoanApplication" SET "status" = 'DISBURSED', "disbursedAt" = now(), "disbursedById" = '${ids.ad}' WHERE "id" = '${A("clear")}'`))).toContain("cleared a committee condition")
  })

  it("an application with no conditions is unchanged: nothing outstanding, nothing to show", async () => {
    await underReview(A("plain"), { amount: 100_000 + 200_000 })
    expect((await approveAs("la1", A("plain"))).status).toBe(200)
    expect(await inTenant(() => committeeConditionsRefusal(app() as never, ids.tenant, A("plain")))).toBeNull()
    const progress = await inTenant(() => loadApprovalProgress({ tenantId: ids.tenant, applicationId: A("plain"), viewer: { id: ids.ad2, role: "ADMIN" } }))
    expect(progress.conditions).toEqual([])
  })
})
