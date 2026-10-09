// The bind is where a quote becomes money owed, so the assertions here are
// about what CANNOT happen: a price arriving from anywhere but the quote, a
// quote binding twice, a policy without the FAIS columns its CHECK constraint
// demands, or lives left PENDING beside an ACTIVE policy.

import { beforeEach, describe, expect, it, vi } from "vitest"
import { signDraftToken } from "../disclosure-token"
import { bindQuote, policyNumberPrefix, waitingPeriodEndsFor } from "./bind"

const START = new Date("2026-09-01T00:00:00Z")

/** A Decimal-alike, since bind reads `.toFixed(2)` off the quote's columns. */
function decimal(value: string) {
  return { toFixed: (dp: number) => Number(value).toFixed(dp) }
}

/**
 * The four MANDATORY rule types plus the waiting period. All five are needed
 * now that the bind RE-SCREENS: a fixture carrying only the waiting period
 * would fail `evaluate` as unconfigured and every bind would refuse, which
 * would look like a broken bind rather than a deliberately thin fixture.
 */
const RULES = [
  { id: "r-min-age", lifeScope: "ALL_LIVES" as const, ruleType: "MIN_ENTRY_AGE" as const, numericValue: "18", textValue: null, active: true },
  { id: "r-max-age", lifeScope: "ALL_LIVES" as const, ruleType: "MAX_ENTRY_AGE" as const, numericValue: "75", textValue: null, active: true },
  { id: "r-max-cover", lifeScope: "ALL_LIVES" as const, ruleType: "MAX_COVER" as const, numericValue: "10000", textValue: null, active: true },
  { id: "r-wait", lifeScope: "ALL_LIVES" as const, ruleType: "WAITING_PERIOD_DAYS" as const, numericValue: "180", textValue: null, active: true },
]

const QUOTE = {
  id: "quote-1",
  expiresAt: null as Date | null,
  clientId: "client-1",
  productId: "product-1",
  advisorId: "advisor-1" as string | null,
  status: "ACCEPTED" as const,
  totalPremium: decimal("83.00"),
  totalSumAssured: decimal("20000.00"),
  convertedPolicyId: null as string | null,
  adviceRecord: { id: "advice-1" } as { id: string } | null,
  product: { id: "product-1", type: "FUNERAL_COVER" as const, commissionRate: 0.15 },
  effectiveDate: new Date("2026-08-16T00:00:00Z"),
  lives: [
    { id: "life-1", lifeType: "MAIN_MEMBER" as const, dateOfBirth: new Date("1990-05-10T00:00:00Z"), sumAssured: "10000.00" },
    { id: "life-2", lifeType: "SPOUSE" as const, dateOfBirth: new Date("1988-03-01T00:00:00Z"), sumAssured: "10000.00" },
  ],
}

/** A token whose figures are the QUOTE's figures — what the client was shown. */
function tokenFor(overrides: Partial<{ premiumAmount: number; sumAssured: number; clientId: string; productId: string | null; tenantId: string; type: string; quoteId: string | null }> = {}) {
  return signDraftToken({
    // The bind requires the token to name THIS quote, so every fixture token
    // carries it. `quoteId: null` is how a LEGACY single-life token looks.
    quoteId: overrides.quoteId === undefined ? "quote-1" : overrides.quoteId,
    tenantId: overrides.tenantId ?? "tenant-1",
    clientId: overrides.clientId ?? "client-1",
    advisorId: "advisor-1",
    type: overrides.type ?? "FUNERAL_COVER",
    sumAssured: overrides.sumAssured ?? 20000,
    premiumAmount: overrides.premiumAmount ?? 83,
    productId: overrides.productId === undefined ? "product-1" : overrides.productId,
  })
}

interface StoreOptions {
  quote?: typeof QUOTE | null
  replayedPolicy?: { id: string } | null
  convertedCount?: number
  rules?: unknown[]
}

function makeStore({ quote = QUOTE, replayedPolicy = null, convertedCount = 1, rules = RULES }: StoreOptions = {}) {
  const policyCreates: { data: Record<string, unknown> }[] = []
  const premiumSchedules: { data: Record<string, unknown>[] }[] = []
  const commissions: { data: Record<string, unknown> }[] = []
  const lifeUpdates: { where: Record<string, unknown>; data: Record<string, unknown> }[] = []
  const quoteUpdates: { where: Record<string, unknown>; data: Record<string, unknown> }[] = []

  const tx = {
    insurancePolicy: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        policyCreates.push(args)
        return { id: "policy-1", policyNumber: args.data.policyNumber as string }
      }),
    },
    premiumPayment: {
      createMany: vi.fn(async (args: { data: Record<string, unknown>[] }) => {
        premiumSchedules.push(args)
        return { count: args.data.length }
      }),
    },
    advisorCommission: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        commissions.push(args)
        return { id: "comm-1" }
      }),
    },
    insuredLife: {
      update: vi.fn(async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        lifeUpdates.push(args)
        return { id: args.where.id }
      }),
    },
    insuranceQuote: {
      updateMany: vi.fn(async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        quoteUpdates.push(args)
        return { count: convertedCount }
      }),
    },
  }

  return {
    policyCreates,
    premiumSchedules,
    commissions,
    lifeUpdates,
    quoteUpdates,
    tx,
    prisma: {
      insuranceQuote: { findFirst: async () => quote },
      insurancePolicy: {
        findUnique: async () => replayedPolicy,
        count: async () => 7,
      },
      insuranceEligibilityRule: { findMany: async () => rules },
      $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
    } as never,
  }
}

const NOW = new Date("2026-08-20T00:00:00Z")
const BASE = { tenantId: "tenant-1", quoteId: "quote-1", startDate: START, now: NOW }

beforeEach(() => {
  process.env.NEXTAUTH_SECRET = "test-secret-do-not-use-in-prod-1234567890abcdef"
})

describe("bindQuote — the price comes from the QUOTE", () => {
  it("writes the quote's premium and sum assured onto the policy", async () => {
    const store = makeStore()
    const result = await bindQuote(store.prisma, { ...BASE, draftToken: tokenFor() })

    expect(result).toMatchObject({ ok: true, premiumAmount: "83.00", sumAssured: "20000.00" })
    expect(store.policyCreates[0].data).toMatchObject({
      premiumAmount: "83.00",
      sumAssured: "20000.00",
    })
  })

  it("takes NO premium parameter at all — there is no channel for a caller's figure", () => {
    // The strongest form of the guarantee is structural: `bindQuote` accepts a
    // quote id, a token, a start date and a user. If a premium cannot be named,
    // it cannot be honoured.
    const params = { tenantId: "", quoteId: "", draftToken: "", startDate: START, boundById: null }
    expect(Object.keys(params).sort()).toEqual(
      ["boundById", "draftToken", "quoteId", "startDate", "tenantId"]
    )
  })

  it("refuses a token minted for a DIFFERENT premium than the quote holds", async () => {
    // The disclosure the client signed must carry the quote's own figures.
    const store = makeStore()
    const result = await bindQuote(store.prisma, { ...BASE, draftToken: tokenFor({ premiumAmount: 50 }) })

    expect(result).toMatchObject({ ok: false, reason: "TOKEN_MISMATCH" })
    expect(store.policyCreates).toHaveLength(0)
  })

  it("refuses a token minted for a different sum assured", async () => {
    const store = makeStore()
    const result = await bindQuote(store.prisma, { ...BASE, draftToken: tokenFor({ sumAssured: 999999 }) })
    expect(result).toMatchObject({ ok: false, reason: "TOKEN_MISMATCH" })
  })

  it("refuses a token minted for a different client", async () => {
    const store = makeStore()
    const result = await bindQuote(store.prisma, { ...BASE, draftToken: tokenFor({ clientId: "someone-else" }) })
    expect(result).toMatchObject({ ok: false, reason: "TOKEN_MISMATCH" })
  })

  it("refuses to bind a quote carrying no premium", async () => {
    const store = makeStore({
      quote: { ...QUOTE, totalPremium: null as never, totalSumAssured: null as never },
    })
    const result = await bindQuote(store.prisma, { ...BASE, draftToken: tokenFor() })

    expect(result).toMatchObject({ ok: false, reason: "NOT_PRICED" })
    expect(store.policyCreates).toHaveLength(0)
  })
})

describe("bindQuote — the STANDALONE CHECK constraint is satisfied, not sidestepped", () => {
  it("populates all three columns the constraint requires", async () => {
    // CHECK InsurancePolicy_standalone_fais_required: policySource <>
    // 'STANDALONE' OR (faisDisclosureAt IS NOT NULL AND faisDisclosurePdfUrl
    // IS NOT NULL). Postgres would reject the insert without these.
    const token = tokenFor()
    const store = makeStore()
    await bindQuote(store.prisma, { ...BASE, draftToken: token })

    const data = store.policyCreates[0].data
    expect(data.policySource).toBe("STANDALONE")
    expect(data.faisDisclosureAt).toBeInstanceOf(Date)
    expect(data.faisDisclosurePdfUrl).toBe(`/api/insurance/disclosures/${token}`)
  })

  it("records the token hash, so the token is single-use", async () => {
    const store = makeStore()
    await bindQuote(store.prisma, { ...BASE, draftToken: tokenFor() })
    expect(store.policyCreates[0].data.faisDraftTokenHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it("refuses a token already spent on another policy", async () => {
    const store = makeStore({ replayedPolicy: { id: "policy-existing" } })
    const result = await bindQuote(store.prisma, { ...BASE, draftToken: tokenFor() })

    expect(result).toMatchObject({ ok: false, reason: "TOKEN_REPLAYED" })
    expect(store.policyCreates).toHaveLength(0)
  })

  it("refuses a token that is not signed by this system", async () => {
    const store = makeStore()
    const result = await bindQuote(store.prisma, { ...BASE, draftToken: "not.atoken" })
    expect(result).toMatchObject({ ok: false, reason: "TOKEN_INVALID" })
  })
})

describe("bindQuote — one transaction, three facts", () => {
  it("activates every life and sets its waiting period", async () => {
    const store = makeStore()
    await bindQuote(store.prisma, { ...BASE, draftToken: tokenFor() })

    expect(store.lifeUpdates).toHaveLength(2)
    for (const update of store.lifeUpdates) {
      expect(update.data).toMatchObject({ policyId: "policy-1", status: "ACTIVE" })
      // 180 days after 2026-09-01.
      expect(update.data.waitingPeriodEnds).toEqual(new Date("2027-02-28T00:00:00Z"))
    }
  })

  it("converts the quote and points it at the policy", async () => {
    const store = makeStore()
    await bindQuote(store.prisma, { ...BASE, draftToken: tokenFor() })

    expect(store.quoteUpdates[0].data).toEqual({ status: "CONVERTED", convertedPolicyId: "policy-1" })
    // The guard against two concurrent binds: the update only matches a quote
    // still in its original status with no policy attached.
    expect(store.quoteUpdates[0].where).toMatchObject({
      id: "quote-1",
      status: "ACCEPTED",
      convertedPolicyId: null,
    })
  })

  it("rolls back when another request converted the quote first", async () => {
    // updateMany matching zero rows means the other bind committed. The policy
    // row created in this transaction must not survive.
    const store = makeStore({ convertedCount: 0 })
    const result = await bindQuote(store.prisma, { ...BASE, draftToken: tokenFor() })

    expect(result).toMatchObject({ ok: false, reason: "ALREADY_CONVERTED" })
  })

  it("leaves waitingPeriodEnds null when the insurer waived the wait (zero days)", async () => {
    // Zero is a deliberate waiver and must still bind. `rules: []` cannot be
    // used for this any more — the bind re-screens, and a product with no
    // mandatory terms is refused as NOT_ELIGIBLE before it gets here.
    const store = makeStore({
      rules: [
        ...RULES.filter((r) => r.ruleType !== "WAITING_PERIOD_DAYS"),
        { id: "r-wait", lifeScope: "ALL_LIVES" as const, ruleType: "WAITING_PERIOD_DAYS" as const, numericValue: "0", textValue: null, active: true },
      ],
    })
    const result = await bindQuote(store.prisma, { ...BASE, draftToken: tokenFor() })
    expect(result).toMatchObject({ ok: true })
    expect(store.lifeUpdates[0].data.waitingPeriodEnds).toBeNull()
  })
})

describe("bindQuote — only an ACCEPTED, advised quote binds", () => {
  it("refuses a quote that is merely QUOTED", async () => {
    const store = makeStore({ quote: { ...QUOTE, status: "QUOTED" as never } })
    const result = await bindQuote(store.prisma, { ...BASE, draftToken: tokenFor() })

    expect(result).toMatchObject({ ok: false, reason: "NOT_BINDABLE" })
    expect(store.policyCreates).toHaveLength(0)
  })

  it("refuses a quote with NO record of advice — the FAIS gate holds at the bind", async () => {
    const store = makeStore({ quote: { ...QUOTE, adviceRecord: null } })
    const result = await bindQuote(store.prisma, { ...BASE, draftToken: tokenFor() })

    expect(result).toMatchObject({ ok: false, reason: "NOT_BINDABLE" })
    expect(result).toMatchObject({ detail: expect.stringContaining("record of advice") })
    expect(store.policyCreates).toHaveLength(0)
  })

  it("refuses a quote already bound", async () => {
    const store = makeStore({ quote: { ...QUOTE, convertedPolicyId: "policy-existing" } })
    const result = await bindQuote(store.prisma, { ...BASE, draftToken: tokenFor() })

    expect(result).toMatchObject({ ok: false, reason: "ALREADY_CONVERTED" })
    expect(store.policyCreates).toHaveLength(0)
  })

  it("reports a missing quote as not found", async () => {
    const store = makeStore({ quote: null })
    const result = await bindQuote(store.prisma, { ...BASE, draftToken: tokenFor() })
    expect(result).toMatchObject({ ok: false, reason: "QUOTE_NOT_FOUND" })
  })
})

describe("waitingPeriodEndsFor — fails CLOSED on an unusable term", () => {
  it("adds the insurer's configured days to the start date", () => {
    expect(waitingPeriodEndsFor(RULES, "MAIN_MEMBER", START)).toEqual({
      ok: true, endsAt: new Date("2027-02-28T00:00:00Z"),
    })
  })

  it("honours a life-type-scoped waiver over the ALL_LIVES row", () => {
    const scoped = [
      ...RULES,
      { id: "r-child", lifeScope: "CHILD" as const, ruleType: "WAITING_PERIOD_DAYS" as const, numericValue: "0", textValue: null, active: true },
    ]
    // Zero days is a deliberate waiver: immediate cover, and legitimately null.
    expect(waitingPeriodEndsFor(scoped, "CHILD", START)).toEqual({ ok: true, endsAt: null })
    expect(waitingPeriodEndsFor(scoped, "MAIN_MEMBER", START)).toMatchObject({ ok: true })
  })

  it("REFUSES an unusable configured value instead of granting immediate cover", () => {
    // The fail-open this replaces: returning null here meant cover from day one
    // that the insurer never granted. `evaluate` does not catch it — it checks
    // the term resolves and has a value, but never parses that value.
    const broken = [{ id: "r", lifeScope: "ALL_LIVES" as const, ruleType: "WAITING_PERIOD_DAYS" as const, numericValue: "not-a-number", textValue: null, active: true }]
    expect(waitingPeriodEndsFor(broken, "MAIN_MEMBER", START)).toMatchObject({ ok: false })
  })

  it("refuses a negative waiting period", () => {
    const negative = [{ id: "r", lifeScope: "ALL_LIVES" as const, ruleType: "WAITING_PERIOD_DAYS" as const, numericValue: "-30", textValue: null, active: true }]
    expect(waitingPeriodEndsFor(negative, "MAIN_MEMBER", START)).toMatchObject({ ok: false })
  })
})

describe("bindQuote — an unusable waiting period refuses the bind", () => {
  it("refuses rather than writing a policy with immediate cover", async () => {
    const store = makeStore({
      rules: [
        ...RULES.filter((r) => r.ruleType !== "WAITING_PERIOD_DAYS"),
        { id: "r-wait", lifeScope: "ALL_LIVES" as const, ruleType: "WAITING_PERIOD_DAYS" as const, numericValue: "not-a-number", textValue: null, active: true },
      ],
    })

    const result = await bindQuote(store.prisma, { ...BASE, draftToken: tokenFor() })

    expect(result).toMatchObject({ ok: false, reason: "WAITING_PERIOD_INVALID" })
    expect(store.policyCreates).toHaveLength(0)
  })
})

describe("bindQuote — money is compared in INTEGER CENTS, never as rands", () => {
  // Prisma's Decimal.toJSON() returns a STRING, so a figure that has crossed
  // JSON arrives as "83.00" rather than 83. A `===` between a string and a
  // number is ALWAYS false, so a rands comparison would refuse every bind
  // while looking like a working guard. These pin the value semantics: each
  // one fails if the comparison is reintroduced on rands.

  it("accepts a quote whose columns arrive as STRINGS, as Decimal.toJSON emits them", async () => {
    const store = makeStore({
      quote: {
        ...QUOTE,
        // A Decimal-alike whose toFixed yields the string form.
        totalPremium: decimal("83.00"),
        totalSumAssured: decimal("20000.00"),
      },
    })
    const result = await bindQuote(store.prisma, { ...BASE, draftToken: tokenFor() })
    expect(result).toMatchObject({ ok: true })
  })

  it("matches a token figure that is not exactly representable as a float", async () => {
    // 0.07-style values are where float equality starts to bite. The token
    // carries 83.07 and the quote carries "83.07"; in cents both are 8307.
    const store = makeStore({
      quote: { ...QUOTE, totalPremium: decimal("83.07") },
    })
    const result = await bindQuote(store.prisma, {
      ...BASE,
      draftToken: tokenFor({ premiumAmount: 83.07 }),
    })
    expect(result).toMatchObject({ ok: true })
    expect(store.policyCreates[0].data.premiumAmount).toBe("83.07")
  })

  it("still refuses a genuine one-cent difference", async () => {
    // The guard must not have been loosened into uselessness by the above:
    // one cent apart is a real mismatch and stays refused.
    const store = makeStore({ quote: { ...QUOTE, totalPremium: decimal("83.01") } })
    const result = await bindQuote(store.prisma, { ...BASE, draftToken: tokenFor({ premiumAmount: 83 }) })
    expect(result).toMatchObject({ ok: false, reason: "TOKEN_MISMATCH" })
  })
})

describe("bindQuote — the token's tenant is asserted, not inferred", () => {
  it("refuses a token minted for a DIFFERENT tenant", async () => {
    // Not currently exploitable — cuids are globally unique, so a token from
    // another tenant cannot collide on clientId. The guard asserts it anyway:
    // every other invariant in this file is pinned down rather than resting on
    // an implicit property of an id format, which is one refactor away from
    // resting on nothing.
    const store = makeStore()
    const result = await bindQuote(store.prisma, {
      ...BASE,
      draftToken: tokenFor({ tenantId: "tenant-B" }),
    })

    expect(result).toMatchObject({ ok: false, reason: "TOKEN_MISMATCH" })
    expect(store.policyCreates).toHaveLength(0)
  })

  it("accepts a token minted for this tenant", async () => {
    const store = makeStore()
    const result = await bindQuote(store.prisma, {
      ...BASE,
      draftToken: tokenFor({ tenantId: "tenant-1" }),
    })
    expect(result).toMatchObject({ ok: true })
  })
})

describe("bindQuote — the disclosed PRODUCT TYPE must match", () => {
  it("refuses a token disclosing a different product type", async () => {
    // The client was shown terms for LIFE_INSURANCE; the quote is FUNERAL_COVER.
    // The sibling FAIS gate checks type, and so must this one.
    const store = makeStore()
    const result = await bindQuote(store.prisma, {
      ...BASE,
      draftToken: tokenFor({ type: "LIFE_INSURANCE" }),
    })

    expect(result).toMatchObject({ ok: false, reason: "TOKEN_MISMATCH" })
    expect(store.policyCreates).toHaveLength(0)
  })
})

describe("bindQuote — the bind RE-SCREENS rather than trusting the status", () => {
  it("refuses lives the insurer's CURRENT terms reject, even from an ACCEPTED quote", async () => {
    // The B2 laundering path ends here. A quote that reached ACCEPTED without
    // ever passing the screen — or one whose product's terms tightened since —
    // is refused at the terminal act, not waved through on a status another
    // request wrote.
    const store = makeStore({
      rules: [
        ...RULES.filter((r) => r.ruleType !== "MAX_ENTRY_AGE"),
        { id: "r-max-age", lifeScope: "ALL_LIVES" as const, ruleType: "MAX_ENTRY_AGE" as const, numericValue: "30", textValue: null, active: true },
      ],
    })

    const result = await bindQuote(store.prisma, { ...BASE, draftToken: tokenFor() })

    expect(result).toMatchObject({ ok: false, reason: "NOT_ELIGIBLE" })
    expect(store.policyCreates).toHaveLength(0)
  })

  it("refuses when a mandatory term is not configured at all", async () => {
    const store = makeStore({ rules: [] })
    const result = await bindQuote(store.prisma, { ...BASE, draftToken: tokenFor() })
    expect(result).toMatchObject({ ok: false, reason: "NOT_ELIGIBLE" })
    expect(store.policyCreates).toHaveLength(0)
  })

  it("does NOT re-rate — the persisted price is what binds", async () => {
    // Only acceptability is re-checked. The client agreed to the persisted
    // figure, and the card may since have been retired.
    const store = makeStore()
    const result = await bindQuote(store.prisma, { ...BASE, draftToken: tokenFor() })

    expect(result).toMatchObject({ ok: true, premiumAmount: "83.00" })
    expect(store.policyCreates[0].data.premiumAmount).toBe("83.00")
  })
})

describe("bindQuote — P2: the policy is billable", () => {
  it("creates a 12-month premium schedule, or the renewal cron cannot see the policy", async () => {
    // app/api/cron/insurance-renewal selects on `premiumPayments: { some: ... }`.
    // With no rows the policy is invisible to it: never lapses, never renews,
    // never bills.
    const store = makeStore()
    await bindQuote(store.prisma, { ...BASE, draftToken: tokenFor() })

    expect(store.premiumSchedules).toHaveLength(1)
    const rows = store.premiumSchedules[0].data
    expect(rows).toHaveLength(12)
    expect(rows[0]).toMatchObject({ policyId: "policy-1", amount: "83.00", status: "DUE" })
    expect(rows.every((r) => r.tenantId === "tenant-1")).toBe(true)
  })

  it("computes the advisor commission on PREMIUM, not on sum assured", async () => {
    // 15% of the R83.00 premium = R12.45. On sum assured it would be R3 000 —
    // more than thirty-six times the figure, and not a commission at all.
    const store = makeStore()
    await bindQuote(store.prisma, { ...BASE, draftToken: tokenFor() })

    expect(store.commissions).toHaveLength(1)
    expect(store.commissions[0].data).toMatchObject({
      advisorId: "advisor-1" as string | null,
      policyId: "policy-1",
      amount: "12.45",
      premiumBase: "83.00",
      status: "PENDING",
    })
    expect(store.commissions[0].data.amount).not.toBe("3000.00")
  })

  it("writes no commission when the quote has no advisor", async () => {
    const store = makeStore({ quote: { ...QUOTE, advisorId: null } })
    await bindQuote(store.prisma, { ...BASE, draftToken: tokenFor() })
    expect(store.commissions).toHaveLength(0)
    // The schedule is still created — billing does not depend on an advisor.
    expect(store.premiumSchedules).toHaveLength(1)
  })
})

describe("bindQuote — B4: the start date is bounded", () => {
  it("refuses cover backdated before the quote existed", async () => {
    // `{"startDate":"2024-01-01"}` gave a waitingPeriodEnds already in the past,
    // defeating the insurer's mandatory waiting period on an ACTIVE policy.
    const store = makeStore()
    const result = await bindQuote(store.prisma, {
      ...BASE,
      startDate: new Date("2024-01-01T00:00:00Z"),
      draftToken: tokenFor(),
    })

    expect(result).toMatchObject({ ok: false, reason: "START_DATE_OUT_OF_RANGE" })
    expect(store.policyCreates).toHaveLength(0)
  })

  it("refuses a start date AFTER the quote's effective date but still in the past", async () => {
    // Isolates the backdating guard from the pre-effective one. The quote is
    // effective 2026-08-16 and it is now 2026-08-20, so a start of 2026-08-18
    // clears the effective-date check and is caught only by "no backdating".
    // Without this case the backdating guard could be deleted with every test
    // still green.
    const store = makeStore()
    const result = await bindQuote(store.prisma, {
      ...BASE,
      startDate: new Date("2026-08-18T00:00:00Z"),
      draftToken: tokenFor(),
    })

    expect(result).toMatchObject({ ok: false, reason: "START_DATE_OUT_OF_RANGE" })
    expect(result).toMatchObject({ detail: expect.stringContaining("backdated") })
    expect(store.policyCreates).toHaveLength(0)
  })

  it("refuses a start date before the quote's own effective date", async () => {
    const store = makeStore()
    const result = await bindQuote(store.prisma, {
      ...BASE,
      startDate: new Date("2026-08-01T00:00:00Z"),
      now: new Date("2026-07-01T00:00:00Z"),
      draftToken: tokenFor(),
    })
    expect(result).toMatchObject({ ok: false, reason: "START_DATE_OUT_OF_RANGE" })
  })

  it("accepts a forward-dated start", async () => {
    const store = makeStore()
    const result = await bindQuote(store.prisma, {
      ...BASE,
      startDate: new Date("2026-10-01T00:00:00Z"),
      draftToken: tokenFor(),
    })
    expect(result).toMatchObject({ ok: true })
  })
})

describe("bindQuote — B5: an expired quote does not bind", () => {
  it("refuses a quote past its expiresAt", async () => {
    // expiresAt was written by the quote path and read by NOTHING, so a quote
    // priced on a long-retired card stayed bindable at that stale premium —
    // and the bind deliberately does not re-rate, so nothing else caught it.
    const store = makeStore({
      quote: { ...QUOTE, expiresAt: new Date("2026-08-19T00:00:00Z") },
    })

    const result = await bindQuote(store.prisma, { ...BASE, draftToken: tokenFor() })

    expect(result).toMatchObject({ ok: false, reason: "QUOTE_EXPIRED" })
    expect(store.policyCreates).toHaveLength(0)
  })

  it("binds a quote still inside its window", async () => {
    const store = makeStore({
      quote: { ...QUOTE, expiresAt: new Date("2026-12-31T00:00:00Z") },
    })
    const result = await bindQuote(store.prisma, { ...BASE, draftToken: tokenFor() })
    expect(result).toMatchObject({ ok: true })
  })

  it("binds a quote with no expiry set", async () => {
    const store = makeStore()
    const result = await bindQuote(store.prisma, { ...BASE, draftToken: tokenFor() })
    expect(result).toMatchObject({ ok: true })
  })
})

describe("bindQuote — the token must name THIS quote", () => {
  it("refuses a LEGACY token that carries no quoteId at all", async () => {
    // A disclosure issued for one client's standalone policy is not evidence
    // that a family quote's lives and prices were shown to anybody.
    const store = makeStore()
    const result = await bindQuote(store.prisma, { ...BASE, draftToken: tokenFor({ quoteId: null }) })

    expect(result).toMatchObject({ ok: false, reason: "TOKEN_MISMATCH" })
    expect(store.policyCreates).toHaveLength(0)
  })

  it("refuses a token issued for a different quote", async () => {
    const store = makeStore()
    const result = await bindQuote(store.prisma, { ...BASE, draftToken: tokenFor({ quoteId: "quote-other" }) })
    expect(result).toMatchObject({ ok: false, reason: "TOKEN_MISMATCH" })
  })
})

describe("policyNumberPrefix", () => {
  it("numbers policies by type without any lender's brand", () => {
    expect(policyNumberPrefix("FUNERAL_COVER")).toBe("FUN")
    expect(policyNumberPrefix("CREDIT_LIFE")).toBe("CRL")
    expect(policyNumberPrefix("LIFE_INSURANCE")).toBe("LIFE")
    expect(policyNumberPrefix("MOTOR")).toBe("STI")
  })
})
