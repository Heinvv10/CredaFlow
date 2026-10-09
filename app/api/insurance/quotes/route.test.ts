// app/api/insurance/quotes/route.test.ts
//
// Guard coverage for the quote collection route, matching the shape of the
// Phase 1 rate-table route tests.
//
// The role guard is exercised in BOTH directions rather than mocked to succeed
// forever: a test that only ever lets the guard pass proves the happy path and
// nothing about the guard. Each refusal asserts three things — the guard's own
// response is what the handler returned, nothing below it ran, and NO audit row
// was written. That last one is the assertion that catches a guard moved below
// the logAudit call, which is a real way to leak evidence of work that never
// happened.
//
// The minimum role is asserted too. A write route silently weakened to
// READONLY still passes every behavioural test in this file; only checking the
// ARGUMENT catches it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { NextResponse } from "next/server"

const {
  requireApiRole,
  findManyQuotes,
  findFirstClient,
  findManyClients,
  findFirstProduct,
  findManyRateTables,
  findManyRules,
  createQuote,
  tenantConfigFindUnique,
  logAudit,
} = vi.hoisted(() => ({
  requireApiRole: vi.fn(),
  findManyQuotes: vi.fn(),
  findFirstClient: vi.fn(),
  findManyClients: vi.fn(),
  findFirstProduct: vi.fn(),
  findManyRateTables: vi.fn(),
  findManyRules: vi.fn(),
  createQuote: vi.fn(),
  tenantConfigFindUnique: vi.fn(),
  logAudit: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantConfig: { findUnique: tenantConfigFindUnique },
    client: { findFirst: findFirstClient, findMany: findManyClients },
    insuranceProduct: { findFirst: findFirstProduct },
    insuranceRateTable: { findMany: findManyRateTables },
    insuranceEligibilityRule: { findMany: findManyRules },
    insuranceQuote: { findMany: findManyQuotes, create: createQuote },
  },
}))

vi.mock("@/lib/tenant", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant")>()),
  withTenantContext: (_req: unknown, fn: (t: { id: string; name: string }) => unknown) =>
    fn({ id: "tenant-1", name: "Test Tenant" }),
}))

vi.mock("@/lib/auth-guards", () => ({ requireApiRole }))
vi.mock("@/lib/audit", () => ({ logAudit, AuditAction: new Proxy({}, { get: (_t, k) => String(k) }) }))

import { GET, POST } from "./route"

/** NON-UNIFORM card: two life types, two prices, so a total is a real check. */
const TABLE = {
  id: "rt-1", version: 1, name: "card", basis: "AGE_BANDED",
  effectiveFrom: new Date("2026-01-01T00:00:00Z"), effectiveTo: null, insurerId: null,
  bands: [
    { id: "b-mm", lifeType: "MAIN_MEMBER", minAge: 18, maxAge: 65, sumAssured: "10000.00", premiumAmount: "45.00" },
    { id: "b-sp", lifeType: "SPOUSE", minAge: 18, maxAge: 65, sumAssured: "10000.00", premiumAmount: "38.00" },
  ],
}

const RULES = [
  { id: "r1", lifeScope: "ALL_LIVES", ruleType: "MIN_ENTRY_AGE", numericValue: "18", textValue: null, active: true },
  { id: "r2", lifeScope: "ALL_LIVES", ruleType: "MAX_ENTRY_AGE", numericValue: "75", textValue: null, active: true },
  { id: "r3", lifeScope: "ALL_LIVES", ruleType: "MAX_COVER", numericValue: "10000", textValue: null, active: true },
  { id: "r4", lifeScope: "ALL_LIVES", ruleType: "WAITING_PERIOD_DAYS", numericValue: "180", textValue: null, active: true },
]

const LIFE = {
  ref: "main", firstName: "Thandi", lastName: "Nkosi", relationship: "SELF",
  lifeType: "MAIN_MEMBER", dateOfBirth: "1990-05-10T00:00:00Z", sumAssured: 10000,
  // A REAL SA ID whose YYMMDD prefix matches the date of birth above and
  // which passes the Luhn check — both are now verified.
  idNumber: "9005105000087",
}

const VALID_BODY = {
  clientId: "client-1",
  productId: "product-1",
  effectiveDate: "2026-08-16T00:00:00Z",
  lives: [LIFE],
}

function postReq(body: unknown) {
  return new NextRequest("http://localhost/api/insurance/quotes", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json" },
  })
}

const getReq = () => new NextRequest("http://localhost/api/insurance/quotes")

/** The refusal a real `requireApiRole` returns for an under-privileged caller. */
function roleRefusal() {
  return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) }
}

beforeEach(() => {
  requireApiRole.mockResolvedValue({ user: { id: "user-1", email: "officer@acme-lending.example" } })
  tenantConfigFindUnique.mockResolvedValue({ featureCrm: false, featureIms: true })
  findManyQuotes.mockResolvedValue([])
  findFirstClient.mockResolvedValue({ id: "client-1" })
  findManyClients.mockResolvedValue([{ id: "client-1", dateOfBirth: new Date("1990-05-10T00:00:00Z") }])
  findFirstProduct.mockResolvedValue({ id: "product-1" })
  findManyRateTables.mockResolvedValue([TABLE])
  findManyRules.mockResolvedValue(RULES)
  createQuote.mockImplementation(async (args: { data: Record<string, unknown> }) => ({
    id: "quote-1",
    quoteNumber: args.data.quoteNumber,
    status: args.data.status,
  }))
})

afterEach(() => {
  vi.clearAllMocks()
})

describe("GET /api/insurance/quotes — role guard", () => {
  it("requires only READONLY", async () => {
    await GET(getReq())
    expect(requireApiRole).toHaveBeenCalledWith("READONLY")
  })

  it("returns the guard's refusal and does no work behind it", async () => {
    requireApiRole.mockResolvedValue(roleRefusal())

    const res = await GET(getReq())

    expect(res.status).toBe(403)
    expect(findManyQuotes).not.toHaveBeenCalled()
    // A read writes no audit row either way, but asserting it here means a
    // future audit-on-read cannot be added below the guard unnoticed.
    expect(logAudit).not.toHaveBeenCalled()
  })

  it("rejects an unknown status filter with 422, not a 500", async () => {
    // `status as never` sent any query string to Prisma, which throws on an
    // unknown enum value — so a typo in a filter surfaced as a 500.
    const res = await GET(new NextRequest("http://localhost/api/insurance/quotes?status=BANANA"))

    expect(res.status).toBe(422)
    expect(findManyQuotes).not.toHaveBeenCalled()
  })

  it("accepts a valid status filter and passes it through", async () => {
    const res = await GET(new NextRequest("http://localhost/api/insurance/quotes?status=QUOTED"))

    expect(res.status).toBe(200)
    expect(findManyQuotes).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: "QUOTED" }) })
    )
  })

  it("scopes the list to the caller's tenant", async () => {
    await GET(getReq())
    expect(findManyQuotes).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ tenantId: "tenant-1" }) })
    )
  })
})

describe("POST /api/insurance/quotes — role guard", () => {
  it("requires INSURANCE_OFFICER, not READONLY", async () => {
    await POST(postReq(VALID_BODY))
    expect(requireApiRole).toHaveBeenCalledWith("INSURANCE_OFFICER")
  })

  it("returns the guard's refusal, creates nothing and audits nothing", async () => {
    requireApiRole.mockResolvedValue(roleRefusal())

    const res = await POST(postReq(VALID_BODY))

    expect(res.status).toBe(403)
    expect(createQuote).not.toHaveBeenCalled()
    expect(logAudit).not.toHaveBeenCalled()
  })
})

describe("POST /api/insurance/quotes — rejected requests write NO audit row", () => {
  it("a malformed body is 422 and unaudited", async () => {
    const res = await POST(postReq("not json"))
    expect(res.status).toBe(422)
    expect(logAudit).not.toHaveBeenCalled()
  })

  it("a missing clientId is 422 and unaudited", async () => {
    const { clientId: _omitted, ...noClient } = VALID_BODY
    const res = await POST(postReq(noClient))
    expect(res.status).toBe(422)
    expect(createQuote).not.toHaveBeenCalled()
    expect(logAudit).not.toHaveBeenCalled()
  })

  it("an empty lives array is 422 and unaudited", async () => {
    const res = await POST(postReq({ ...VALID_BODY, lives: [] }))
    expect(res.status).toBe(422)
    expect(logAudit).not.toHaveBeenCalled()
  })

  it("a life missing its identity is 422 and unaudited", async () => {
    const res = await POST(postReq({ ...VALID_BODY, lives: [{ ...LIFE, firstName: "" }] }))
    expect(res.status).toBe(422)
    expect(logAudit).not.toHaveBeenCalled()
  })

  it("another tenant's client is 404, not 403, and unaudited", async () => {
    // 404 rather than 403: a tenant-scoped lookup must not confirm that an id
    // exists somewhere else.
    findFirstClient.mockResolvedValue(null)

    const res = await POST(postReq(VALID_BODY))

    expect(res.status).toBe(404)
    expect(createQuote).not.toHaveBeenCalled()
    expect(logAudit).not.toHaveBeenCalled()
  })

  it("another tenant's product is 404 and unaudited", async () => {
    findFirstProduct.mockResolvedValue(null)

    const res = await POST(postReq(VALID_BODY))

    expect(res.status).toBe(404)
    expect(logAudit).not.toHaveBeenCalled()
  })

  it("scopes both lookups to the caller's tenant", async () => {
    await POST(postReq(VALID_BODY))
    expect(findFirstClient).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "client-1", tenantId: "tenant-1" } })
    )
    expect(findFirstProduct).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "product-1", tenantId: "tenant-1" } })
    )
  })
})

describe("POST /api/insurance/quotes — the audit row on the success path", () => {
  it("audits a priced quote as CREATED, naming the persisted row", async () => {
    const res = await POST(postReq(VALID_BODY))

    expect(res.status).toBe(201)
    expect(logAudit).toHaveBeenCalledTimes(1)
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-1",
        userId: "user-1",
        action: "INSURANCE_QUOTE_CREATED",
        entity: "InsuranceQuote",
        entityId: "quote-1",
        newValue: expect.objectContaining({ status: "QUOTED", totalPremium: "45.00" }),
      })
    )
  })

  it("audits an unpriceable quote as DRAFTED, carrying the failures", async () => {
    // No rate card in force. The quote is still persisted, and the audit row is
    // the evidence of what the insurer's configuration refused — a separate
    // action, so a DRAFT is not silently indistinguishable from a sale.
    findManyRateTables.mockResolvedValue([])

    const res = await POST(postReq(VALID_BODY))

    expect(res.status).toBe(201)
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "INSURANCE_QUOTE_DRAFTED",
        entityId: "quote-1",
        newValue: expect.objectContaining({
          status: "DRAFT",
          reason: "RATE_TABLE_UNRESOLVED",
          totalPremium: null,
          ratingFailures: expect.objectContaining({ stage: "RATE_TABLE" }),
        }),
      })
    )
  })

  it("does NOT audit an input rejection that never became a quote", async () => {
    // createQuote returns INVALID_INPUT without persisting; there is no row to
    // audit and a 422 is returned instead of a 201.
    const res = await POST(postReq({ ...VALID_BODY, lives: [{ ...LIFE, sumAssured: 0 }] }))

    expect(res.status).toBe(422)
    expect(createQuote).not.toHaveBeenCalled()
    expect(logAudit).not.toHaveBeenCalled()
  })
})

describe("POST /api/insurance/quotes — a covered life may not carry another tenant's client", () => {
  // parseLife only checks that lives[].clientId is a non-empty string. That is
  // a shape check, not an authorisation check, and InsuredLife has no tenantId
  // of its own — it is scoped through its parent quote, and the Client FK
  // carries no tenant constraint at the DB level. So the tenant-scoped check on
  // the QUOTE's client proves nothing about the lives'.

  const LIFE_AS_CLIENT = { ...LIFE, clientId: "client-1" }
  const LIFE_OTHER_TENANT = { ...LIFE, ref: "planted", clientId: "client-from-tenant-b" }

  it("refuses a life carrying another tenant's client id, and writes NOTHING", async () => {
    // The Client row exists — it just belongs to someone else, so the
    // tenant-scoped findMany does not return it.
    findManyClients.mockResolvedValue([])

    const res = await POST(postReq({ ...VALID_BODY, lives: [LIFE_OTHER_TENANT] }))

    expect(res.status).toBe(404)
    // No quote, therefore no InsuredLife rows — they are created in the same
    // nested statement, so proving the quote was not created proves both.
    expect(createQuote).not.toHaveBeenCalled()
    expect(logAudit).not.toHaveBeenCalled()
  })

  it("is a 404, not a 403 — never confirming the id exists elsewhere", async () => {
    findManyClients.mockResolvedValue([])
    const res = await POST(postReq({ ...VALID_BODY, lives: [LIFE_OTHER_TENANT] }))
    expect(res.status).toBe(404)
    expect(res.status).not.toBe(403)
  })

  it("validates EVERY life, not just the first", async () => {
    // The first life is legitimate; the second is planted. A check that
    // returned early on the first hit would pass this request.
    findManyClients.mockResolvedValue([{ id: "client-1", dateOfBirth: new Date("1990-05-10T00:00:00Z") }])

    const res = await POST(
      postReq({ ...VALID_BODY, lives: [LIFE_AS_CLIENT, LIFE_OTHER_TENANT] })
    )

    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("planted") })
    expect(createQuote).not.toHaveBeenCalled()
  })

  it("scopes the life-client lookup to the caller's tenant", async () => {
    await POST(postReq({ ...VALID_BODY, lives: [LIFE_AS_CLIENT] }))

    expect(findManyClients).toHaveBeenCalledWith({
      where: { id: { in: ["client-1"] }, tenantId: "tenant-1" },
      select: { id: true, dateOfBirth: true },
    })
  })

  it("accepts a life whose client genuinely belongs to this tenant", async () => {
    findManyClients.mockResolvedValue([{ id: "client-1", dateOfBirth: new Date("1990-05-10T00:00:00Z") }])

    const res = await POST(postReq({ ...VALID_BODY, lives: [LIFE_AS_CLIENT] }))

    expect(res.status).toBe(201)
    expect(createQuote).toHaveBeenCalled()
  })

  it("does not query at all when no life claims to be a client", async () => {
    // The common case: a funeral quote covering a spouse and children who have
    // never applied for credit. Every clientId is null, so there is nothing to
    // authorise and no query to make.
    const res = await POST(postReq({ ...VALID_BODY, lives: [LIFE] }))

    expect(res.status).toBe(201)
    expect(findManyClients).not.toHaveBeenCalled()
  })

  it("de-duplicates repeated client ids into one lookup", async () => {
    await POST(
      postReq({ ...VALID_BODY, lives: [LIFE_AS_CLIENT, { ...LIFE_AS_CLIENT, ref: "second" }] })
    )

    expect(findManyClients).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ["client-1"] }, tenantId: "tenant-1" } })
    )
  })
})

describe("POST /api/insurance/quotes — B3: a date of birth is evidence, not an assertion", () => {
  const AS_CLIENT = { ...LIFE, clientId: "client-1" }

  it("takes the DOB from the CLIENT ROW, overriding whatever the caller sent", async () => {
    // Age is the primary rating axis. Quoting a 78-year-old as born in 1985
    // lands them in a cheap band, clears MAX_ENTRY_AGE and binds, with the
    // InsuredLife row carrying the false date as the record of who is covered.
    findManyClients.mockResolvedValue([{ id: "client-1", dateOfBirth: new Date("1946-01-01T00:00:00Z") }])

    const res = await POST(postReq({
      ...VALID_BODY,
      // Caller claims 1990 and supplies an ID agreeing with the lie.
      lives: [{ ...AS_CLIENT, dateOfBirth: "1990-05-10T00:00:00Z", idNumber: "9005105000087" }],
    }))

    // The DB says 1946, the ID says 1990 — the override happens first, so the
    // ID cross-check then catches the disagreement.
    expect(res.status).toBe(422)
    expect((await res.json()).error).toMatch(/does not match the ID number/i)
    expect(createQuote).not.toHaveBeenCalled()
  })

  it("uses the client's stored DOB when the caller sends a different one and no ID", async () => {
    findManyClients.mockResolvedValue([{ id: "client-1", dateOfBirth: new Date("1946-01-01T00:00:00Z") }])

    const { idNumber: _drop, ...noId } = AS_CLIENT
    await POST(postReq({ ...VALID_BODY, lives: [{ ...noId, dateOfBirth: "1990-05-10T00:00:00Z" }] }))

    // Rated on 1946, not on the 1990 the caller asserted.
    const passed = createQuote.mock.calls[0][0].data
    expect((passed.lives as { create: Record<string, unknown>[] }).create[0].dateOfBirth)
      .toEqual(new Date("1946-01-01T00:00:00Z"))
  })

  it("refuses a life linked to a client with no DOB on record", async () => {
    findManyClients.mockResolvedValue([{ id: "client-1", dateOfBirth: null }])

    const res = await POST(postReq({ ...VALID_BODY, lives: [AS_CLIENT] }))

    expect(res.status).toBe(422)
    expect((await res.json()).error).toMatch(/no date of birth on record/i)
    expect(createQuote).not.toHaveBeenCalled()
  })

  it("cross-checks a NON-client life against its SA ID number", async () => {
    // The majority case: a spouse, child or parent who is not a Client at all.
    // The ID is the only verification available for them.
    const res = await POST(postReq({
      ...VALID_BODY,
      lives: [{ ...LIFE, ref: "spouse", clientId: null, dateOfBirth: "1990-05-10T00:00:00Z", idNumber: "4601015000087" }],
    }))

    expect(res.status).toBe(422)
    expect((await res.json()).error).toMatch(/1946-01-01/)
    expect(createQuote).not.toHaveBeenCalled()
  })

  it("accepts a life whose ID agrees with its date of birth", async () => {
    const res = await POST(postReq({
      ...VALID_BODY,
      lives: [{ ...LIFE, clientId: null, dateOfBirth: "1990-05-10T00:00:00Z", idNumber: "9005105000087" }],
    }))
    expect(res.status).toBe(201)
  })

  it("resolves a CHILD's century correctly", async () => {
    // The experian helper picks the century that yields an adult aged 18-100,
    // which is wrong for every child a funeral quote covers. This one does not.
    const res = await POST(postReq({
      ...VALID_BODY,
      lives: [{ ...LIFE, ref: "child", clientId: null, lifeType: "CHILD",
                dateOfBirth: "2015-06-01T00:00:00Z", idNumber: "1506015000081" }],
    }))
    expect(res.status).toBe(201)
  })

  it("refuses an ID number that fails the checksum", async () => {
    const res = await POST(postReq({
      ...VALID_BODY,
      lives: [{ ...LIFE, clientId: null, idNumber: "9005105000080" }],
    }))
    expect(res.status).toBe(422)
    expect((await res.json()).error).toMatch(/invalid SA ID/i)
  })

  it("still accepts a life with no ID and no clientId — nothing to verify against", async () => {
    const { idNumber: _drop, ...noId } = LIFE
    const res = await POST(postReq({ ...VALID_BODY, lives: [{ ...noId, clientId: null }] }))
    expect(res.status).toBe(201)
  })
})

describe("POST /api/insurance/quotes — a rate card activated TODAY is quotable today", () => {
  /** Today's SAST calendar date, derived without the helper under test. */
  function todayInSast() {
    return new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Johannesburg" })
  }

  // "Today" is a fixed noon SAST. On the wall clock, any run before 07:39 SAST
  // put "now" ahead of the card's activation and read as the bug.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date("2026-08-17T12:00:00+02:00"))
  })
  afterEach(() => vi.useRealTimers())

  beforeEach(() => {
    // A card activated at 07:39 SAST this morning. Activation stamps
    // `effectiveFrom` at the instant it happens — it is never midnight.
    const activatedAt = new Date(`${todayInSast()}T07:39:00.000+02:00`)

    // The mock HONOURS `effectiveFrom: { lte: at }`, because that filter IS the
    // mechanism under test. A mock that returns the card regardless of `at`
    // would pass whether or not the bug exists.
    findManyRateTables.mockImplementation(
      async (args: { where: { effectiveFrom: { lte: Date } } }) =>
        args.where.effectiveFrom.lte >= activatedAt
          ? [{ ...TABLE, effectiveFrom: activatedAt }]
          : []
    )
  })

  it("prices a quote dated today as a bare calendar date", async () => {
    // A bare date such as `"2026-08-17"` parses to midnight UTC — 02:00 SAST,
    // hours before the card comes into force — so the quote could not resolve
    // a rate table and would come back unpriced.
    const res = await POST(postReq({ ...VALID_BODY, effectiveDate: todayInSast() }))

    expect(res.status).toBe(201)
    const data = createQuote.mock.calls[0][0].data as Record<string, unknown>
    expect(data.rateTableId).toBe("rt-1")
    // Priced, not merely created: a null premium is the failure mode this
    // whole change exists to remove.
    expect(data.totalPremium).not.toBeNull()
  })

  it("prices a quote when the caller omits the effective date entirely", async () => {
    const { effectiveDate: _omitted, ...withoutDate } = VALID_BODY
    const res = await POST(postReq(withoutDate))

    expect(res.status).toBe(201)
    expect((createQuote.mock.calls[0][0].data as Record<string, unknown>).rateTableId).toBe("rt-1")
  })

  it("still leaves a quote dated BEFORE the card came into force unpriced", async () => {
    // The fix must not make every date resolve. Yesterday is genuinely before
    // this card existed, and must stay unresolvable.
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
      .toLocaleDateString("en-CA", { timeZone: "Africa/Johannesburg" })
    const res = await POST(postReq({ ...VALID_BODY, effectiveDate: yesterday }))

    expect(res.status).toBe(201)
    const data = createQuote.mock.calls[0]?.[0]?.data as Record<string, unknown> | undefined
    expect(data?.rateTableId ?? null).toBeNull()
  })

  it("refuses a calendar-invalid effective date instead of rolling it over", async () => {
    // `new Date("2026-02-30")` is 2 March, not NaN — a naive check would accept it
    // and price against a day the caller never named.
    const res = await POST(postReq({ ...VALID_BODY, effectiveDate: "2026-02-30" }))

    expect(res.status).toBe(422)
    expect(createQuote).not.toHaveBeenCalled()
  })
})

describe("POST /api/insurance/quotes — F2: expiry is provisioned, not volunteered", () => {
  function created() {
    return createQuote.mock.calls[0][0].data as Record<string, unknown>
  }

  it("DEFAULTS expiresAt when the caller omits it", async () => {
    // The hole this closes: both guards that enforce expiry are written
    // `expiresAt !== null && ...`, so a null armed nothing and the quote stayed
    // disclosable and bindable for ever at a price its rate card produced on
    // the day it was written. The bind does not re-rate.
    // VALID_BODY carries no expiresAt at all — the omitted case, which had no
    // coverage before and is the one that armed nothing.
    const res = await POST(postReq(VALID_BODY))

    expect(res.status).toBe(201)
    const value = created().expiresAt as Date
    expect(value).toBeInstanceOf(Date)
    expect(value).not.toBeNull()
    // 30 days after the effective date.
    expect(value.toISOString()).toBe("2026-09-15T00:00:00.000Z")
  })

  it("never writes a null expiry", async () => {
    await POST(postReq({ ...VALID_BODY, expiresAt: undefined }))
    expect(created().expiresAt).not.toBeNull()
  })

  it("honours an explicit expiry inside the allowed window", async () => {
    await POST(postReq({ ...VALID_BODY, expiresAt: "2026-09-01T00:00:00Z" }))
    expect((created().expiresAt as Date).toISOString()).toBe("2026-09-01T00:00:00.000Z")
  })

  it("refuses an expiry at or before the effective date", async () => {
    const res = await POST(postReq({ ...VALID_BODY, expiresAt: "2026-08-16T00:00:00Z" }))
    expect(res.status).toBe(422)
    expect(createQuote).not.toHaveBeenCalled()
  })

  it("refuses an expiry already in the past", async () => {
    const res = await POST(postReq({ ...VALID_BODY, expiresAt: "2020-01-01T00:00:00Z" }))
    expect(res.status).toBe(422)
    expect(createQuote).not.toHaveBeenCalled()
  })

  it("refuses an absurd horizon — a decade is a null expiry with extra steps", async () => {
    const res = await POST(postReq({ ...VALID_BODY, expiresAt: "2036-01-01T00:00:00Z" }))
    expect(res.status).toBe(422)
    expect((await res.json()).error).toMatch(/at most 365 days/i)
    expect(createQuote).not.toHaveBeenCalled()
  })

  it("still refuses an unparseable expiry", async () => {
    const res = await POST(postReq({ ...VALID_BODY, expiresAt: "not-a-date" }))
    expect(res.status).toBe(422)
  })

  it("reads a bare date as the END of that day, not its first instant", async () => {
    // A caller naming 1 September means the quote is good THROUGH the 1st.
    // Parsed as an instant it died at 02:00 SAST that morning — 22 hours early.
    // Midnight SAST starting the 2nd is 22:00 UTC on the 1st.
    await POST(postReq({ ...VALID_BODY, expiresAt: "2026-09-01" }))
    expect((created().expiresAt as Date).toISOString()).toBe("2026-09-01T22:00:00.000Z")
  })

  it("refuses a bare expiry date that is not a real calendar date", async () => {
    const res = await POST(postReq({ ...VALID_BODY, expiresAt: "2026-02-30" }))
    expect(res.status).toBe(422)
    expect(createQuote).not.toHaveBeenCalled()
  })
})
