import { describe, expect, it } from "vitest"
import { EligibilityRuleType } from "@prisma/client"
import {
  ALL_RULE_TYPES,
  MANDATORY_RULE_TYPES,
  PER_LIFE_RULE_TYPES,
  PRODUCT_LEVEL_RULE_TYPES,
  evaluate,
  type EligibilityLifeInput,
  type EligibilityRuleInput,
} from "./evaluate"

const EFFECTIVE_DATE = new Date("2026-08-15T00:00:00Z")

function rule(partial: Partial<EligibilityRuleInput> & Pick<EligibilityRuleInput, "ruleType">): EligibilityRuleInput {
  return {
    id: `${partial.ruleType}-${partial.lifeScope ?? "ALL_LIVES"}`,
    lifeScope: "ALL_LIVES",
    numericValue: null,
    textValue: null,
    active: true,
    ...partial,
  }
}

/** A complete, insurer-plausible rule set: every mandatory type configured. */
const CONFIGURED_RULES: EligibilityRuleInput[] = [
  rule({ ruleType: "MIN_ENTRY_AGE", numericValue: "18" }),
  rule({ ruleType: "MAX_ENTRY_AGE", numericValue: "65" }),
  rule({ ruleType: "MAX_COVER", numericValue: "50000.00" }),
  rule({ ruleType: "WAITING_PERIOD_DAYS", numericValue: "180" }),
  // Life-type overrides, so a child is not screened against the adult limits.
  rule({ ruleType: "MIN_ENTRY_AGE", lifeScope: "CHILD", numericValue: "0" }),
  rule({ ruleType: "MAX_ENTRY_AGE", lifeScope: "CHILD", numericValue: "21" }),
  rule({ ruleType: "MAX_COVER", lifeScope: "CHILD", numericValue: "10000.00" }),
  rule({ ruleType: "WAITING_PERIOD_DAYS", lifeScope: "CHILD", numericValue: "90" }),
]

const MAIN: EligibilityLifeInput = {
  ref: "main",
  lifeType: "MAIN_MEMBER",
  dateOfBirth: new Date("1986-01-10T00:00:00Z"), // 40 at the effective date
  sumAssured: "25000.00",
}
const CHILD: EligibilityLifeInput = {
  ref: "child-1",
  lifeType: "CHILD",
  dateOfBirth: new Date("2016-07-04T00:00:00Z"), // 10
  sumAssured: "5000.00",
}

function run(rules: EligibilityRuleInput[], lives: EligibilityLifeInput[]) {
  return evaluate({ rules, lives, effectiveDate: EFFECTIVE_DATE })
}

describe("evaluate — the fully configured happy path", () => {
  it("passes a main member and a child inside every configured limit", () => {
    const result = run(CONFIGURED_RULES, [MAIN, CHILD])
    expect(result.failures).toEqual([])
    expect(result.pass).toBe(true)
  })
})

describe("evaluate — absent configuration must never read as eligible", () => {
  it("declares the mandatory rule types explicitly", () => {
    expect([...MANDATORY_RULE_TYPES].sort()).toEqual(["MAX_COVER", "MAX_ENTRY_AGE", "MIN_ENTRY_AGE", "WAITING_PERIOD_DAYS"])
  })

  it("fails an unconfigured product with a NOT_CONFIGURED failure per mandatory rule type", () => {
    const result = run([], [MAIN])
    expect(result.pass).toBe(false)
    expect(result.failures.map((f) => f.ruleType).sort()).toEqual(
      ["MAX_COVER", "MAX_ENTRY_AGE", "MIN_ENTRY_AGE", "WAITING_PERIOD_DAYS"],
    )
    expect(result.failures.every((f) => f.code === "NOT_CONFIGURED")).toBe(true)
  })

  it("fails when a single mandatory rule type is missing, even if the rest are configured", () => {
    for (const missing of MANDATORY_RULE_TYPES) {
      const rules = CONFIGURED_RULES.filter((r) => r.ruleType !== missing)
      const result = run(rules, [MAIN, CHILD])
      expect(result.pass, `${missing} missing must not pass`).toBe(false)
      expect(result.failures.some((f) => f.code === "NOT_CONFIGURED" && f.ruleType === missing)).toBe(true)
    }
  })

  it("treats a deactivated mandatory rule as not configured", () => {
    // An `active: false` row is configuration history, not a live term. If it
    // satisfied the mandatory check, deactivating a rule would silently widen
    // acceptance instead of closing the product.
    const rules = CONFIGURED_RULES.map((r) =>
      r.ruleType === "MAX_COVER" ? { ...r, active: false } : r,
    )
    const result = run(rules, [MAIN, CHILD])
    expect(result.pass).toBe(false)
    expect(result.failures.some((f) => f.code === "NOT_CONFIGURED" && f.ruleType === "MAX_COVER")).toBe(true)
  })

  it("treats a mandatory rule configured with a null value as unusable, not as absent-and-fine", () => {
    const rules = CONFIGURED_RULES.map((r) =>
      r.ruleType === "MAX_ENTRY_AGE" && r.lifeScope === "ALL_LIVES" ? { ...r, numericValue: null } : r,
    )
    const result = run(rules, [MAIN])
    expect(result.pass).toBe(false)
    expect(result.failures.some((f) => f.code === "RULE_VALUE_MISSING" && f.ruleType === "MAX_ENTRY_AGE")).toBe(true)
  })

  it("names the life a NOT_CONFIGURED failure applies to", () => {
    const rules = CONFIGURED_RULES.filter((r) => !(r.ruleType === "MAX_COVER" && r.lifeScope === "CHILD"))
      .filter((r) => !(r.ruleType === "MAX_COVER" && r.lifeScope === "ALL_LIVES"))
    const result = run(rules, [CHILD])
    expect(result.failures).toContainEqual(
      expect.objectContaining({ code: "NOT_CONFIGURED", ruleType: "MAX_COVER", lifeType: "CHILD", lifeRef: "child-1" }),
    )
  })

  it("fails a quote with no lives rather than passing a vacuously compliant one", () => {
    const result = run(CONFIGURED_RULES, [])
    expect(result.pass).toBe(false)
    expect(result.failures).toContainEqual(expect.objectContaining({ code: "NO_LIVES" }))
  })
})

describe("evaluate — a valueless ACTIVE rule must never weaken the screen", () => {
  // The defect this covers: resolveRule preferred a life-type-scoped row over
  // ALL_LIVES without checking it carried a value, and every caller then
  // short-circuited on the null. Adding a row therefore DISABLED the limit the
  // product already had. Adding configuration must never make screening weaker,
  // so a valueless active row is a failure for every rule type, not a pass.
  const ALL_RULE_TYPES_UNDER_TEST = [
    "MIN_ENTRY_AGE",
    "MAX_ENTRY_AGE",
    "MIN_COVER",
    "MAX_COVER",
    "WAITING_PERIOD_DAYS",
    "COOLING_OFF_DAYS",
  ] as const

  it("fails a life under a MIN_COVER whose scoped override carries no value", () => {
    const rules = [
      ...CONFIGURED_RULES,
      rule({ ruleType: "MIN_COVER", numericValue: "10000.00" }),
      rule({ ruleType: "MIN_COVER", lifeScope: "MAIN_MEMBER", numericValue: null }),
    ]
    // R1.00 of cover against an ALL_LIVES minimum of R10 000.
    const result = run(rules, [{ ...MAIN, sumAssured: "1.00" }])
    expect(result.pass).toBe(false)
    expect(result.failures).toContainEqual(
      expect.objectContaining({ code: "RULE_VALUE_MISSING", ruleType: "MIN_COVER", lifeType: "MAIN_MEMBER" }),
    )
  })

  it("fails on a valueless scoped override of ANY rule type, not only the mandatory four", () => {
    for (const ruleType of ALL_RULE_TYPES_UNDER_TEST) {
      const rules = [...CONFIGURED_RULES, rule({ ruleType, lifeScope: "MAIN_MEMBER", numericValue: null })]
      const result = run(rules, [MAIN])
      expect(result.pass, `a valueless ${ruleType} override must not pass`).toBe(false)
      expect(result.failures).toContainEqual(
        expect.objectContaining({ code: "RULE_VALUE_MISSING", ruleType, ruleId: `${ruleType}-MAIN_MEMBER` }),
      )
    }
  })

  it("fails a valueless MAX_LIVES_OF_TYPE rather than dropping the count limit", () => {
    const rules = [
      ...CONFIGURED_RULES,
      rule({ ruleType: "MAX_LIVES_OF_TYPE", numericValue: "1" }),
      rule({ ruleType: "MAX_LIVES_OF_TYPE", lifeScope: "CHILD", numericValue: null }),
    ]
    const result = run(rules, [CHILD, { ...CHILD, ref: "child-2" }, { ...CHILD, ref: "child-3" }])
    expect(result.pass).toBe(false)
    expect(result.failures).toContainEqual(
      expect.objectContaining({ code: "RULE_VALUE_MISSING", ruleType: "MAX_LIVES_OF_TYPE", lifeType: "CHILD" }),
    )
  })

  it("fails a valueless MAX_TOTAL_COVER rather than dropping the aggregate limit", () => {
    const rules = [...CONFIGURED_RULES, rule({ ruleType: "MAX_TOTAL_COVER", numericValue: null })]
    const result = run(rules, [MAIN, CHILD])
    expect(result.pass).toBe(false)
    expect(result.failures).toContainEqual(
      expect.objectContaining({ code: "RULE_VALUE_MISSING", ruleType: "MAX_TOTAL_COVER" }),
    )
  })

  it("still ignores a DEACTIVATED valueless row and falls back to ALL_LIVES", () => {
    // The inverse control: only an ACTIVE valueless row blocks. An inactive one
    // is configuration history and must not fail an otherwise sound product.
    const rules = [
      ...CONFIGURED_RULES,
      rule({ ruleType: "MIN_COVER", numericValue: "1000.00" }),
      { ...rule({ ruleType: "MIN_COVER", lifeScope: "MAIN_MEMBER", numericValue: null }), active: false },
    ]
    expect(run(rules, [MAIN]).failures).toEqual([])
  })
})

describe("evaluate — invalid data is a typed failure, never a throw", () => {
  // EvaluateResult promises a result, so evaluate must be total. Before this,
  // ageAtDate and toCents were called outside any try: a date of birth after
  // the effective date, or a non-numeric sum assured, threw out of the screen
  // and left the caller with an exception where a Failure was declared.
  it("returns INVALID_VALUE for a date of birth after the effective date", () => {
    const unborn = { ...MAIN, ref: "unborn", dateOfBirth: new Date("2027-01-01T00:00:00Z") }
    let result: ReturnType<typeof run>
    expect(() => {
      result = run(CONFIGURED_RULES, [unborn])
    }).not.toThrow()
    expect(result!.pass).toBe(false)
    expect(result!.failures).toContainEqual(
      expect.objectContaining({ code: "INVALID_VALUE", lifeRef: "unborn" }),
    )
  })

  it("returns INVALID_VALUE for a sum assured that is not a rand amount", () => {
    const garbled = { ...MAIN, ref: "garbled", sumAssured: "abc" }
    expect(() => run(CONFIGURED_RULES, [garbled])).not.toThrow()
    const result = run(CONFIGURED_RULES, [garbled])
    expect(result.pass).toBe(false)
    expect(result.failures).toContainEqual(
      expect.objectContaining({ code: "INVALID_VALUE", lifeRef: "garbled" }),
    )
  })

  it("returns INVALID_VALUE for a configured limit that is not a number", () => {
    const rules = CONFIGURED_RULES.map((r) =>
      r.ruleType === "MAX_COVER" && r.lifeScope === "ALL_LIVES" ? { ...r, numericValue: "not-a-number" } : r,
    )
    expect(() => run(rules, [MAIN])).not.toThrow()
    const result = run(rules, [MAIN])
    expect(result.pass).toBe(false)
    expect(result.failures).toContainEqual(
      expect.objectContaining({ code: "INVALID_VALUE", ruleType: "MAX_COVER" }),
    )
  })

})

describe("evaluate — the screened rule-type catalogue", () => {
  it("screens every EligibilityRuleType the schema defines", () => {
    // ALL_RULE_TYPES is hand-written so this module stays pure of the generated
    // client at runtime. That makes it driftable: a ninth enum value added to
    // the schema would otherwise be screened by nobody, and — being unscreened
    // — could never raise RULE_VALUE_MISSING either. Compared against the real
    // enum here so the drift fails loudly instead.
    expect([...ALL_RULE_TYPES].sort()).toEqual(Object.values(EligibilityRuleType).sort())
  })

  it("partitions every rule type into per-life or product-level, with no overlap", () => {
    expect([...PER_LIFE_RULE_TYPES, ...PRODUCT_LEVEL_RULE_TYPES].sort()).toEqual([...ALL_RULE_TYPES].sort())
    expect(PER_LIFE_RULE_TYPES.filter((t) => (PRODUCT_LEVEL_RULE_TYPES as readonly string[]).includes(t))).toEqual([])
  })
})

describe("evaluate — age screening", () => {
  it("fails a life below the minimum entry age and reports the limit and the value", () => {
    const seventeen = { ...MAIN, ref: "young", dateOfBirth: new Date("2009-01-01T00:00:00Z") }
    const result = run(CONFIGURED_RULES, [seventeen])
    expect(result.failures).toContainEqual(
      expect.objectContaining({ code: "MIN_ENTRY_AGE", lifeRef: "young", limit: "18", value: "17" }),
    )
  })

  it("fails a life above the maximum entry age", () => {
    const sixtySix = { ...MAIN, ref: "old", dateOfBirth: new Date("1960-01-01T00:00:00Z") }
    expect(run(CONFIGURED_RULES, [sixtySix]).failures).toContainEqual(
      expect.objectContaining({ code: "MAX_ENTRY_AGE", limit: "65", value: "66" }),
    )
  })

  it("accepts exactly the minimum and exactly the maximum entry age", () => {
    const exactlyEighteen = { ...MAIN, ref: "min", dateOfBirth: new Date("2008-08-15T00:00:00Z") }
    const exactlySixtyFive = { ...MAIN, ref: "max", dateOfBirth: new Date("1961-08-15T00:00:00Z") }
    expect(run(CONFIGURED_RULES, [exactlyEighteen]).failures).toEqual([])
    expect(run(CONFIGURED_RULES, [exactlySixtyFive]).failures).toEqual([])
  })

  it("derives age from the caller's effective date, not from today", () => {
    const dayBeforeEighteenth = { ...MAIN, ref: "eve", dateOfBirth: new Date("2008-08-16T00:00:00Z") }
    expect(run(CONFIGURED_RULES, [dayBeforeEighteenth]).pass).toBe(false)
    const oneDayLater = evaluate({
      rules: CONFIGURED_RULES,
      lives: [dayBeforeEighteenth],
      effectiveDate: new Date("2026-08-16T00:00:00Z"),
    })
    expect(oneDayLater.pass).toBe(true)
  })
})

describe("evaluate — scope resolution", () => {
  it("applies the life-type rule in preference to ALL_LIVES for that type", () => {
    // The child is 10: outside the ALL_LIVES 18..65, inside the CHILD 0..21.
    expect(run(CONFIGURED_RULES, [CHILD]).pass).toBe(true)
  })

  it("still applies ALL_LIVES to a life type with no override", () => {
    const spouseAtSeventy = {
      ref: "spouse",
      lifeType: "SPOUSE" as const,
      dateOfBirth: new Date("1956-01-01T00:00:00Z"),
      sumAssured: "10000.00",
    }
    expect(run(CONFIGURED_RULES, [spouseAtSeventy]).failures).toContainEqual(
      expect.objectContaining({ code: "MAX_ENTRY_AGE", lifeRef: "spouse", limit: "65" }),
    )
  })

  it("does not let a life-type override for one type leak onto another", () => {
    // CHILD's MAX_COVER of 10 000 must not cap the main member's 25 000.
    expect(run(CONFIGURED_RULES, [MAIN]).failures).toEqual([])
  })

  it("ignores an inactive override and falls back to the active ALL_LIVES rule", () => {
    const rules = CONFIGURED_RULES.map((r) =>
      r.ruleType === "MIN_ENTRY_AGE" && r.lifeScope === "CHILD" ? { ...r, active: false } : r,
    )
    // The child is 10, so the ALL_LIVES minimum of 18 now bites.
    expect(run(rules, [CHILD]).failures).toContainEqual(
      expect.objectContaining({ code: "MIN_ENTRY_AGE", lifeRef: "child-1" }),
    )
  })
})

describe("evaluate — cover screening", () => {
  it("fails a life whose cover exceeds its MAX_COVER", () => {
    const overCovered = { ...CHILD, sumAssured: "12000.00" }
    expect(run(CONFIGURED_RULES, [overCovered]).failures).toContainEqual(
      expect.objectContaining({ code: "MAX_COVER", lifeRef: "child-1", limit: "10000.00", value: "12000.00" }),
    )
  })

  it("accepts cover exactly at the maximum", () => {
    expect(run(CONFIGURED_RULES, [{ ...CHILD, sumAssured: "10000.00" }]).failures).toEqual([])
  })

  it("fails a life below a configured MIN_COVER", () => {
    const rules = [...CONFIGURED_RULES, rule({ ruleType: "MIN_COVER", numericValue: "5000.00" })]
    expect(run(rules, [{ ...CHILD, sumAssured: "1000.00" }]).failures).toContainEqual(
      expect.objectContaining({ code: "MIN_COVER", limit: "5000.00", value: "1000.00" }),
    )
  })

  it("fails the aggregate cover of the lives against MAX_TOTAL_COVER", () => {
    const rules = [...CONFIGURED_RULES, rule({ ruleType: "MAX_TOTAL_COVER", numericValue: "20000.00" })]
    // MAIN is covered for 25 000 and CHILD for 5 000: 30 000 against a 20 000 cap.
    const result = run(rules, [MAIN, CHILD])
    expect(result.failures).toContainEqual(
      expect.objectContaining({ code: "MAX_TOTAL_COVER", limit: "20000.00", value: "30000.00", lifeRef: null }),
    )
  })

  it("derives the aggregate from the lives, so no caller can declare a smaller total", () => {
    // The defect this replaces: MAX_TOTAL_COVER screened a free parameter the
    // caller supplied. A caller that passed "0.00" alongside 30 000 of lives
    // sailed through a 20 000 cap. There is now no such parameter to pass —
    // the same lives must fail on the total they actually add up to.
    const rules = [...CONFIGURED_RULES, rule({ ruleType: "MAX_TOTAL_COVER", numericValue: "20000.00" })]
    const result = evaluate({ rules, lives: [MAIN, CHILD], effectiveDate: EFFECTIVE_DATE })
    expect(result.pass).toBe(false)
    expect(result.failures).toContainEqual(expect.objectContaining({ code: "MAX_TOTAL_COVER", value: "30000.00" }))
  })

  it("compares cover in exact cents, so a single cent over the limit still fails", () => {
    const rules = [...CONFIGURED_RULES, rule({ ruleType: "MAX_TOTAL_COVER", numericValue: "20000.00" })]
    const atLimit = run(rules, [{ ...MAIN, sumAssured: "20000.00" }])
    const overLimit = run(rules, [{ ...MAIN, sumAssured: "20000.01" }])
    expect(atLimit.failures).toEqual([])
    expect(overLimit.failures).toContainEqual(expect.objectContaining({ code: "MAX_TOTAL_COVER" }))
  })
})

describe("evaluate — life counts", () => {
  it("fails when more lives of a type are added than MAX_LIVES_OF_TYPE allows", () => {
    const rules = [...CONFIGURED_RULES, rule({ ruleType: "MAX_LIVES_OF_TYPE", lifeScope: "CHILD", numericValue: "2" })]
    const children = [CHILD, { ...CHILD, ref: "child-2" }, { ...CHILD, ref: "child-3" }]
    const result = run(rules, children)
    expect(result.failures).toContainEqual(
      expect.objectContaining({ code: "MAX_LIVES_OF_TYPE", lifeType: "CHILD", limit: "2", value: "3" }),
    )
  })

  it("accepts exactly the maximum number of lives of a type", () => {
    const rules = [...CONFIGURED_RULES, rule({ ruleType: "MAX_LIVES_OF_TYPE", lifeScope: "CHILD", numericValue: "2" })]
    const result = run(rules, [CHILD, { ...CHILD, ref: "child-2" }])
    expect(result.failures).toEqual([])
  })
})

describe("evaluate — reporting", () => {
  it("collects every failure rather than stopping at the first", () => {
    const tooOldAndOverCovered = { ...MAIN, ref: "both", dateOfBirth: new Date("1950-01-01T00:00:00Z"), sumAssured: "60000.00" }
    const codes = run(CONFIGURED_RULES, [tooOldAndOverCovered]).failures.map((f) => f.code)
    expect(codes).toContain("MAX_ENTRY_AGE")
    expect(codes).toContain("MAX_COVER")
  })

  it("names the rule that produced each failure, so the evidence is auditable", () => {
    const sixtySix = { ...MAIN, ref: "old", dateOfBirth: new Date("1960-01-01T00:00:00Z") }
    expect(run(CONFIGURED_RULES, [sixtySix]).failures).toContainEqual(
      expect.objectContaining({ ruleId: "MAX_ENTRY_AGE-ALL_LIVES", lifeScope: "ALL_LIVES" }),
    )
  })
})

// `evaluate` is typed TOTAL: EvaluateResult promises a result, so bad data is a
// failure code and never a throw. The MAX_TOTAL_COVER aggregate was accumulated
// with a bare `+=`, bypassing addCents' safe-integer check, so a large enough
// pair of lives threw `Cents value … is not a safe integer` straight out of the
// function. It needs about R90tn, so it is a contract violation rather than an
// exploit — but a total function that throws is not total.
describe("evaluate — the aggregate cover cannot throw out of a total function", () => {
  const HUGE = "46000000000000.00"

  it("returns INVALID_VALUE rather than throwing when the lives' cover overflows exact cents", () => {
    let result: ReturnType<typeof evaluate>
    expect(() => {
      result = evaluate({
        rules: [...CONFIGURED_RULES, rule({ ruleType: "MAX_TOTAL_COVER", numericValue: "1000" })],
        lives: [
          { ref: "a", lifeType: "MAIN_MEMBER", dateOfBirth: new Date("1990-01-01T00:00:00Z"), sumAssured: HUGE },
          { ref: "b", lifeType: "MAIN_MEMBER", dateOfBirth: new Date("1990-01-01T00:00:00Z"), sumAssured: HUGE },
        ],
        effectiveDate: EFFECTIVE_DATE,
      })
    }).not.toThrow()

    expect(result!.pass).toBe(false)
    expect(result!.failures.some((f) => f.code === "INVALID_VALUE")).toBe(true)
  })

  it("still screens an aggregate that fits, so the guard did not simply stop counting", () => {
    const result = evaluate({
      rules: [...CONFIGURED_RULES, rule({ ruleType: "MAX_TOTAL_COVER", numericValue: "15000.00" })],
      lives: [
        { ref: "a", lifeType: "MAIN_MEMBER", dateOfBirth: new Date("1990-01-01T00:00:00Z"), sumAssured: "10000.00" },
        { ref: "b", lifeType: "MAIN_MEMBER", dateOfBirth: new Date("1990-01-01T00:00:00Z"), sumAssured: "10000.00" },
      ],
      effectiveDate: EFFECTIVE_DATE,
    })

    expect(result.failures.map((f) => f.code)).toContain("MAX_TOTAL_COVER")
  })
})

// A MAX_TOTAL_COVER row scoped to a life type stored, displayed as configured,
// and screened NOTHING: the product-level check resolved it with
// `lifeType: null`, which asks only for the ALL_LIVES row. An insurer limit
// that is captured and then ignored is the silent-pass failure this module
// exists to avoid, so the scope is now honoured — a scoped row caps the
// aggregate cover of the lives OF THAT TYPE.
describe("evaluate — a life-type-scoped MAX_TOTAL_COVER screens the lives of that type", () => {
  const lives: EligibilityLifeInput[] = [
    { ref: "c1", lifeType: "CHILD", dateOfBirth: new Date("2015-01-01T00:00:00Z"), sumAssured: "6000.00" },
    { ref: "c2", lifeType: "CHILD", dateOfBirth: new Date("2016-01-01T00:00:00Z"), sumAssured: "6000.00" },
    { ref: "main", lifeType: "MAIN_MEMBER", dateOfBirth: new Date("1990-01-01T00:00:00Z"), sumAssured: "20000.00" },
  ]

  it("breaches a CHILD-scoped cap that only the children's cover exceeds", () => {
    const result = evaluate({
      rules: [...CONFIGURED_RULES, rule({ ruleType: "MAX_TOTAL_COVER", lifeScope: "CHILD", numericValue: "10000.00" })],
      lives,
      effectiveDate: EFFECTIVE_DATE,
    })

    const failure = result.failures.find((f) => f.code === "MAX_TOTAL_COVER")
    expect(failure).toBeDefined()
    expect(failure!.lifeType).toBe("CHILD")
    expect(failure!.lifeScope).toBe("CHILD")
    // R12 000 of child cover against a R10 000 child cap — NOT the R32 000 total.
    expect(failure!.value).toBe("12000.00")
  })

  it("passes a CHILD-scoped cap the children stay under, even though the total is larger", () => {
    const result = evaluate({
      rules: [...CONFIGURED_RULES, rule({ ruleType: "MAX_TOTAL_COVER", lifeScope: "CHILD", numericValue: "20000.00" })],
      lives,
      effectiveDate: EFFECTIVE_DATE,
    })

    expect(result.failures.filter((f) => f.code === "MAX_TOTAL_COVER")).toEqual([])
  })

  it("does not let an ALL_LIVES cap be re-applied per life type", () => {
    // A subtotal never exceeds the total, so an ALL_LIVES row must screen the
    // aggregate ONCE. Reporting it again per life type would be noise.
    const result = evaluate({
      rules: [...CONFIGURED_RULES, rule({ ruleType: "MAX_TOTAL_COVER", numericValue: "1000.00" })],
      lives,
      effectiveDate: EFFECTIVE_DATE,
    })

    expect(result.failures.filter((f) => f.code === "MAX_TOTAL_COVER")).toHaveLength(1)
    expect(result.failures.find((f) => f.code === "MAX_TOTAL_COVER")!.lifeType).toBeNull()
  })

  it("reports a scoped row that carries no value rather than falling back to ALL_LIVES", () => {
    const result = evaluate({
      rules: [
        ...CONFIGURED_RULES,
        rule({ ruleType: "MAX_TOTAL_COVER", numericValue: "100000.00" }),
        rule({ ruleType: "MAX_TOTAL_COVER", lifeScope: "CHILD", numericValue: null }),
      ],
      lives,
      effectiveDate: EFFECTIVE_DATE,
    })

    const missing = result.failures.find((f) => f.code === "RULE_VALUE_MISSING" && f.ruleType === "MAX_TOTAL_COVER")
    expect(missing).toBeDefined()
    expect(missing!.lifeType).toBe("CHILD")
  })
})
