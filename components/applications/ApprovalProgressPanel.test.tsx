// @vitest-environment jsdom
// The chain shows each level and who approved it; the committee form appears only to someone at the committee's level, when it is the
// committee's turn; a refusal's reason is told to the viewer.
import { act, create } from "react-test-renderer"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ApprovalProgress } from "@/lib/approval/progress"
import { ApprovalProgressPanel } from "./ApprovalProgressPanel"

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }))
vi.mock("next/link", () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }))

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
afterEach(() => { delete actEnvironment.IS_REACT_ACT_ENVIRONMENT })
async function mount(element: React.ReactElement) {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  let renderer!: ReturnType<typeof create>
  await act(async () => { renderer = create(element) })
  return renderer
}
const text = (r: ReturnType<typeof create>) => JSON.stringify(r.toJSON())

const progress = (over: Partial<ApprovalProgress> = {}): ApprovalProgress => ({
  applies: true, caseId: "c1", status: "OPEN", matrixName: "Standard", matrixVersion: 2, requiredLevels: 3, requirementFrozen: true,
  matchedRules: [{ id: "big", name: "Large loans" }],
  levels: [
    { level: 1, name: "Loan admin", role: "LOAN_ADMIN", slaHours: 24, committee: false, state: "APPROVED", approvedBy: "Lerato", approvedAt: "2026-11-05T09:00:00Z", via: "ROLE", conditions: [] },
    { level: 2, name: "Branch manager", role: "BRANCH_MANAGER", slaHours: 24, committee: false, state: "APPROVED", approvedBy: "Thabo", approvedAt: "2026-11-05T10:00:00Z", via: "DELEGATION", conditions: [] },
    { level: 3, name: "Credit committee", role: "ADMIN", slaHours: 48, committee: true, state: "PENDING", approvedBy: null, approvedAt: null, via: null, conditions: [] },
  ],
  pendingLevel: 3, dueAt: "2026-11-07T10:00:00Z", overdue: false, escalationCount: 0, escalations: [], committeeDecisions: [],
  viewer: { authorityLevel: 3, canApprove: false, reason: null }, ...over,
})
const panel = (p: ApprovalProgress, canUseCommittee = true) => <ApprovalProgressPanel applicationId="a1" progress={p} canUseCommittee={canUseCommittee} today="2026-11-06" />

describe("ApprovalProgressPanel", () => {
  it("shows nothing where no matrix applies", async () => {
    const r = await mount(panel({ ...progress(), applies: false }))
    expect(r.toJSON()).toBeNull()
  })

  it("lists each level with who approved it, noting delegated authority, and why the requirement is what it is", async () => {
    const t = text(await mount(panel(progress())))
    expect(t).toContain("Loan admin")
    expect(t).toContain("Lerato")
    expect(t).toContain("(delegated authority)")
    expect(t).toContain("Large loans")
    expect(t).toContain("Credit committee")
  })

  it("offers the committee form to someone at the committee's level when it is the committee's turn, with a link to the pack", async () => {
    const r = await mount(panel(progress()))
    expect(r.root.findAll((n) => n.type === "textarea").length).toBeGreaterThanOrEqual(2)
    expect(r.root.findAll((n) => n.type === "a" && n.props.href === "/applications/a1/committee-pack")).toHaveLength(1)
  })

  it("withholds the committee form from a lower level, from someone without the committee permission, and when it is not the committee's turn", async () => {
    expect((await mount(panel(progress({ viewer: { authorityLevel: 2, canApprove: false, reason: null } })))).root.findAll((n) => n.type === "textarea")).toHaveLength(0)
    expect((await mount(panel(progress(), false))).root.findAll((n) => n.type === "textarea")).toHaveLength(0)
    const early = progress()
    early.levels[1] = { ...early.levels[1], state: "PENDING", approvedBy: null, approvedAt: null, via: null }
    early.levels[2] = { ...early.levels[2], state: "WAITING" }
    expect((await mount(panel(early))).root.findAll((n) => n.type === "textarea")).toHaveLength(0)
  })

  it("says why the viewer cannot approve the next level, and flags an overdue level", async () => {
    const t = text(await mount(panel(progress({ overdue: true, escalationCount: 2, viewer: { authorityLevel: 1, canApprove: false, reason: "Level 3 needs the ADMIN role." } }))))
    expect(t).toContain("You cannot approve the next level")
    expect(t).toContain("Level 3 needs the ADMIN role.")
    expect(t).toContain("overdue, escalated 2 times")
  })

  it("shows the committee's recorded decisions with their conditions", async () => {
    const t = text(await mount(panel(progress({ committeeDecisions: [{ id: "d1", decision: "APPROVED", meetingDate: "2026-11-05", attendees: ["A"], conditions: ["Employer letter"], rationale: "Strong file", recordedBy: "Ann", recordedAt: "2026-11-05T12:00:00Z" }] }))))
    expect(t).toContain("APPROVED")
    expect(t).toContain("Strong file")
    expect(t).toContain("1 condition")
  })
})
