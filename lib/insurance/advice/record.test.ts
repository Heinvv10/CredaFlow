import { describe, expect, it, vi } from "vitest"
import { createAdviceRecordSha256, recordAdvice, verifyAdviceRecordHash } from "./record"

const EVIDENCE = {
  quoteId: "quote-1",
  quoteNumber: "QTE-0001",
  totalPremium: "83.00",
  needsAnalysis: "Sole earner, three dependants, no existing funeral cover.",
  productsConsidered: [
    { code: "FUN-10K", premium: "83.00" },
    { code: "FUN-20K", premium: "151.00" },
  ],
  recommendation: "FUN-10K — cover matches stated burial costs and fits the household budget.",
  clientDecision: "ACCEPTED_RECOMMENDATION" as const,
  reasonIfDifferent: null,
}

/** A Decimal-alike, since the module reads `totalPremium.toFixed(2)` off the row. */
function decimal(value: string) {
  return { toFixed: (dp: number) => Number(value).toFixed(dp) }
}

interface StoreOptions {
  quote?: Record<string, unknown> | null
  /** Rows matched by the status-guarded updateMany; 0 means someone else moved the quote. */
  updateCount?: number
}

function makeStore({ quote = undefined, updateCount = 1 }: StoreOptions = {}) {
  const defaultQuote = {
    id: "quote-1",
    quoteNumber: "QTE-0001",
    status: "QUOTED",
    totalPremium: decimal("83.00"),
    adviceRecord: null,
  }
  const created: unknown[] = []
  const updated: unknown[] = []

  const create = vi.fn(async (args: unknown) => {
    created.push(args)
    return { id: "advice-1" }
  })
  const update = vi.fn(async (args: unknown) => {
    updated.push(args)
    return { count: updateCount }
  })

  return {
    created,
    updated,
    create,
    update,
    prisma: {
      insuranceQuote: {
        findFirst: async () => (quote === undefined ? defaultQuote : quote),
      },
      insuranceAdviceRecord: {},
      // Interactive form, mirroring the real client: the callback receives a
      // tx and whatever it returns is the transaction's result. A throw inside
      // rolls back, which is how the concurrent-change guard reports.
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          insuranceAdviceRecord: { create },
          insuranceQuote: { updateMany: update },
        }),
    } as never,
  }
}

const BASE = {
  tenantId: "tenant-1",
  quoteId: "quote-1",
  needsAnalysis: EVIDENCE.needsAnalysis,
  productsConsidered: EVIDENCE.productsConsidered,
  recommendation: EVIDENCE.recommendation,
  clientDecision: "ACCEPTED_RECOMMENDATION" as const,
}

describe("createAdviceRecordSha256", () => {
  it("is stable for the same advice", () => {
    expect(createAdviceRecordSha256(EVIDENCE)).toBe(createAdviceRecordSha256({ ...EVIDENCE }))
  })

  it("is a 64-character hex digest, like the credit life disclosure hash", () => {
    expect(createAdviceRecordSha256(EVIDENCE)).toMatch(/^[0-9a-f]{64}$/)
  })

  it("changes when the recommendation changes", () => {
    expect(createAdviceRecordSha256({ ...EVIDENCE, recommendation: "FUN-20K instead." }))
      .not.toBe(createAdviceRecordSha256(EVIDENCE))
  })

  it("changes when the quote is re-priced", () => {
    // Advice is only meaningful against the figures the client was shown, so a
    // record whose quote moved must stop verifying.
    expect(createAdviceRecordSha256({ ...EVIDENCE, totalPremium: "91.00" }))
      .not.toBe(createAdviceRecordSha256(EVIDENCE))
  })

  it("changes when the client's decision changes", () => {
    expect(createAdviceRecordSha256({ ...EVIDENCE, clientDecision: "DECLINED_ADVICE" }))
      .not.toBe(createAdviceRecordSha256(EVIDENCE))
  })

  it("distinguishes what was considered, not only what was recommended", () => {
    expect(createAdviceRecordSha256({ ...EVIDENCE, productsConsidered: [{ code: "FUN-10K" }] }))
      .not.toBe(createAdviceRecordSha256(EVIDENCE))
  })
})

describe("verifyAdviceRecordHash", () => {
  it("accepts a record that still matches its stored hash", () => {
    const contentHash = createAdviceRecordSha256(EVIDENCE)
    expect(verifyAdviceRecordHash({ ...EVIDENCE, contentHash })).toEqual({ ok: true })
  })

  it("detects a record edited after it was written", () => {
    const contentHash = createAdviceRecordSha256(EVIDENCE)
    const tampered = { ...EVIDENCE, recommendation: "Something else entirely.", contentHash }
    expect(verifyAdviceRecordHash(tampered)).toMatchObject({ ok: false, reason: "HASH_MISMATCH" })
  })

  it("reports an unhashed record rather than passing it", () => {
    expect(verifyAdviceRecordHash({ ...EVIDENCE, contentHash: null })).toMatchObject({
      ok: false,
      reason: "NO_HASH",
    })
  })
})

describe("recordAdvice — the happy path", () => {
  it("writes the record and advances the quote in ONE transaction", async () => {
    const store = makeStore()
    const result = await recordAdvice(store.prisma, BASE)

    expect(result).toMatchObject({ ok: true, adviceRecordId: "advice-1", quoteStatus: "ADVICE_RECORDED" })
    // Both statements, or neither: a quote in ADVICE_RECORDED with no record,
    // or a record against a quote still showing QUOTED, are each a control an
    // auditor would read as broken.
    expect(store.create).toHaveBeenCalledTimes(1)
    expect(store.update).toHaveBeenCalledTimes(1)
    expect(store.updated[0]).toMatchObject({ data: { status: "ADVICE_RECORDED" } })
  })

  it("stores a hash the verifier recomputes to the same value", () => {
    const store = makeStore()
    return recordAdvice(store.prisma, BASE).then((result) => {
      expect(result).toMatchObject({ ok: true })
      if (!result.ok) return
      expect(verifyAdviceRecordHash({ ...EVIDENCE, contentHash: result.contentHash })).toEqual({ ok: true })
    })
  })

  it("trims the free text it stores", async () => {
    const store = makeStore()
    await recordAdvice(store.prisma, { ...BASE, needsAnalysis: "  needs  ", recommendation: "  rec  " })
    expect(store.created[0]).toMatchObject({ data: { needsAnalysis: "needs", recommendation: "rec" } })
  })
})

describe("recordAdvice — a record is immutable once written", () => {
  it("refuses a second record rather than updating the first", async () => {
    const store = makeStore({
      quote: {
        id: "quote-1",
        quoteNumber: "QTE-0001",
        status: "ADVICE_RECORDED",
        totalPremium: decimal("83.00"),
        adviceRecord: { id: "advice-existing" },
      },
    })
    const result = await recordAdvice(store.prisma, BASE)

    expect(result).toMatchObject({ ok: false, reason: "ALREADY_RECORDED" })
    // Nothing was written — not an update, not a create.
    expect(store.create).not.toHaveBeenCalled()
    expect(store.update).not.toHaveBeenCalled()
  })
})

describe("recordAdvice — a departure from the recommendation must say why", () => {
  it("refuses CHOSE_ALTERNATIVE with no reason", async () => {
    const store = makeStore()
    const result = await recordAdvice(store.prisma, { ...BASE, clientDecision: "CHOSE_ALTERNATIVE" })

    expect(result).toMatchObject({ ok: false, reason: "REASON_REQUIRED" })
    expect(store.create).not.toHaveBeenCalled()
  })

  it("refuses DECLINED_ADVICE with no reason", async () => {
    const store = makeStore()
    const result = await recordAdvice(store.prisma, { ...BASE, clientDecision: "DECLINED_ADVICE" })
    expect(result).toMatchObject({ ok: false, reason: "REASON_REQUIRED" })
  })

  it("refuses a reason that is only whitespace", async () => {
    const store = makeStore()
    const result = await recordAdvice(store.prisma, {
      ...BASE,
      clientDecision: "CHOSE_ALTERNATIVE",
      reasonIfDifferent: "   ",
    })
    expect(result).toMatchObject({ ok: false, reason: "REASON_REQUIRED" })
  })

  it("accepts a departure that carries its reason", async () => {
    const store = makeStore()
    const result = await recordAdvice(store.prisma, {
      ...BASE,
      clientDecision: "CHOSE_ALTERNATIVE",
      reasonIfDifferent: "Client preferred the larger cover despite the higher premium.",
    })
    expect(result).toMatchObject({ ok: true })
  })

  it("does not demand a reason when the client took the recommendation", async () => {
    const store = makeStore()
    expect(await recordAdvice(store.prisma, BASE)).toMatchObject({ ok: true })
  })
})

describe("recordAdvice — the quote must be in a state where advice means something", () => {
  it("refuses a quote that never priced", async () => {
    // A DRAFT is a quote that failed rating or screening. Advice recorded
    // against it would describe a recommendation of something unsellable.
    const store = makeStore({
      quote: { id: "quote-1", quoteNumber: "QTE-0001", status: "DRAFT", totalPremium: null, adviceRecord: null },
    })
    const result = await recordAdvice(store.prisma, BASE)
    expect(result).toMatchObject({ ok: false, reason: "QUOTE_NOT_ADVISABLE" })
    expect(store.create).not.toHaveBeenCalled()
  })

  it("refuses a rejected quote", async () => {
    const store = makeStore({
      quote: { id: "quote-1", quoteNumber: "QTE-0001", status: "REJECTED", totalPremium: decimal("83.00"), adviceRecord: null },
    })
    expect(await recordAdvice(store.prisma, BASE)).toMatchObject({
      ok: false,
      reason: "QUOTE_NOT_ADVISABLE",
    })
  })

  it("reports a missing quote as not found, never confirming another tenant's id", async () => {
    const store = makeStore({ quote: null })
    expect(await recordAdvice(store.prisma, BASE)).toMatchObject({
      ok: false,
      reason: "QUOTE_NOT_FOUND",
    })
  })

  it("refuses an empty needs analysis or recommendation", async () => {
    const store = makeStore()
    expect(await recordAdvice(store.prisma, { ...BASE, needsAnalysis: "   " })).toMatchObject({
      ok: false,
      reason: "MISSING_FIELD",
    })
    expect(await recordAdvice(store.prisma, { ...BASE, recommendation: "" })).toMatchObject({
      ok: false,
      reason: "MISSING_FIELD",
    })
    expect(store.create).not.toHaveBeenCalled()
  })
})

describe("recordAdvice — a terminal status is never silently overwritten", () => {
  it("rolls back when the quote was rejected between the read and the write", async () => {
    // The race the status guard exists for: a concurrent PATCH .../status moves
    // the quote to REJECTED after recordAdvice read it as QUOTED. An `update`
    // by id would resurrect it as ADVICE_RECORDED, undoing a human decision.
    const store = makeStore({ updateCount: 0 })

    const result = await recordAdvice(store.prisma, BASE)

    expect(result).toMatchObject({ ok: false, reason: "QUOTE_CHANGED" })
  })

  it("guards the UPDATE on the status it read, not on the id alone", async () => {
    const store = makeStore()
    await recordAdvice(store.prisma, BASE)

    expect(store.updated[0]).toMatchObject({
      where: { id: "quote-1", tenantId: "tenant-1", status: "QUOTED" },
      data: { status: "ADVICE_RECORDED" },
    })
  })
})
