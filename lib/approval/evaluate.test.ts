import { describe, expect, it } from "vitest"
import { authorityLevel, delegatedLevel, requiredLevelsFor, roleLevel } from "./evaluate"
import type { ApplicationFacts, Delegation, MatrixPayload } from "./types"

const matrix = (rules: MatrixPayload["rules"], defaultRequiredLevels = 1): MatrixPayload => ({
  name: "m", enabled: true, effectiveFrom: "2026-11-01", defaultRequiredLevels, rules,
  levels: [
    { level: 1, name: "Loan admin", role: "LOAN_ADMIN", slaHours: 24, committee: false },
    { level: 2, name: "Branch manager", role: "BRANCH_MANAGER", slaHours: 24, committee: false },
    { level: 3, name: "Credit committee", role: "ADMIN", slaHours: 48, committee: true },
  ],
})
const facts = (over: Partial<ApplicationFacts> = {}): ApplicationFacts => ({ amountCents: 1_000_000, productId: "p1", branchId: "b1", riskGradeRank: 1, ...over })
const rule = (id: string, when: MatrixPayload["rules"][number]["when"], requiredLevels: number) => ({ id, name: id, when, requiredLevels })

describe("requiredLevelsFor", () => {
  it("uses the default when no rule matches", () => {
    expect(requiredLevelsFor(matrix([rule("big", { amountMinCents: 9_000_000 }, 3)], 1), facts())).toEqual({ requiredLevels: 1, matchedRuleIds: [] })
  })
  it("takes the most demanding of the rules that match", () => {
    const m = matrix([rule("amt", { amountMinCents: 500_000 }, 2), rule("prod", { productIds: ["p1"] }, 3), rule("other", { productIds: ["p2"] }, 3)])
    expect(requiredLevelsFor(m, facts())).toEqual({ requiredLevels: 3, matchedRuleIds: ["amt", "prod"] })
  })
  it("an empty condition matches every application", () => {
    expect(requiredLevelsFor(matrix([rule("all", {}, 2)], 1), facts()).requiredLevels).toBe(2)
  })
  it("amount range: the minimum and maximum are both inclusive", () => {
    const m = matrix([rule("band", { amountMinCents: 1_000_000, amountMaxCents: 2_000_000 }, 2)], 1)
    expect(requiredLevelsFor(m, facts({ amountCents: 999_999 })).requiredLevels).toBe(1)
    expect(requiredLevelsFor(m, facts({ amountCents: 1_000_000 })).requiredLevels).toBe(2)
    expect(requiredLevelsFor(m, facts({ amountCents: 2_000_000 })).requiredLevels).toBe(2)
    expect(requiredLevelsFor(m, facts({ amountCents: 2_000_001 })).requiredLevels).toBe(1)
  })
  it("branch: an application with no branch never matches a branch rule", () => {
    const m = matrix([rule("b", { branchIds: ["b1"] }, 2)], 1)
    expect(requiredLevelsFor(m, facts()).requiredLevels).toBe(2)
    expect(requiredLevelsFor(m, facts({ branchId: "b9" })).requiredLevels).toBe(1)
    expect(requiredLevelsFor(m, facts({ branchId: null })).requiredLevels).toBe(1)
  })
  it("risk grade: this rank or worse; an ungraded application matches only a rule that says so", () => {
    const m = matrix([rule("risky", { riskGradeRankMin: 2 }, 3), rule("nograde", { ungraded: true }, 2)], 1)
    expect(requiredLevelsFor(m, facts({ riskGradeRank: 1 })).requiredLevels).toBe(1)
    expect(requiredLevelsFor(m, facts({ riskGradeRank: 2 })).requiredLevels).toBe(3)
    expect(requiredLevelsFor(m, facts({ riskGradeRank: 5 })).requiredLevels).toBe(3)
    expect(requiredLevelsFor(m, facts({ riskGradeRank: null })).requiredLevels).toBe(2)
    expect(requiredLevelsFor(matrix([rule("risky", { riskGradeRankMin: 2 }, 3)], 1), facts({ riskGradeRank: null })).requiredLevels).toBe(1)
  })
  it("conditions on one rule all have to hold", () => {
    const m = matrix([rule("both", { amountMinCents: 500_000, productIds: ["p2"] }, 3)], 1)
    expect(requiredLevelsFor(m, facts()).requiredLevels).toBe(1)
    expect(requiredLevelsFor(m, facts({ productId: "p2" })).requiredLevels).toBe(3)
  })
  it("a rule may require no staff approval at all", () => {
    expect(requiredLevelsFor(matrix([rule("small", { amountMaxCents: 1_500_000 }, 0)], 2), facts()).requiredLevels).toBe(0)
  })
})

describe("authority", () => {
  const levels = matrix([]).levels
  it("a role holds the highest level whose role it reaches; below the first level it holds none", () => {
    expect(roleLevel(levels, "CREDIT_OFFICER")).toBe(0)
    expect(roleLevel(levels, "LOAN_ADMIN")).toBe(1)
    expect(roleLevel(levels, "BRANCH_MANAGER")).toBe(2)
    expect(roleLevel(levels, "ADMIN")).toBe(3)
    expect(roleLevel(levels, "SUPER_ADMIN")).toBe(3)
  })
  const now = new Date("2026-11-05T10:00:00Z")
  const delegation = (over: Partial<Delegation> = {}): Delegation => ({
    id: "d1", delegatorId: "boss", delegateId: "me", level: 2, maxAmountCents: 2_000_000,
    validFrom: new Date("2026-11-01T00:00:00Z"), validTo: new Date("2026-11-10T00:00:00Z"), revokedAt: null, ...over,
  })
  it("a delegation gives its level up to its amount, inside its dates, until revoked", () => {
    expect(delegatedLevel([delegation()], 1_000_000, now)).toEqual({ level: 2, delegationId: "d1" })
    expect(delegatedLevel([delegation()], 2_000_000, now)?.level).toBe(2)
    expect(delegatedLevel([delegation()], 2_000_001, now)).toBeNull()
    expect(delegatedLevel([delegation({ validFrom: new Date("2026-11-06T00:00:00Z") })], 1, now)).toBeNull()
    expect(delegatedLevel([delegation({ validTo: new Date("2026-11-05T09:59:59Z") })], 1, now)).toBeNull()
    expect(delegatedLevel([delegation({ revokedAt: new Date("2026-11-04T00:00:00Z") })], 1, now)).toBeNull()
  })
  it("the highest of several delegations wins, and a delegator who has since lost the level can no longer pass it on", () => {
    const two = [delegation({ id: "a", level: 1 }), delegation({ id: "b", level: 3 })]
    expect(delegatedLevel(two, 1, now)?.delegationId).toBe("b")
    expect(delegatedLevel(two, 1, now, { boss: 1 })).toEqual({ level: 1, delegationId: "a" })
    expect(delegatedLevel(two, 1, now, { boss: 0 })).toBeNull()
  })
  it("authority is the higher of the role's level and the delegated one, and says which it came from", () => {
    expect(authorityLevel({ role: "LOAN_ADMIN", levels, delegations: [delegation()], amountCents: 1, now })).toMatchObject({ level: 2, via: "DELEGATION", delegationId: "d1" })
    expect(authorityLevel({ role: "BRANCH_MANAGER", levels, delegations: [delegation({ level: 1 })], amountCents: 1, now })).toMatchObject({ level: 2, via: "ROLE" })
    expect(authorityLevel({ role: "CREDIT_OFFICER", levels, delegations: [], amountCents: 1, now })).toMatchObject({ level: 0, via: "ROLE" })
  })
})
