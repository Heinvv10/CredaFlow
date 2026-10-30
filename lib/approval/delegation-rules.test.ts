import { describe, expect, it } from "vitest"
import { delegationProblems } from "./delegation-rules"
import type { MatrixLevel } from "./types"

const levels: MatrixLevel[] = [
  { level: 1, name: "Loan admin", role: "LOAN_ADMIN", slaHours: 24, committee: false },
  { level: 2, name: "Branch manager", role: "BRANCH_MANAGER", slaHours: 24, committee: false },
  { level: 3, name: "Credit committee", role: "ADMIN", slaHours: 48, committee: true },
]
const now = new Date("2026-11-05T08:00:00Z")
const ok = {
  delegatorRole: "BRANCH_MANAGER" as const, delegateRole: "LOAN_ADMIN" as const, levels, now,
  input: { delegatorId: "boss", delegateId: "me", level: 2, maxAmountCents: 2_000_000, validFrom: new Date("2026-11-06T00:00:00Z"), validTo: new Date("2026-11-20T00:00:00Z"), reason: "Away on leave from 6 to 20 November" },
}
const over = (o: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ ...ok, ...extra, input: { ...ok.input, ...o } })

describe("delegationProblems", () => {
  it("accepts a delegation within the delegator's own authority", () => {
    expect(delegationProblems(ok)).toEqual([])
  })
  it.each([
    ["a level above the delegator's own", over({ level: 3 }), /own level/],
    ["a level the matrix does not have", over({ level: 4 }, { delegatorRole: "SUPER_ADMIN" }), /level/],
    ["a delegator whose role holds no level", over({}, { delegatorRole: "CREDIT_OFFICER" }), /own level/],
    ["yourself", over({ delegateId: "boss" }), /yourself/],
    ["a delegate who cannot approve at all", over({}, { delegateRole: "CREDIT_OFFICER" }), /LOAN_ADMIN/],
    ["no amount", over({ maxAmountCents: 0 }), /amount/],
    ["a fractional amount", over({ maxAmountCents: 10.5 }), /amount/],
    ["an end before the start", over({ validTo: new Date("2026-11-05T00:00:00Z") }), /after/],
    ["an end already past", over({ validFrom: new Date("2026-11-01T00:00:00Z"), validTo: new Date("2026-11-04T00:00:00Z") }), /past/],
    ["a window over 90 days", over({ validTo: new Date("2027-03-01T00:00:00Z") }), /90 days/],
    ["a start more than a day in the past", over({ validFrom: new Date("2026-11-01T00:00:00Z") }), /start/],
    ["a reason that is too short", over({ reason: "leave" }), /reason/],
  ])("refuses %s", (_name, input, re) => {
    expect(delegationProblems(input).join(" | ")).toMatch(re)
  })
})
