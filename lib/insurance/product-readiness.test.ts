import { describe, expect, it } from "vitest"
import { InsuredLifeType } from "@prisma/client"
import type { RateBasis } from "@prisma/client"
import { rateLife } from "./rating/rate-quote"
import { INSURED_LIFE_TYPES, canSellProduct } from "./product-readiness"
import { evaluate, type EligibilityRuleInput } from "./eligibility/evaluate"

const AT = new Date("2026-08-15T00:00:00Z")
const PARAMS = { tenantId: "tenant-1", productId: "product-1", at: AT }

/**
 * A band per life type. It has to be all four: the ALL_LIVES rules below screen
 * every life type, and readiness refuses to call a product sellable when a life
 * it screens has no band to price it against. The single MAIN_MEMBER band this
 * fixture used to hold was the defect — it made these cases assert
 * `sellable: true` for a product on which three of the four life types quoted
 * NO_MATCHING_BAND.
 */
const BANDS = [
  { id: "band-1", lifeType: "MAIN_MEMBER", minAge: 18, maxAge: 35, sumAssured: "10000.00", premiumAmount: "42.50" },
  { id: "band-2", lifeType: "SPOUSE", minAge: 18, maxAge: 35, sumAssured: "10000.00", premiumAmount: "38.00" },
  { id: "band-3", lifeType: "CHILD", minAge: 0, maxAge: 21, sumAssured: "10000.00", premiumAmount: "12.25" },
  { id: "band-4", lifeType: "EXTENDED_FAMILY", minAge: 18, maxAge: 75, sumAssured: "10000.00", premiumAmount: "61.00" },
]

const ACTIVE_TABLE = {
  id: "rt-1",
  version: 1,
  name: "2026 funeral",
  basis: "AGE_BANDED",
  effectiveFrom: AT,
  effectiveTo: null,
  insurerId: "ins-1",
  bands: BANDS,
}

const ALL_MANDATORY_RULES = [
  { id: "r1", lifeScope: "ALL_LIVES", ruleType: "MIN_ENTRY_AGE", numericValue: "18", textValue: null, active: true },
  { id: "r2", lifeScope: "ALL_LIVES", ruleType: "MAX_ENTRY_AGE", numericValue: "65", textValue: null, active: true },
  { id: "r3", lifeScope: "ALL_LIVES", ruleType: "MAX_COVER", numericValue: "50000.00", textValue: null, active: true },
  { id: "r4", lifeScope: "ALL_LIVES", ruleType: "WAITING_PERIOD_DAYS", numericValue: "180", textValue: null, active: true },
]

/**
 * `loadEligibilityRules` filters on `active: true` in the QUERY, so a stub that
 * returns rows is standing in for rows the database already filtered. To
 * exercise "deactivated rule blocks the product" honestly, the stub must
 * respect `where.active` rather than hand back everything.
 */
function reader(options: {
  tables?: unknown[]
  rules?: { id: string; lifeScope: string; ruleType: string; numericValue: string | null; textValue: null; active: boolean }[]
  throwOn?: "tables" | "rules"
}) {
  return {
    insuranceRateTable: {
      findMany: async () => {
        if (options.throwOn === "tables") throw new Error("connection reset")
        return options.tables ?? []
      },
    },
    insuranceEligibilityRule: {
      findMany: async (args: { where: { active?: boolean } }) => {
        if (options.throwOn === "rules") throw new Error("connection reset")
        const rules = options.rules ?? []
        return args.where.active === true ? rules.filter((rule) => rule.active) : rules
      },
    },
  } as never
}

describe("canSellProduct", () => {
  it("is sellable only with one in-force banded rate table and every mandatory rule", async () => {
    const result = await canSellProduct(reader({ tables: [ACTIVE_TABLE], rules: ALL_MANDATORY_RULES }), PARAMS)
    expect(result).toEqual({ sellable: true, reasons: [] })
  })

  it("refuses a product with no rate table and no rules at all — the default state", async () => {
    const result = await canSellProduct(reader({}), PARAMS)
    expect(result.sellable).toBe(false)
    expect(result.reasons).toHaveLength(5) // no table, plus each of the four mandatory rules
  })

  it("refuses a product whose ACTIVE rate table has no bands", async () => {
    const result = await canSellProduct(
      reader({ tables: [{ ...ACTIVE_TABLE, bands: [] }], rules: ALL_MANDATORY_RULES }),
      PARAMS,
    )
    expect(result.sellable).toBe(false)
    expect(result.reasons.join(" ")).toMatch(/no bands/)
  })

  it("refuses a product with two rate tables in force rather than picking one", async () => {
    const result = await canSellProduct(
      reader({ tables: [ACTIVE_TABLE, { ...ACTIVE_TABLE, id: "rt-2" }], rules: ALL_MANDATORY_RULES }),
      PARAMS,
    )
    expect(result.sellable).toBe(false)
    expect(result.reasons.join(" ")).toMatch(/2 ACTIVE rate tables/)
  })

  it("refuses the product when any single mandatory rule is missing", async () => {
    for (const missing of ["MIN_ENTRY_AGE", "MAX_ENTRY_AGE", "MAX_COVER", "WAITING_PERIOD_DAYS"]) {
      const result = await canSellProduct(
        reader({ tables: [ACTIVE_TABLE], rules: ALL_MANDATORY_RULES.filter((r) => r.ruleType !== missing) }),
        PARAMS,
      )
      expect(result.sellable, `${missing} missing must block the sale`).toBe(false)
      expect(result.reasons).toContain(`Mandatory eligibility rule ${missing} is not configured`)
    }
  })

  it("refuses the product when a mandatory rule exists but carries no value", async () => {
    const rules = ALL_MANDATORY_RULES.map((r) => (r.ruleType === "MAX_COVER" ? { ...r, numericValue: null } : r))
    const result = await canSellProduct(reader({ tables: [ACTIVE_TABLE], rules }), PARAMS)
    expect(result.sellable).toBe(false)
    expect(result.reasons).toContain("Mandatory eligibility rule MAX_COVER is not configured")
  })

  it("refuses the product when a mandatory rule has been deactivated", async () => {
    const rules = ALL_MANDATORY_RULES.map((r) => (r.ruleType === "WAITING_PERIOD_DAYS" ? { ...r, active: false } : r))
    const result = await canSellProduct(reader({ tables: [ACTIVE_TABLE], rules }), PARAMS)
    expect(result.sellable).toBe(false)
    expect(result.reasons).toContain("Mandatory eligibility rule WAITING_PERIOD_DAYS is not configured")
  })

  it("fails closed when the rate table lookup throws", async () => {
    const result = await canSellProduct(reader({ throwOn: "tables", rules: ALL_MANDATORY_RULES }), PARAMS)
    expect(result.sellable).toBe(false)
    expect(result.reasons.join(" ")).toMatch(/connection reset/)
  })

  it("fails closed when the eligibility rule lookup throws", async () => {
    const result = await canSellProduct(reader({ tables: [ACTIVE_TABLE], throwOn: "rules" }), PARAMS)
    expect(result.sellable).toBe(false)
    expect(result.reasons.join(" ")).toMatch(/connection reset/)
  })

  it("never reports sellable with reasons attached", async () => {
    const result = await canSellProduct(reader({ tables: [ACTIVE_TABLE], rules: ALL_MANDATORY_RULES.slice(1) }), PARAMS)
    expect(result.sellable).toBe(false)
    expect(result.reasons.length).toBeGreaterThan(0)
  })
})

describe("canSellProduct — scope resolution must agree with evaluate()", () => {
  // The defect: readiness counted a mandatory rule as configured if ANY row of
  // that type carried a value, ignoring lifeScope, while evaluate() resolves
  // per life with fallback only to ALL_LIVES. A product whose only MAX_COVER
  // row was CHILD-scoped therefore reported sellable with no reasons, while
  // every MAIN_MEMBER life screened NOT_CONFIGURED against the same rules.
  // Both now go through the same resolveRule, so they cannot disagree.
  const AT_TYPES: InsuredLifeType[] = ["MAIN_MEMBER", "SPOUSE", "CHILD", "EXTENDED_FAMILY"]

  it("refuses a product whose only MAX_COVER row is CHILD-scoped", async () => {
    const rules = ALL_MANDATORY_RULES.map((r) => (r.ruleType === "MAX_COVER" ? { ...r, lifeScope: "CHILD" } : r))
    const result = await canSellProduct(reader({ tables: [ACTIVE_TABLE], rules }), PARAMS)
    expect(result.sellable).toBe(false)
    expect(result.reasons.join(" ")).toMatch(/MAX_COVER/)
  })

  it("agrees with evaluate: every life type readiness declares screenable really is", async () => {
    // The cross-check that makes drift impossible to reintroduce quietly. For a
    // rule set readiness calls sellable, no life of any type may produce a
    // NOT_CONFIGURED or RULE_VALUE_MISSING failure from evaluate.
    const rules = ALL_MANDATORY_RULES.map((r) => (r.ruleType === "MAX_COVER" ? { ...r, lifeScope: "CHILD" } : r))
    const readiness = await canSellProduct(reader({ tables: [ACTIVE_TABLE], rules }), PARAMS)

    const configFailures = AT_TYPES.flatMap((lifeType) =>
      evaluate({
        rules: rules as unknown as EligibilityRuleInput[],
        lives: [{ ref: lifeType, lifeType, dateOfBirth: new Date("2010-01-01T00:00:00Z"), sumAssured: "5000.00" }],
        effectiveDate: AT,
      }).failures.filter((f) => f.code === "NOT_CONFIGURED" || f.code === "RULE_VALUE_MISSING"),
    )

    expect(configFailures.length).toBeGreaterThan(0)
    expect(readiness.sellable, "evaluate cannot screen this product, so readiness must not sell it").toBe(false)
  })

  it("accepts full per-life-type coverage with no ALL_LIVES row at all", async () => {
    // The inverse: scoping is not itself a fault. A rule captured once per life
    // type resolves for every life, so it is configured.
    const rules = ([
      ...ALL_MANDATORY_RULES.filter((r) => r.ruleType !== "MAX_COVER"),
      ...AT_TYPES.map((lifeScope) => ({
        id: `mc-${lifeScope}`,
        lifeScope,
        ruleType: "MAX_COVER",
        numericValue: "50000.00",
        textValue: null,
        active: true,
      })),
    ] as typeof ALL_MANDATORY_RULES)
    const result = await canSellProduct(reader({ tables: [ACTIVE_TABLE], rules }), PARAMS)
    expect(result).toEqual({ sellable: true, reasons: [] })
  })

  it("refuses a product whose ALL_LIVES row is overridden by a valueless scoped row", async () => {
    // Same fail-closed rule evaluate applies: an active row with no value
    // cannot screen, and must not be read as the ALL_LIVES limit instead.
    const rules = ([
      ...ALL_MANDATORY_RULES,
      { id: "mc-spouse-null", lifeScope: "SPOUSE", ruleType: "MAX_COVER", numericValue: null, textValue: null, active: true },
    ] as typeof ALL_MANDATORY_RULES)
    const result = await canSellProduct(reader({ tables: [ACTIVE_TABLE], rules }), PARAMS)
    expect(result.sellable).toBe(false)
    expect(result.reasons.join(" ")).toMatch(/MAX_COVER/)
  })

  it("names every insured life type the schema defines", () => {
    expect([...INSURED_LIFE_TYPES].sort()).toEqual(Object.values(InsuredLifeType).sort())
  })
})

// SELLABLE HAS TO MEAN QUOTABLE. Readiness screened the eligibility RULES per
// life type and never looked at the BANDS: a card with one MAIN_MEMBER band
// plus complete ALL_LIVES rules reported `{ sellable: true, reasons: [] }`
// while a SPOUSE quote against the same product returned NO_MATCHING_BAND.
// `resolveActiveRateTable` only asserts the card has SOME band, which that one
// did.
describe("canSellProduct — a life type it screens must be one the card can price", () => {
  const ALL_LIFE_TYPE_BANDS = INSURED_LIFE_TYPES.map((lifeType, i) => ({
    id: `band-${lifeType}`,
    lifeType,
    minAge: 18,
    maxAge: 65,
    sumAssured: "10000.00",
    premiumAmount: `${40 + i}.00`,
  }))

  it("refuses a product whose ALL_LIVES rules screen a life the card cannot price", async () => {
    const result = await canSellProduct(
      reader({
        tables: [{ ...ACTIVE_TABLE, bands: [ALL_LIFE_TYPE_BANDS[0]] }],
        rules: ALL_MANDATORY_RULES,
      }),
      PARAMS,
    )

    expect(result.sellable).toBe(false)
    // Named, so the operator knows which bands to capture.
    expect(result.reasons.join(" ")).toMatch(/SPOUSE/)
    expect(result.reasons.join(" ")).toMatch(/CHILD/)
    expect(result.reasons.join(" ")).toMatch(/EXTENDED_FAMILY/)
    expect(result.reasons.join(" ")).not.toMatch(/MAIN_MEMBER/)
  })

  it("refuses a MAIN_MEMBER-only product on the RULES, and so never reaches the band check", async () => {
    // Unchanged pre-existing rule, stated here because it is what bounds the
    // band check: a mandatory rule must resolve for EVERY life type, so a card
    // scoped to one life type is already unsellable on its rules. There is
    // therefore no sellable product with fewer than four screenable life types,
    // and the band requirement below is "a band for every life type" in
    // practice.
    const rules = ALL_MANDATORY_RULES.map((r) => ({ ...r, lifeScope: "MAIN_MEMBER" }))
    const result = await canSellProduct(
      reader({ tables: [{ ...ACTIVE_TABLE, bands: [ALL_LIFE_TYPE_BANDS[0]] }], rules }),
      PARAMS,
    )

    expect(result.sellable).toBe(false)
    expect(result.reasons.join(" ")).toMatch(/not configured for SPOUSE/)
    // The unscreenable types are not ALSO reported as unpriceable — one product
    // fault, not four.
    expect(result.reasons.join(" ")).not.toMatch(/cannot be priced/)
  })

  it("sells a card carrying a band for every life type its ALL_LIVES rules screen", async () => {
    const result = await canSellProduct(
      reader({ tables: [{ ...ACTIVE_TABLE, bands: ALL_LIFE_TYPE_BANDS }], rules: ALL_MANDATORY_RULES }),
      PARAMS,
    )

    expect(result).toEqual({ sellable: true, reasons: [] })
  })

  it("agrees with rateQuote: every life type it declares sellable really prices", async () => {
    // The cross-check that makes drift impossible to reintroduce quietly.
    const table = { ...ACTIVE_TABLE, bands: ALL_LIFE_TYPE_BANDS }
    const readiness = await canSellProduct(reader({ tables: [table], rules: ALL_MANDATORY_RULES }), PARAMS)
    expect(readiness.sellable).toBe(true)

    for (const lifeType of INSURED_LIFE_TYPES) {
      expect(
        rateLife(table.bands, table.basis as RateBasis, lifeType, 30, "10000.00"),
        `${lifeType} must price on a card readiness called sellable`,
      ).toMatchObject({ ok: true })
    }
  })

  it("does not report an unpriceable life type that is already unscreenable", async () => {
    // A life type with no rules is already blocked by the rule reasons; adding
    // a band reason for it would just be noise about the same product.
    const rules = ALL_MANDATORY_RULES.map((r) => (r.ruleType === "MAX_COVER" ? { ...r, lifeScope: "MAIN_MEMBER" } : r))
    const result = await canSellProduct(
      reader({ tables: [{ ...ACTIVE_TABLE, bands: [ALL_LIFE_TYPE_BANDS[0]] }], rules }),
      PARAMS,
    )

    expect(result.sellable).toBe(false)
    expect(result.reasons.join(" ")).not.toMatch(/cannot be priced/)
  })
})
