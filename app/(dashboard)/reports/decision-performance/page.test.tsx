import { renderToStaticMarkup } from "react-dom/server"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { DecisionPerformance } from "@/lib/learning-loop/dashboard/loader"
import { tally } from "@/lib/learning-loop/dashboard/cells"
import { approvalCohorts, cohortTotals, overrideComparison } from "@/lib/learning-loop/dashboard/cohorts"
import { arrangementOutcomes } from "@/lib/learning-loop/dashboard/collections"
import { declineVolume } from "@/lib/learning-loop/dashboard/offers-declines"
import { canDo } from "@/lib/permissions"
import { UserRole } from "@prisma/client"

const { state } = vi.hoisted(() => ({
  state: { role: "ADMIN", tenantId: "tenant-a", featureReports: true as boolean | undefined, load: vi.fn() },
}))
vi.mock("next/navigation", () => ({
  redirect: (to: string) => { throw new Error(`REDIRECT:${to}`) },
  notFound: () => { throw new Error("NOT_FOUND") },
}))
// The real permission map (canDo); only the session is stubbed.
vi.mock("@/lib/auth-guards", async () => {
  const { canDo } = await import("@/lib/permissions")
  return { canDo, NO_ACCESS_PAGE: "/no-access", requireMinRole: vi.fn(async () => ({ id: "u1", role: state.role, tenantId: state.tenantId })) }
})
vi.mock("@/lib/session-tenant", () => ({ getStaffTenantId: vi.fn(async () => state.tenantId) }))
vi.mock("@/lib/tenant", () => ({
  getTenantConfig: vi.fn(async () => (state.featureReports === undefined ? null : { featureReports: state.featureReports })),
}))
vi.mock("@/lib/prisma", () => ({ prisma: {} }))
vi.mock("@/lib/learning-loop/dashboard/loader", () => ({ loadDecisionPerformance: (...a: unknown[]) => state.load(...a) }))

import DecisionPerformancePage from "./page"

const row = (value: boolean) => [{ outcomeKind: "EVER_90_DPD", window: "12M", state: "OBSERVED" as const, value, reasonCode: null }]
const approvals = Array.from({ length: 3 }, (_, i) => ({
  decisionRecordId: `d${i}`, cohortMonth: "2026-03", ruleVersion: "decision-log-v1+approval-ndi-v3", policyHash: "c".repeat(64),
  scoreBand: "630-679", overridden: false, product: "MICRO", outcomes: row(i === 0),
}))
const data = (demoData = false): DecisionPerformance => ({
  demoData, window: "12M", since: "2024-10", approvals: approvals.length, totals: cohortTotals(approvals, "12M"),
  cohorts: approvalCohorts(approvals, "12M"), overrides: overrideComparison(approvals, "12M"),
  takeUp: [{ month: "2026-03", decision: "APPROVED_TERMS", offers: 3, small: true, takeUp: tally([[], [], []], "TAKEN_UP", "OFFER") }],
  declines: declineVolume([
    { month: "2026-03", category: "AFFORDABILITY", actorType: "STAFF", refusalReason: null, s71ReviewRequired: false },
    { month: "2026-03", category: null, actorType: "SYSTEM", refusalReason: "client_blacklisted", s71ReviewRequired: true },
    { month: "2026-03", category: null, actorType: "SYSTEM", refusalReason: "own_lender_arrears", s71ReviewRequired: true },
  ]),
  stages: [], arrangements: arrangementOutcomes({ KEPT: 1 }),
  book: { scope: "ALL", chargesLive: false, book: { count: 0, value: 0 }, arrears: { count: 0, amount: 0, outstandingPrincipal: 0 },
    chargesOnly: { count: 0, amount: 0 }, ageing: [], par30: { count: 0, value: 0, pct: 0 }, par60: { count: 0, value: 0, pct: 0 },
    par90: { count: 4, value: 1, pct: 2.5 } },
})
const render = async (window?: string) =>
  renderToStaticMarkup(await DecisionPerformancePage({ searchParams: Promise.resolve({ window }) }))
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")

describe("Decision performance page", () => {
  beforeEach(() => {
    Object.assign(state, { role: "ADMIN", tenantId: "tenant-a", featureReports: true })
    state.load.mockReset().mockResolvedValue(data())
  })

  // Decision 2 (21 Oct 2026): ADMIN (the compliance role; there is no COMPLIANCE role) and SUPER_ADMIN only.
  it("grants view_decision_performance to ADMIN and SUPER_ADMIN and to no other role", () => {
    expect(Object.values(UserRole).filter((role) => canDo(role, "view_decision_performance")).sort()).toEqual(["ADMIN", "SUPER_ADMIN"])
  })

  it.each(["LOAN_ADMIN", "BRANCH_MANAGER", "CREDIT_OFFICER", "COLLECTIONS_OFFICER", "COLLECTIONS_AGENT", "INSURANCE_OFFICER",
    "READONLY", "CLIENT", "OPERATOR_ADMIN", "OPERATOR_SUPPORT"])(
    "sends %s to the no-access page and reads nothing", async (role) => {
      state.role = role
      await expect(render()).rejects.toThrow("REDIRECT:/no-access")
      expect(state.load).not.toHaveBeenCalled()
    })

  it("is not found, and reads nothing, when the lender's reports feature is off or unconfigured", async () => {
    for (const flag of [false, undefined]) {
      state.featureReports = flag
      await expect(render()).rejects.toThrow("NOT_FOUND")
    }
    expect(state.load).not.toHaveBeenCalled()
  })

  it("reads only the signed-in user's own tenant, for ADMIN and SUPER_ADMIN", async () => {
    for (const role of ["ADMIN", "SUPER_ADMIN"]) {
      state.role = role
      state.tenantId = `tenant-${role}`
      await render()
      expect(state.load).toHaveBeenLastCalledWith({}, `tenant-${role}`, expect.any(Date), "12M")
    }
  })

  it("passes a known window through and ignores anything else", async () => {
    await render("6M")
    expect(state.load).toHaveBeenLastCalledWith({}, "tenant-a", expect.any(Date), "6M")
    await render("24M; drop")
    expect(state.load).toHaveBeenLastCalledWith({}, "tenant-a", expect.any(Date), "12M")
  })

  it("labels demo data, the collections panel as descriptive, and makes no learning or AI claim", async () => {
    const html = await render()
    const t = text(html)
    expect(t).toContain("Until a lender has 6 to 12 months of loans on book, these figures can only be checked on demo or simulator data")
    expect(t).toContain("Descriptive, not causal")
    expect(t).toContain("Declined applicants have no observable repayment")
    expect(t).toContain("POPIA s71: lender legal review required before go-live")
    expect(t).toMatch(/Automated refusals recorded: 2 \(2 flagged for the lender(&#x27;|')s legal review\)/)
    expect(t).toContain("Blacklisted 1")
    expect(t).toContain("Settled after 30+ DPD")
    expect(t).toContain("settling after 30+ DPD is shown separately and is not a cure")
    expect(t).toContain("90+ DPD in the book now 4")
    expect(t).not.toMatch(/\blearn|\bAI\b|machine|predict/i)
    // 3 loans < 20: greyed, counts still shown.
    expect(html).toContain('data-small="true"')
    expect(t).toContain("(few loans)")
    // The cohort table's own column header, not any mention in the panel text.
    expect(html).toMatch(/<th[^>]*>Not yet computed<\/th>/)
    // The arrangements line carries the marker like the tables do.
    expect(html).toMatch(/<p[^>]*data-small="true"[^>]*>1 arrangements:[^]*\(few loans\)<\/span><\/p>/)
    expect(t).toContain("Decisions from Oct 2024 on.")
    expect(t).toContain("33.3% 1/3")
  })

  it("is read-only: no form, button or input on the page", async () => {
    const html = await render()
    expect(html).not.toMatch(/<form|<button|<input|<textarea|<select/i)
  })

  it("labels a demo lender's figures as simulated / demo data, and a real lender's not", async () => {
    expect(text(await render())).not.toContain("Simulated / demo data")
    state.load.mockResolvedValue(data(true))
    const html = await render()
    expect(html).toContain('data-demo-data="true"')
    expect(text(html)).toContain("Simulated / demo data. This is a synthetic demo lender")
  })
})
