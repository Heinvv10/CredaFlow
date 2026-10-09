// The test that matters here is the one asserting a rating failure can never
// become a QUOTED row. `rateQuote` refuses to return a zero premium; this suite
// exists to prove that refusal survives the trip into the database, because the
// nullable column and the status are the only things carrying it once it has.
//
// THE FIXTURE IS DELIBERATELY NON-UNIFORM. Every band has a different premium
// and the two rated lives fall in different bands, so "total premium is 83.00"
// can only pass if each life matched its OWN band. A flat card where every row
// costs the same would let a total come out right with the matching broken —
// the assertion would hold no matter which band was picked, and would therefore
// be testing nothing.

import { describe, expect, it, vi } from "vitest"
import { Prisma } from "@prisma/client"
import { createQuote, type CreateQuoteResult, type QuotePersisted } from "./create"

/**
 * Narrow a result to the persisted branch.
 *
 * `CreateQuoteResult` unions a persisted quote with an input rejection that has
 * no premium, status or failures on it — deliberately, so nothing can read a
 * price off a request that never became a quote. A test asserting on those
 * fields therefore has to say which branch it expects, and this fails loudly
 * with the reason rather than reading `undefined` and passing by accident.
 */
function persisted(result: CreateQuoteResult): QuotePersisted {
  if (result.quoteId === null) {
    throw new Error(`Expected a persisted quote, got INVALID_INPUT: ${result.detail}`)
  }
  return result
}

const EFFECTIVE = new Date("2026-08-16T00:00:00Z")

/** Four bands, four different prices, across two axes: age AND life type. */
const BANDS = [
  { id: "band-mm-young", lifeType: "MAIN_MEMBER" as const, minAge: 18, maxAge: 40, sumAssured: "10000.00", premiumAmount: "45.00" },
  { id: "band-mm-old", lifeType: "MAIN_MEMBER" as const, minAge: 41, maxAge: 65, sumAssured: "10000.00", premiumAmount: "92.50" },
  { id: "band-sp", lifeType: "SPOUSE" as const, minAge: 18, maxAge: 40, sumAssured: "10000.00", premiumAmount: "38.00" },
  { id: "band-ch", lifeType: "CHILD" as const, minAge: 0, maxAge: 17, sumAssured: "5000.00", premiumAmount: "12.25" },
]

const TABLE = {
  id: "rt-1",
  version: 2,
  name: "2026 funeral card",
  basis: "AGE_BANDED" as const,
  effectiveFrom: new Date("2026-01-01T00:00:00Z"),
  effectiveTo: null,
  insurerId: "ins-1",
  bands: BANDS,
}

/** The four MANDATORY rule types, so a clean quote is not blocked as unscreened. */
const RULES = [
  { id: "r-min-age", lifeScope: "ALL_LIVES" as const, ruleType: "MIN_ENTRY_AGE" as const, numericValue: "18", textValue: null, active: true },
  { id: "r-max-age", lifeScope: "ALL_LIVES" as const, ruleType: "MAX_ENTRY_AGE" as const, numericValue: "65", textValue: null, active: true },
  { id: "r-max-cover", lifeScope: "ALL_LIVES" as const, ruleType: "MAX_COVER" as const, numericValue: "10000", textValue: null, active: true },
  { id: "r-wait", lifeScope: "ALL_LIVES" as const, ruleType: "WAITING_PERIOD_DAYS" as const, numericValue: "180", textValue: null, active: true },
]

/** 36 at the effective date -> band-mm-young at R45.00. */
const MAIN_MEMBER = {
  ref: "main",
  clientId: "client-1",
  firstName: "Thandi",
  lastName: "Nkosi",
  idNumber: "9005105800083",
  dateOfBirth: new Date("1990-05-10T00:00:00Z"),
  relationship: "SELF",
  lifeType: "MAIN_MEMBER" as const,
  sumAssured: "10000.00",
}

/** 38 at the effective date -> band-sp at R38.00. Not a Client, deliberately. */
const SPOUSE = {
  ref: "spouse",
  clientId: null,
  firstName: "Sipho",
  lastName: "Nkosi",
  idNumber: "8803015800081",
  dateOfBirth: new Date("1988-03-01T00:00:00Z"),
  relationship: "SPOUSE",
  lifeType: "SPOUSE" as const,
  sumAssured: "10000.00",
}

interface StoreOptions {
  tables?: unknown[]
  rules?: unknown[]
  createImpl?: (args: { data: Record<string, unknown> }) => Promise<unknown>
}

function makeStore({ tables = [TABLE], rules = RULES, createImpl }: StoreOptions = {}) {
  const created: { data: Record<string, unknown> }[] = []
  const create = vi.fn(async (args: { data: Record<string, unknown> }) => {
    created.push(args)
    if (createImpl) return createImpl(args)
    return {
      id: "quote-1",
      quoteNumber: args.data.quoteNumber as string,
      status: args.data.status as string,
    }
  })
  return {
    created,
    create,
    prisma: {
      insuranceRateTable: { findMany: async () => tables },
      insuranceEligibilityRule: { findMany: async () => rules },
      insuranceQuote: { create },
    } as never,
  }
}

const BASE = {
  tenantId: "tenant-1",
  clientId: "client-1",
  productId: "product-1",
  effectiveDate: EFFECTIVE,
  generateQuoteNumber: () => "QTE-TEST-0001",
}

/** The lives array as it was written to the DB, for asserting on the nested create. */
function livesWritten(args: { data: Record<string, unknown> }): Record<string, unknown>[] {
  return (args.data.lives as { create: Record<string, unknown>[] }).create
}

describe("createQuote — a fully rated, screened-clean quote", () => {
  it("is QUOTED, and totals the two DIFFERENT band premiums", async () => {
    const store = makeStore()
    const result = await createQuote(store.prisma, { ...BASE, lives: [MAIN_MEMBER, SPOUSE] })

    expect(result).toMatchObject({ ok: true, reason: null, status: "QUOTED" })
    // 45.00 (band-mm-young) + 38.00 (band-sp). Neither figure appears twice, so
    // this total is only reachable by matching each life to its own band.
    expect(result).toMatchObject({ totalPremium: "83.00", totalSumAssured: "20000.00" })
    expect(store.created[0].data.status).toBe("QUOTED")
  })

  it("records WHICH band priced each life, so the price survives the card being retired", async () => {
    const store = makeStore()
    await createQuote(store.prisma, { ...BASE, lives: [MAIN_MEMBER, SPOUSE] })

    expect(livesWritten(store.created[0])).toEqual([
      expect.objectContaining({ firstName: "Thandi", premiumAmount: "45.00", rateBandId: "band-mm-young" }),
      expect.objectContaining({ firstName: "Sipho", premiumAmount: "38.00", rateBandId: "band-sp" }),
    ])
  })

  it("keeps the rate table it was priced against", async () => {
    const store = makeStore()
    const result = await createQuote(store.prisma, { ...BASE, lives: [MAIN_MEMBER, SPOUSE] })
    expect(persisted(result).quoteId).toBe("quote-1")
    expect(store.created[0].data.rateTableId).toBe("rt-1")
  })

  it("leaves a covered life who is not a Client with a null clientId", async () => {
    const store = makeStore()
    await createQuote(store.prisma, { ...BASE, lives: [MAIN_MEMBER, SPOUSE] })
    const [main, spouse] = livesWritten(store.created[0])
    expect(main.clientId).toBe("client-1")
    // A spouse on a funeral quote has usually never applied for credit. A
    // required FK here would have manufactured a junk Client row.
    expect(spouse.clientId).toBeNull()
  })

  it("persists every life as PENDING — the bind is what activates them", async () => {
    const store = makeStore()
    await createQuote(store.prisma, { ...BASE, lives: [MAIN_MEMBER, SPOUSE] })
    expect(livesWritten(store.created[0]).map((l) => l.status)).toEqual(["PENDING", "PENDING"])
  })
})

describe("createQuote — THE INVARIANT: a rating failure never becomes QUOTED", () => {
  /** 70 at the effective date. The oldest band stops at 65. */
  const TOO_OLD = { ...MAIN_MEMBER, ref: "old", dateOfBirth: new Date("1956-01-01T00:00:00Z") }

  it("persists an unrateable life in DRAFT with a NULL premium, never QUOTED", async () => {
    const store = makeStore()
    const result = await createQuote(store.prisma, { ...BASE, lives: [TOO_OLD] })

    expect(result).toMatchObject({ ok: false, reason: "RATING_FAILED", status: "DRAFT" })
    expect(persisted(result).status).not.toBe("QUOTED")
    // Null, NOT zero. A zero premium is a policy sold for nothing.
    expect(store.created[0].data.status).toBe("DRAFT")
    expect(store.created[0].data.totalPremium).toBeNull()
    expect(store.created[0].data.totalPremium).not.toBe(0)
    expect(store.created[0].data.totalPremium).not.toBe("0.00")
  })

  it("records the failure reason as evidence of what the card refused", async () => {
    const store = makeStore()
    const result = await createQuote(store.prisma, { ...BASE, lives: [TOO_OLD] })

    expect(persisted(result).ratingFailures).toMatchObject({ stage: "RATING" })
    expect(persisted(result).ratingFailures).toMatchObject({
      failures: [expect.objectContaining({ ref: "old", reason: "NO_MATCHING_BAND", ageAtEntry: 70 })],
    })
  })

  it("writes NO premium for ANY life when only one of them failed to price", async () => {
    // The partial-rating trap: rateQuote returns a populated `perLife` for the
    // lives that did price. Writing those would leave a DRAFT quoting a price
    // for half a family, which reads as a real quote to anyone looking at it.
    const store = makeStore()
    await createQuote(store.prisma, { ...BASE, lives: [MAIN_MEMBER, TOO_OLD] })

    const lives = livesWritten(store.created[0])
    expect(lives).toHaveLength(2)
    expect(lives.map((l) => l.premiumAmount)).toEqual([null, null])
    expect(lives.map((l) => l.rateBandId)).toEqual([null, null])
  })

  it("refuses a band the insurer captured as 0.00 rather than quoting free cover", async () => {
    // The sharpest case: the band MATCHES. Only the non-positive check stands
    // between this and a policy sold for R0.00, and if that check were dropped
    // the quote would go out as QUOTED at a zero premium.
    const freeBand = { ...TABLE, bands: [{ ...BANDS[0], premiumAmount: "0.00" }] }
    const store = makeStore({ tables: [freeBand] })
    const result = await createQuote(store.prisma, { ...BASE, lives: [MAIN_MEMBER] })

    expect(result).toMatchObject({ ok: false, reason: "RATING_FAILED", status: "DRAFT" })
    expect(persisted(result).ratingFailures).toMatchObject({
      failures: [expect.objectContaining({ reason: "NON_POSITIVE_PREMIUM" })],
    })
    expect(store.created[0].data.totalPremium).toBeNull()
  })

  it("is DRAFT with a null premium when no rate card is in force at all", async () => {
    const store = makeStore({ tables: [] })
    const result = await createQuote(store.prisma, { ...BASE, lives: [MAIN_MEMBER] })

    expect(result).toMatchObject({ ok: false, reason: "RATE_TABLE_UNRESOLVED", status: "DRAFT" })
    expect(persisted(result).ratingFailures).toMatchObject({ stage: "RATE_TABLE", reason: "NOT_CONFIGURED" })
    expect(store.created[0].data.totalPremium).toBeNull()
    expect(store.created[0].data.rateTableId).toBeNull()
  })

  it("is DRAFT when two ACTIVE cards are in force, rather than picking one", async () => {
    const store = makeStore({ tables: [TABLE, { ...TABLE, id: "rt-2" }] })
    const result = await createQuote(store.prisma, { ...BASE, lives: [MAIN_MEMBER] })

    expect(result).toMatchObject({ ok: false, reason: "RATE_TABLE_UNRESOLVED" })
    expect(persisted(result).ratingFailures).toMatchObject({ stage: "RATE_TABLE", reason: "AMBIGUOUS_ACTIVE_TABLES" })
  })
})

describe("createQuote — eligibility", () => {
  it("persists the pass breakdown as evidence even when everything passed", async () => {
    const store = makeStore()
    const result = await createQuote(store.prisma, { ...BASE, lives: [MAIN_MEMBER, SPOUSE] })
    expect(persisted(result).eligibility).toEqual({ pass: true, failures: [] })
    expect(store.created[0].data.eligibilityResult).toEqual({ pass: true, failures: [] })
  })

  it("holds a screened-out quote in DRAFT even though every life priced", async () => {
    // Cover above the insurer's MAX_COVER. The card can price it; the insurer
    // would refuse it. QUOTED would be a claim that it is sellable.
    const overCover = { ...TABLE, bands: [{ ...BANDS[0], sumAssured: "50000.00", premiumAmount: "180.00" }] }
    const store = makeStore({ tables: [overCover] })
    const result = await createQuote(store.prisma, {
      ...BASE,
      lives: [{ ...MAIN_MEMBER, sumAssured: "50000.00" }],
    })

    expect(result).toMatchObject({ ok: false, reason: "ELIGIBILITY_FAILED", status: "DRAFT" })
    expect(persisted(result).eligibility.pass).toBe(false)
    expect(persisted(result).eligibility.failures[0]).toMatchObject({ code: "MAX_COVER" })
    // The premium IS kept: rating genuinely succeeded, and the figure is the
    // evidence of what was quoted and then refused.
    expect(persisted(result).totalPremium).toBe("180.00")
    expect(store.created[0].data.status).toBe("DRAFT")
  })

  it("screens even when the rate card is missing, so the operator sees both faults", async () => {
    const store = makeStore({ tables: [], rules: [] })
    const result = await createQuote(store.prisma, { ...BASE, lives: [MAIN_MEMBER] })

    expect(persisted(result).status).toBe("DRAFT")
    expect(result.reason).toBe("RATE_TABLE_UNRESOLVED")
    // No mandatory rules configured either — reported, not hidden behind the
    // rate-table failure that was found first.
    expect(persisted(result).eligibility.pass).toBe(false)
    expect(persisted(result).eligibility.failures.map((f) => f.code)).toContain("NOT_CONFIGURED")
  })
})

describe("createQuote — a malformed request is not a quote", () => {
  it("persists nothing when no lives were supplied", async () => {
    const store = makeStore()
    const result = await createQuote(store.prisma, { ...BASE, lives: [] })

    expect(result).toMatchObject({ ok: false, reason: "INVALID_INPUT", quoteId: null })
    expect(store.create).not.toHaveBeenCalled()
  })

  it("persists nothing when a sum assured cannot be read as a rand amount", async () => {
    const store = makeStore()
    const result = await createQuote(store.prisma, {
      ...BASE,
      lives: [{ ...MAIN_MEMBER, sumAssured: "not-money" }],
    })

    expect(result).toMatchObject({ ok: false, reason: "INVALID_INPUT" })
    expect(store.create).not.toHaveBeenCalled()
  })

  it("persists nothing when two lives share a ref", async () => {
    const store = makeStore()
    const result = await createQuote(store.prisma, {
      ...BASE,
      lives: [MAIN_MEMBER, { ...SPOUSE, ref: "main" }],
    })

    expect(result).toMatchObject({ ok: false, reason: "INVALID_INPUT" })
    expect(store.create).not.toHaveBeenCalled()
  })
})

describe("createQuote — quote number allocation", () => {
  it("retries a colliding quote number rather than failing the quote", async () => {
    let attempt = 0
    const store = makeStore({
      createImpl: async (args) => {
        attempt += 1
        if (attempt === 1) {
          throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
            code: "P2002",
            clientVersion: "5.22.0",
            meta: { target: ["tenantId", "quoteNumber"] },
          })
        }
        return { id: "quote-2", quoteNumber: args.data.quoteNumber as string, status: args.data.status as string }
      },
    })

    const numbers = ["QTE-A", "QTE-B"]
    const result = await createQuote(store.prisma, {
      ...BASE,
      lives: [MAIN_MEMBER, SPOUSE],
      generateQuoteNumber: () => numbers.shift() ?? "QTE-Z",
    })

    expect(result.ok).toBe(true)
    expect(persisted(result).quoteNumber).toBe("QTE-B")
    expect(store.create).toHaveBeenCalledTimes(2)
  })

  it("surfaces a non-collision error instead of retrying it", async () => {
    const store = makeStore({
      createImpl: async () => {
        throw new Error("connection reset")
      },
    })

    await expect(
      createQuote(store.prisma, { ...BASE, lives: [MAIN_MEMBER] })
    ).rejects.toThrow("connection reset")
    expect(store.create).toHaveBeenCalledTimes(1)
  })
})
