// Assembling, rating, screening and persisting a quote.
//
// The shape of the thing: `rate-table.ts` loads the insurer's card,
// `rate-quote.ts` prices against it, `eligibility/evaluate.ts` screens the set,
// and this file is the only one that writes. Nothing here derives a price or
// makes an acceptance decision — the lender is a pure intermediary, and both of
// those belong to the insurer's supplied data.
//
// THE INVARIANT THIS FILE EXISTS TO HOLD:
//
//   A quote that could not be priced is persisted in DRAFT with its failures
//   recorded. It is NEVER persisted as QUOTED with a null or a zero premium.
//
// `rateQuote` already refuses to return a zero — a matched band that resolves
// to nothing is an explicit NON_POSITIVE_PREMIUM failure rather than a free
// policy. That distinction is worth nothing if it is flattened on the way to
// the database, so the mapping here is deliberately narrow: `totalPremium` is
// written from a SUCCESSFUL rating result and from nowhere else. There is no
// `?? 0`, no `|| 0`, and no default anywhere in this file — a nullable column
// is what carries "not priced", precisely so that no zero has to.
//
// Eligibility is held to the same standard. A quote whose lives the insurer
// would refuse is also persisted in DRAFT, with the pass/fail breakdown kept as
// evidence, because QUOTED is a statement that this is sellable and a screened-
// out quote is not. The premium is still recorded when rating succeeded: it is
// a real figure the insurer's card produced, and discarding it would lose the
// evidence of what was quoted and refused.
//
// A quote is therefore QUOTED only when the rate table resolved, EVERY life
// priced, and eligibility passed. Any other outcome is a persisted DRAFT.

import { Prisma } from "@prisma/client"
import type { InsuredLifeType, PrismaClient, QuoteStatus } from "@prisma/client"
import { generateReference } from "@/lib/utils"
import { formatCents, toCents, type MoneyInput } from "../rand-cents"
import { resolveActiveRateTable } from "../rating/rate-table"
import { rateQuote, type QuoteFailure } from "../rating/rate-quote"
import { loadEligibilityRules } from "../eligibility/rules"
import { evaluate, type Failure } from "../eligibility/evaluate"

/** One covered life as the caller supplies it, before rating. */
export interface QuoteLifeRequest {
  /** Caller's handle for this life. Echoed onto failures so they can be shown against the right person. */
  ref: string
  /**
   * Set ONLY where the covered life genuinely is an existing client, typically
   * the main member. Left null for the spouse, children and extended family a
   * funeral quote routinely covers, who have never applied for credit.
   */
  clientId?: string | null
  firstName: string
  lastName: string
  idNumber?: string | null
  dateOfBirth: Date
  relationship: string
  lifeType: InsuredLifeType
  sumAssured: MoneyInput
}

export interface CreateQuoteParams {
  tenantId: string
  /** The client the quote is FOR — the policyholder, not necessarily a covered life. */
  clientId: string
  productId: string
  advisorId?: string | null
  /** The date the cover would start. Ages and the in-force rate card are both resolved against it. */
  effectiveDate: Date
  expiresAt?: Date | null
  lives: QuoteLifeRequest[]
  /** Injectable so a test can pin the number; defaults to the shared reference generator. */
  generateQuoteNumber?: () => string
}

/** Why a quote was persisted in DRAFT rather than QUOTED. */
export type QuoteDraftReason = "RATE_TABLE_UNRESOLVED" | "RATING_FAILED" | "ELIGIBILITY_FAILED"

/**
 * The persisted `ratingFailures` payload.
 *
 * `stage` is carried explicitly because "there was no rate card" and "the card
 * could not price this life" are different operator problems with different
 * fixes, and a bare failure list cannot tell them apart.
 */
export type RatingFailuresRecord =
  | { stage: "RATE_TABLE"; reason: string; detail: string; tableIds: string[] }
  | { stage: "RATING"; failures: QuoteFailure[] }

export interface EligibilityResultRecord {
  pass: boolean
  failures: Failure[]
}

/** A malformed request is not a quote. Nothing is persisted on this outcome. */
export interface QuoteInputRejection {
  ok: false
  reason: "INVALID_INPUT"
  detail: string
  quoteId: null
}

export interface QuotePersisted {
  quoteId: string
  quoteNumber: string
  status: QuoteStatus
  totalPremium: string | null
  totalSumAssured: string | null
  rateTableId: string | null
  eligibility: EligibilityResultRecord
  ratingFailures: RatingFailuresRecord | null
}

export type CreateQuoteResult =
  | QuoteInputRejection
  // QUOTED: rated in full and screened clean.
  | ({ ok: true; reason: null } & QuotePersisted)
  // DRAFT: persisted with the evidence of why it is not sellable.
  | ({ ok: false; reason: QuoteDraftReason } & QuotePersisted)

/** The models this module reads and writes, so a caller may pass a client or a transaction. */
type QuoteStore = Pick<
  PrismaClient,
  "insuranceRateTable" | "insuranceEligibilityRule" | "insuranceQuote"
>

/** How many times a quote-number collision is retried before the caller sees it. */
const QUOTE_NUMBER_ATTEMPTS = 3

/**
 * Normalise the caller's lives, refusing anything the database would round or
 * reject. Done BEFORE any write: a sum assured that cannot be read as a rand
 * amount is a malformed request, not a quote that failed to price, and
 * persisting a DRAFT for it would file a bad request as business evidence.
 */
function normaliseLives(
  lives: QuoteLifeRequest[],
): { ok: true; lives: (QuoteLifeRequest & { sumAssuredFixed: string })[] } | { ok: false; detail: string } {
  if (lives.length === 0) {
    return { ok: false, detail: "A quote must cover at least one life" }
  }

  const seen = new Set<string>()
  const normalised: (QuoteLifeRequest & { sumAssuredFixed: string })[] = []

  for (const life of lives) {
    if (seen.has(life.ref)) {
      return { ok: false, detail: `Life ref "${life.ref}" appears more than once` }
    }
    seen.add(life.ref)

    if (Number.isNaN(life.dateOfBirth.getTime())) {
      return { ok: false, detail: `Life "${life.ref}" has an invalid date of birth` }
    }

    let sumAssuredCents: number
    try {
      sumAssuredCents = toCents(life.sumAssured)
    } catch (error) {
      return { ok: false, detail: `Life "${life.ref}": ${(error as Error).message}` }
    }
    if (sumAssuredCents <= 0) {
      return { ok: false, detail: `Life "${life.ref}" must be covered for more than zero` }
    }

    normalised.push({ ...life, sumAssuredFixed: formatCents(sumAssuredCents) })
  }

  return { ok: true, lives: normalised }
}

/**
 * Create a quote.
 *
 * Always persists, unless the request itself is malformed. The caller reads
 * `ok` to know whether it is sellable and `reason` to know why not.
 */
export async function createQuote(
  prisma: QuoteStore,
  params: CreateQuoteParams,
): Promise<CreateQuoteResult> {
  const {
    tenantId,
    productId,
    advisorId = null,
    effectiveDate,
    expiresAt = null,
    generateQuoteNumber = () => generateReference("QTE"),
  } = params

  const normalised = normaliseLives(params.lives)
  if (!normalised.ok) {
    return { ok: false, reason: "INVALID_INPUT", detail: normalised.detail, quoteId: null }
  }
  const lives = normalised.lives

  // Screening does not depend on the rate card, so it runs whatever happened to
  // the card. An operator whose product has no rate table still needs to see
  // which of the two problems they have — and often has both.
  const rules = await loadEligibilityRules(prisma, { tenantId, productId })
  const eligibility = evaluate({
    rules,
    lives: lives.map((life) => ({
      ref: life.ref,
      lifeType: life.lifeType,
      dateOfBirth: life.dateOfBirth,
      sumAssured: life.sumAssuredFixed,
    })),
    effectiveDate,
  })

  const resolved = await resolveActiveRateTable(prisma, { tenantId, productId, at: effectiveDate })

  if (!resolved.ok) {
    return persist({
      prisma,
      params,
      lives,
      generateQuoteNumber,
      rateTableId: null,
      pricedByRef: new Map(),
      totals: null,
      eligibility,
      ratingFailures: {
        stage: "RATE_TABLE",
        reason: resolved.reason,
        detail: resolved.detail,
        tableIds: resolved.tableIds,
      },
      reason: "RATE_TABLE_UNRESOLVED",
      advisorId,
      expiresAt,
    })
  }

  const rated = rateQuote(
    resolved.table.bands,
    resolved.table.basis,
    lives.map((life) => ({
      ref: life.ref,
      lifeType: life.lifeType,
      dateOfBirth: life.dateOfBirth,
      sumAssured: life.sumAssuredFixed,
    })),
    effectiveDate,
  )

  // Which band priced which life, kept so the pricing basis is reconstructable
  // after the rate card is retired. Populated on the success branch only —
  // `rateQuote` returns a partial `perLife` when some lives failed, and writing
  // those premiums would leave a DRAFT carrying prices for half its family.
  const pricedByRef = new Map<string, { premium: string; bandId: string }>()

  if (!rated.ok) {
    return persist({
      prisma,
      params,
      lives,
      generateQuoteNumber,
      rateTableId: resolved.table.id,
      pricedByRef,
      totals: null,
      eligibility,
      ratingFailures: { stage: "RATING", failures: rated.failures },
      reason: "RATING_FAILED",
      advisorId,
      expiresAt,
    })
  }

  for (const life of rated.perLife) {
    pricedByRef.set(life.ref, { premium: life.premium, bandId: life.bandId })
  }

  // Every life priced. The totals come straight off the rating result — the one
  // place in this file a premium is allowed to originate.
  const totals = { premium: rated.totalPremium, sumAssured: rated.totalSumAssured }

  return persist({
    prisma,
    params,
    lives,
    generateQuoteNumber,
    rateTableId: resolved.table.id,
    pricedByRef,
    totals,
    eligibility,
    ratingFailures: null,
    reason: eligibility.pass ? null : "ELIGIBILITY_FAILED",
    advisorId,
    expiresAt,
  })
}

interface PersistArgs {
  prisma: QuoteStore
  params: CreateQuoteParams
  lives: (QuoteLifeRequest & { sumAssuredFixed: string })[]
  generateQuoteNumber: () => string
  rateTableId: string | null
  pricedByRef: Map<string, { premium: string; bandId: string }>
  totals: { premium: string; sumAssured: string } | null
  eligibility: EligibilityResultRecord
  ratingFailures: RatingFailuresRecord | null
  reason: QuoteDraftReason | null
  advisorId: string | null
  expiresAt: Date | null
}

/**
 * The single write. Quote and lives are created in one nested statement, so a
 * quote never exists without the lives it was priced on.
 *
 * Note what decides the status: `reason === null`. Not the presence of a
 * premium, and not a truthiness test on a total — either of those would read a
 * legitimately-absent premium as a reason to downgrade, or worse, read a
 * present-but-meaningless one as a reason to promote.
 */
async function persist(args: PersistArgs): Promise<CreateQuoteResult> {
  const {
    prisma, params, lives, generateQuoteNumber, rateTableId,
    pricedByRef, totals, eligibility, ratingFailures, reason, advisorId, expiresAt,
  } = args

  const status: QuoteStatus = reason === null ? "QUOTED" : "DRAFT"

  for (let attempt = 1; attempt <= QUOTE_NUMBER_ATTEMPTS; attempt += 1) {
    const quoteNumber = generateQuoteNumber()
    try {
      const quote = await prisma.insuranceQuote.create({
        data: {
          tenantId: params.tenantId,
          clientId: params.clientId,
          productId: params.productId,
          advisorId,
          quoteNumber,
          status,
          rateTableId,
          totalPremium: totals?.premium ?? null,
          totalSumAssured: totals?.sumAssured ?? null,
          eligibilityResult: eligibility as unknown as Prisma.InputJsonValue,
          ratingFailures: (ratingFailures ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          effectiveDate: params.effectiveDate,
          expiresAt,
          lives: {
            create: lives.map((life) => {
              const priced = pricedByRef.get(life.ref)
              return {
                clientId: life.clientId ?? null,
                firstName: life.firstName,
                lastName: life.lastName,
                idNumber: life.idNumber ?? null,
                dateOfBirth: life.dateOfBirth,
                relationship: life.relationship,
                lifeType: life.lifeType,
                sumAssured: life.sumAssuredFixed,
                // Null until rated. The band that produced it travels with it.
                premiumAmount: priced?.premium ?? null,
                rateBandId: priced?.bandId ?? null,
                // PENDING until the bind activates them alongside the policy.
                status: "PENDING" as const,
              }
            }),
          },
        },
        select: { id: true, quoteNumber: true, status: true },
      })

      const persisted: QuotePersisted = {
        quoteId: quote.id,
        quoteNumber: quote.quoteNumber,
        status: quote.status,
        totalPremium: totals?.premium ?? null,
        totalSumAssured: totals?.sumAssured ?? null,
        rateTableId,
        eligibility,
        ratingFailures,
      }

      return reason === null
        ? { ok: true, reason: null, ...persisted }
        : { ok: false, reason, ...persisted }
    } catch (error) {
      // @@unique([tenantId, quoteNumber]). The generator is timestamp-plus-
      // random, so a collision is a retry rather than a fault — but it is not
      // retried forever, because an endless loop against a genuinely broken
      // generator is worse than a surfaced error.
      const collision =
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002" &&
        String(error.meta?.target ?? "").includes("quoteNumber")
      if (!collision || attempt === QUOTE_NUMBER_ATTEMPTS) throw error
    }
  }

  // Unreachable: the loop either returns or throws. Present because TypeScript
  // cannot see that, and a bare `throw` here is more honest than a cast.
  throw new Error("Failed to allocate a unique quote number")
}
