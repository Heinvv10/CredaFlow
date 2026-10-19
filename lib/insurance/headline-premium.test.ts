import { describe, expect, it } from "vitest"
import { activeEligibilityRulesForProductsFindManyArgs } from "./eligibility/rules"
import { activeRateTableFindManyArgs } from "./rating/rate-table"
import { headlineForTable, headlineRateTablesFindManyArgs, loadHeadlines } from "./headline-premium"

const AT = new Date("2026-10-19T08:00:00Z")
let n = 0
const band = (lifeType: string, minAge: number, maxAge: number, sumAssured: string, premiumAmount: string) =>
  ({ id: `b${++n}`, lifeType, minAge, maxAge, sumAssured, premiumAmount }) as never

const rule = (ruleType: string, lifeScope: string, numericValue: number, productId = "rated") =>
  ({ id: `r${++n}`, productId, ruleType, lifeScope, numericValue, active: true }) as never
const RULES = [
  rule("MIN_ENTRY_AGE", "ALL_LIVES", 18), rule("MAX_ENTRY_AGE", "ALL_LIVES", 64),
  rule("MAX_COVER", "ALL_LIVES", 30_000), rule("WAITING_PERIOD_DAYS", "ALL_LIVES", 90),
]

/** Bands for the other life types, so the card is sellable by the draft gate's own readiness. */
const OTHERS = () => [
  band("SPOUSE", 18, 39, "10000.00", "58.00"), band("CHILD", 0, 21, "5000.00", "12.00"), band("EXTENDED_FAMILY", 18, 64, "5000.00", "34.00"),
]
const FUNERAL = [
  band("MAIN_MEMBER", 18, 39, "10000.00", "62.00"), band("MAIN_MEMBER", 18, 39, "20000.00", "118.00"),
  band("MAIN_MEMBER", 40, 54, "20000.00", "171.00"), ...OTHERS(),
]

const table = (basis: string, bands: unknown[]) => ({ basis, bands }) as never

describe("headlineForTable", () => {
  it("is the cheapest MAIN_MEMBER price, with the cover of that same band, not a cheaper CHILD band", () => {
    expect(headlineForTable(table("AGE_BANDED", FUNERAL), RULES, AT)).toEqual({ kind: "from", premiumCents: 6200, coverCents: 1_000_000 })
  })

  it("never returns another band's cover", () => {
    const bands = [band("MAIN_MEMBER", 18, 39, "20000.00", "171.00"), band("MAIN_MEMBER", 18, 39, "10000.00", "62.00"), band("MAIN_MEMBER", 18, 39, "30000.00", "249.00"), ...OTHERS()]
    expect(headlineForTable(table("AGE_BANDED", bands), RULES, AT)).toMatchObject({ coverCents: 1_000_000 })
  })

  it("prices PER_MILLE as rate x cover / 1000, never the raw rate", () => {
    // R6.20 per R1 000 on a R10 000 band is R62.00.
    const bands = [band("MAIN_MEMBER", 18, 64, "10000.00", "6.20"), ...OTHERS().map((b) => ({ ...(b as object), id: `pm${++n}` }) as never)]
    const h = headlineForTable(table("PER_MILLE", bands), RULES, AT)
    expect(h).toEqual({ kind: "from", premiumCents: 6200, coverCents: 1_000_000 })
  })

  it("ignores bands with a premium of zero or less", () => {
    const bands = [band("MAIN_MEMBER", 18, 39, "10000.00", "0.00"), band("MAIN_MEMBER", 18, 39, "20000.00", "118.00"), ...OTHERS()]
    expect(headlineForTable(table("AGE_BANDED", bands), RULES, AT)).toMatchObject({ premiumCents: 11800 })
  })

  it("says 'quote' when no main-member band is usable, instead of the flat price", () => {
    expect(headlineForTable(table("AGE_BANDED", OTHERS()), RULES, AT)).toEqual({ kind: "quote" })
    expect(headlineForTable(table("AGE_BANDED", []), RULES, AT)).toEqual({ kind: "quote" })
    expect(headlineForTable(table("AGE_BANDED", [band("MAIN_MEMBER", 18, 39, "10000.00", "0.00"), ...OTHERS()]), RULES, AT)).toEqual({ kind: "quote" })
  })

  it("skips a band the insurer's eligibility rules would refuse (cover above MAX_COVER)", () => {
    const bands = [band("MAIN_MEMBER", 18, 39, "50000.00", "10.00"), band("MAIN_MEMBER", 18, 39, "20000.00", "118.00"), ...OTHERS()]
    expect(headlineForTable(table("AGE_BANDED", bands), RULES, AT)).toMatchObject({ premiumCents: 11800 })
  })

  it("says 'quote' when mandatory eligibility rules are unconfigured, as quoting would refuse", () => {
    expect(headlineForTable(table("AGE_BANDED", FUNERAL), [], AT)).toEqual({ kind: "quote" })
  })

  it("says 'quote' for an unsellable table: a screenable life type with no band (readiness gate)", () => {
    const noSpouse = FUNERAL.filter((b) => (b as unknown as { lifeType: string }).lifeType !== "SPOUSE")
    expect(headlineForTable(table("AGE_BANDED", noSpouse), RULES, AT)).toEqual({ kind: "quote" })
  })

  it("skips child-age-only main-member bands", () => {
    expect(headlineForTable(table("AGE_BANDED", [band("MAIN_MEMBER", 0, 17, "10000.00", "5.00"), ...OTHERS()]), RULES, AT)).toEqual({ kind: "quote" })
  })

  it("probes at the insurer's MIN_ENTRY_AGE: a 21+ rule does not drop the 18-39 band", () => {
    const rules = [rule("MIN_ENTRY_AGE", "MAIN_MEMBER", 21), ...RULES] // scoped row overrides ALL_LIVES
    // At age 18 the 21+ rule would refuse; probing at 21 keeps the band.
    expect(headlineForTable(table("AGE_BANDED", FUNERAL), rules, AT)).toMatchObject({ kind: "from", premiumCents: 6200 })
  })
})

describe("query args", () => {
  it("rate tables share quoting's where-clause: tenant, ACTIVE, in force at the date", () => {
    const mine = headlineRateTablesFindManyArgs("t1", ["p1"], AT).where
    const quoting = activeRateTableFindManyArgs({ tenantId: "t1", productId: "p1", at: AT }).where
    expect({ ...mine, productId: "p1" }).toEqual(quoting)
    expect(mine).toMatchObject({ tenantId: "t1", status: "ACTIVE", effectiveFrom: { lte: AT }, productId: { in: ["p1"] } })
  })

  it("eligibility rules are one tenant-scoped, active, batched query", () => {
    expect(activeEligibilityRulesForProductsFindManyArgs("t1", ["a", "b"]).where).toEqual({
      tenantId: "t1", productId: { in: ["a", "b"] }, active: true,
    })
  })
})

describe("loadHeadlines", () => {
  function reader(tables: unknown[], rules: unknown[]) {
    const tableCalls: unknown[] = []
    const ruleCalls: unknown[] = []
    return {
      tableCalls,
      ruleCalls,
      prisma: {
        insuranceRateTable: { findMany: async (args: unknown) => { tableCalls.push(args); return tables } },
        insuranceEligibilityRule: { findMany: async (args: unknown) => { ruleCalls.push(args); return rules } },
      } as never,
    }
  }

  it("batches both queries and maps flat / from / quote per product", async () => {
    const { prisma, tableCalls, ruleCalls } = reader(
      [
        { productId: "rated", basis: "AGE_BANDED", bands: FUNERAL },
        { productId: "dup", basis: "AGE_BANDED", bands: FUNERAL },
        { productId: "dup", basis: "AGE_BANDED", bands: FUNERAL },
      ],
      [...RULES, ...RULES.map((r) => ({ ...(r as object), productId: "dup", id: `d${++n}` }))],
    )
    const m = await loadHeadlines(
      prisma, "t1",
      [{ id: "rated", type: "FUNERAL_COVER" }, { id: "dup", type: "FUNERAL_COVER" }, { id: "plain", type: "SHORT_TERM_MOTOR" }],
      AT,
    )
    expect(tableCalls).toHaveLength(1)
    expect(ruleCalls).toEqual([activeEligibilityRulesForProductsFindManyArgs("t1", ["rated", "dup", "plain"])])
    expect(tableCalls[0]).toMatchObject({ where: { tenantId: "t1", status: "ACTIVE", effectiveFrom: { lte: AT }, productId: { in: ["rated", "dup", "plain"] } } })
    expect(m.get("rated")).toEqual({ kind: "from", premiumCents: 6200, coverCents: 1_000_000 })
    expect(m.get("dup")).toEqual({ kind: "quote" }) // AMBIGUOUS_ACTIVE_TABLES
    expect(m.get("plain")).toEqual({ kind: "flat" })
  })

  it("a rated type with no in-force table is 'quote', not the flat price (PRODUCT_NOT_SELLABLE)", async () => {
    const { prisma } = reader([], [])
    const m = await loadHeadlines(prisma, "t1", [{ id: "f", type: "FUNERAL_COVER" }, { id: "l", type: "LIFE_INSURANCE" }, { id: "c", type: "CREDIT_LIFE" }], AT)
    expect(m.get("f")).toEqual({ kind: "quote" })
    expect(m.get("l")).toEqual({ kind: "quote" })
    expect(m.get("c")).toEqual({ kind: "flat" })
  })
})
