/**
 * Real-Postgres proof that a lender's approval matrix and credit committee govern a loan change that books a new loan, as they
 * govern an application, and that the database's chain guard runs on it. A change in place keeps its one second person.
 *
 *   RUN_LOAN_CHANGES_IT=1 DATABASE_URL=postgresql://... npx vitest run lib/loan-changes/
 *
 * Its own throwaway database: the role needs CREATEDB. Only the session is stood in for.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { createThrowawayDb, type ThrowawayDb } from "@/lib/jurisdiction/throwaway-db.integration-fixture"
import { runWithTenant } from "@/lib/tenant-scope"

const holder = vi.hoisted(() => ({ prisma: null as unknown, tenantId: "", user: { id: "", email: "", role: "", totpVerified: true } }))
vi.mock("@/lib/prisma", async (original) => ({
  ...(await original<typeof import("@/lib/prisma")>()),
  prisma: new Proxy({}, { get: (_t, key) => (holder.prisma as Record<string | symbol, unknown>)[key] }),
}))
vi.mock("@/lib/auth-guards", async () => ({
  requireApiRole: vi.fn(async () => ({ error: null, user: holder.user })),
  canDo: (await vi.importActual<typeof import("@/lib/permissions")>("@/lib/permissions")).canDo,
}))
vi.mock("@/lib/tenant", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant")>()),
  withTenantContext: async (_req: unknown, handler: (tenant: { id: string }) => Promise<unknown>) => await runWithTenant(holder.tenantId, () => handler({ id: holder.tenantId })),
}))

import { createAppPrismaClient } from "@/lib/prisma"
import { POST as actionRoute } from "@/app/api/maker-checker/[id]/[action]/route"
import { recordCommitteeDecision } from "@/lib/approval/committee"
import { sastCalendarDate } from "@/lib/date/sast"
import { MATRIX_KIND } from "@/lib/approval/types"
import { approve, createDraft, submit } from "@/lib/maker-checker/service"
import { bookLoan, changeRoutes, type LoanFixture } from "./loan-changes.integration-fixture"

const suite = process.env.RUN_LOAN_CHANGES_IT === "1" ? describe.sequential : describe.skip
const { as, req, params, draftAndSubmit } = changeRoutes(holder)

suite("loan changes under an approval matrix (real Postgres, real routes)", () => {
  let fresh: ThrowawayDb
  const db = () => fresh.db
  let l: LoanFixture
  const staff = async (id: string, role: string) => { await db().user.create({ data: { id, tenantId: l.tenantId, email: `${id}@test.invalid`, password: "x", role: role as never, createdAt: new Date(Date.now() - 90 * 86_400_000) } }); return { id, email: `${id}@test.invalid`, role, totpVerified: true } }
  const approveAs = (user: typeof holder.user, id: string, note = "At my level") => { holder.tenantId = l.tenantId; holder.user = user; return actionRoute(req({ note }), params({ id, action: "approve" })) }
  const decideCommittee = (actor: typeof holder.user, applicationId: string) => runWithTenant(l.tenantId, () => recordCommitteeDecision({ tenantId: l.tenantId, actor: actor as never, applicationId, decision: { decision: "APPROVED", meetingDate: sastCalendarDate(new Date()), attendees: ["Synthetic Member"], conditions: [], rationale: "Considered the refinance" } }))
  let la: typeof holder.user
  let bm: typeof holder.user
  let recorder: typeof holder.user
  let admin: typeof holder.user
  /** Booked before the matrix: under it, a fixture application could not be approved. */
  let others: LoanFixture[]

  beforeAll(async () => {
    fresh = await createThrowawayDb({ instance: { jurisdiction: "LS", currency: "LSL" } })
    holder.prisma = createAppPrismaClient(fresh.url)
    l = await bookLoan(db())
    others = []
    for (let i = 0; i < 3; i++) others.push({ ...(await bookLoan(db(), { sameClientAs: l })), makerId: l.makerId, checkerId: l.checkerId })
    la = await staff(`u_la_${l.loanId}`, "LOAN_ADMIN")
    bm = await staff(`u_bm_${l.loanId}`, "BRANCH_MANAGER")
    recorder = await staff(`u_rc_${l.loanId}`, "ADMIN")
    admin = { id: l.checkerId, email: `${l.checkerId}@test.invalid`, role: "ADMIN", totpVerified: true }
    const superAdmin = await staff(`u_sa_${l.loanId}`, "SUPER_ADMIN")
    const maker = { id: recorder.id, email: recorder.email, role: "ADMIN", totpVerified: true }
    const matrix = {
      name: "Loan change matrix", enabled: true, effectiveFrom: "2026-01-01", defaultRequiredLevels: 3,
      levels: [
        { level: 1, name: "Loan admin", role: "LOAN_ADMIN", slaHours: 24, committee: false },
        { level: 2, name: "Branch manager", role: "BRANCH_MANAGER", slaHours: 24, committee: false },
        { level: 3, name: "Credit committee", role: "ADMIN", slaHours: 48, committee: true },
      ],
      rules: [],
    }
    await runWithTenant(l.tenantId, async () => {
      const draft = await createDraft({ tenantId: l.tenantId, actor: maker, kind: MATRIX_KIND, title: "Matrix", payload: matrix })
      await submit({ tenantId: l.tenantId, actor: maker, id: draft.id })
      await approve({ tenantId: l.tenantId, actor: superAdmin, id: draft.id })
    })
  }, 240_000)
  afterAll(() => fresh?.drop())

  it("a refinance waits for every level and the committee, then books; the loan does not move before the last", async () => {
    const { id } = await draftAndSubmit(l, { type: "REFINANCE", instalments: 12 })
    const pending = async () => (await db().changeRequest.findUniqueOrThrow({ where: { id } })).status
    const appOf = () => db().loanApplication.findFirstOrThrow({ where: { loanChangeRequestId: id } })

    expect((await approveAs({ ...la, id: l.makerId, email: `${l.makerId}@test.invalid` }, id)).status).toBe(403) // the maker holds no seat
    const first = await approveAs(la, id)
    expect(first.status).toBe(202)
    expect(((await first.json()) as { error: string }).error).toMatch(/Level 1 of 3/)
    expect(await pending()).toBe("SUBMITTED")
    expect((await appOf()).status).toBe("UNDER_REVIEW")
    expect((await db().loan.findUniqueOrThrow({ where: { id: l.loanId } })).status).toBe("ACTIVE")

    expect((await approveAs(la, id)).status).toBe(409) // one person, one seat
    expect((await approveAs(bm, id)).status).toBe(202)
    const noCommittee = await approveAs(admin, id)
    expect(noCommittee.status).toBe(409)
    expect(await pending()).toBe("SUBMITTED")

    await decideCommittee(recorder, (await appOf()).id)
    expect((await approveAs(admin, id)).status).toBe(200)
    expect(await pending()).toBe("APPROVED")
    const app = await appOf()
    expect(app).toMatchObject({ status: "DISBURSED", approvedById: l.checkerId, disbursedById: l.makerId })
    expect(await db().approvalStep.count({ where: { applicationId: app.id } })).toBe(3)
    expect((await db().approvalCase.findFirstOrThrow({ where: { applicationId: app.id } })).status).toBe("APPROVED")
    expect((await db().loan.findUniqueOrThrow({ where: { id: l.loanId } })).status).toBe("COMPLETED")
  })

  it("a rejected change cancels the application and closes its chain", async () => {
    const mine = others.pop()!
    const { id } = await draftAndSubmit(mine, { type: "REFINANCE", instalments: 12 })
    expect((await approveAs(la, id)).status).toBe(202)
    as(mine, "checker")
    expect((await actionRoute(req({ note: "Declined at committee" }), params({ id, action: "reject" }))).status).toBe(200)
    const app = await db().loanApplication.findFirstOrThrow({ where: { loanChangeRequestId: id } })
    expect(app.status).toBe("CANCELLED")
    expect((await db().approvalCase.findFirstOrThrow({ where: { applicationId: app.id } })).status).toBe("CLOSED")
    expect(await db().auditLog.count({ where: { tenantId: l.tenantId, action: "LOAN_CHANGE_APPLICATION_CLOSED", entityId: id } })).toBe(1)
  })

  it("a change in place keeps its one second person: the matrix governs new credit", async () => {
    const mine = others.pop()!
    const { id } = await draftAndSubmit(mine, { type: "RATE_CHANGE", interestRatePm: 0.03 })
    expect((await approveAs(admin, id)).status).toBe(200)
    expect(await db().loanApplication.count({ where: { loanChangeRequestId: id } })).toBe(0)
  })

  it("the database refuses to approve the application of an unfinished chain, or of a change not yet approved", async () => {
    const mine = others.pop()!
    const { id } = await draftAndSubmit(mine, { type: "REFINANCE", instalments: 12 })
    expect((await approveAs(la, id)).status).toBe(202)
    const app = await db().loanApplication.findFirstOrThrow({ where: { loanChangeRequestId: id } })
    await expect(db().loanApplication.update({ where: { id: app.id }, data: { status: "APPROVED", approvedAt: new Date(), approvedById: l.checkerId, repaymentMethod: "EFT" } })).rejects.toThrow(/only with its request/)
  })
})
