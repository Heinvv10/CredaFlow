/** F11: "the committee's latest decision" is the last one written, whatever its createdAt says (real Postgres). See approval.integration.test.ts. */

import { randomUUID } from "node:crypto"
import { expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@/lib/prisma", async (importOriginal) => (await import("./approval.integration-prisma")).mockPrisma(await importOriginal<typeof import("@/lib/prisma")>()))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))
vi.mock("@/lib/notifications", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/notifications")>()), triggerNotification: vi.fn(async () => undefined) }))

import { auth } from "@/lib/auth"
import { POST as recordDecision } from "@/app/api/applications/[id]/committee/route"
import { loadApprovalProgress } from "./progress"
import { A, approveAs, approveMatrix, as, caseOf, db, ids, inTenant, MATRIX, refusal, registerApprovalFixture, sql, statusOf, suite, t, TODAY, underReview } from "./approval.integration-fixture"

/** The committee route, as a person: real guard, real tenant context, the app's database role. */
async function committee(who: keyof typeof as, applicationId: string, decision: "APPROVED" | "DECLINED") {
  vi.mocked(auth).mockResolvedValue({ user: { ...as[who], tenantId: ids.tenant, name: who } } as never)
  const req = new NextRequest(`http://localhost/api/applications/${applicationId}/committee`, {
    method: "POST", headers: { "x-tenant-slug": ids.tenant, "content-type": "application/json" },
    body: JSON.stringify({ decision, meetingDate: TODAY, attendees: ["A. Dlamini", "B. Mokoena"], conditions: [], rationale: `Committee ${decision.toLowerCase()} this application` }),
  })
  return inTenant(() => recordDecision(req, { params: Promise.resolve({ id: applicationId }) }))
}

suite("approval matrix: the committee's latest decision follows the insert order (real Postgres)", () => {
  registerApprovalFixture()

  it("a decline whose transaction began before the approval it replaces still counts: route, gate and trigger agree", async () => {
    await approveMatrix(MATRIX)
    await underReview(A("order"), { amount: 800_000, inputStaff: [ids.officer] })
    expect((await approveAs("la1", A("order"))).status).toBe(200)
    expect((await approveAs("bm", A("order"))).status).toBe(200)
    const theCase = await caseOf(A("order"))
    // Two sittings, the second written last with the earlier clock: its transaction started before the first committed.
    await db.$transaction(async (older) => {
      await older.$queryRaw`SELECT now()`
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect((await committee("ad", A("order"), "APPROVED")).status).toBe(201)
      await older.$executeRawUnsafe(`INSERT INTO "CreditCommitteeDecision" ("id","tenantId","caseId","applicationId","level","decision","meetingDate","conditions","rationale","recordedById") VALUES ('cd-${randomUUID()}','${ids.tenant}','${theCase.id}','${A("order")}',3,'DECLINED',now(),'[]'::jsonb,'Declined after all, on the second sitting','${ids.checker}')`)
    }, { timeout: 30_000 })
    const rows = await db.creditCommitteeDecision.findMany({ where: { caseId: theCase.id }, orderBy: { seq: "asc" } })
    expect(rows.map((r) => r.decision)).toEqual(["APPROVED", "DECLINED"])
    expect(rows[1].createdAt.getTime()).toBeLessThan(rows[0].createdAt.getTime())

    expect(await approveAs("ad2", A("order"))).toMatchObject({ status: 409, body: { approvalMatrix: "COMMITTEE_DECLINED" } })
    expect(await statusOf(A("order"))).toBe("UNDER_REVIEW")
    expect(await refusal(sql(`INSERT INTO "ApprovalStep" ("id","tenantId","caseId","applicationId","level","approverId","via") VALUES ('s-${t}-${randomUUID()}','${ids.tenant}','${theCase.id}','${A("order")}',3,'${ids.ad2}','ROLE')`))).toContain("latest credit committee decision")
    const progress = await inTenant(() => loadApprovalProgress({ tenantId: ids.tenant, applicationId: A("order"), viewer: { id: ids.ad2, role: "ADMIN" } }))
    expect(progress.committeeDecisions.map((d) => d.decision)).toEqual(["APPROVED", "DECLINED"])
  })
})
