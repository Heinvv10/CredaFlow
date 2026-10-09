// The FAIS Record of Advice.
//
// A statutory obligation, not a courtesy. An intermediary that gives advice
// must record the client's needs, what it considered, what it recommended, and
// what the client decided — including where the client went against the
// recommendation. That is the whole point of `reasonIfDifferent`: the record
// has to be able to say "we advised X, they chose Y, here is why", because a
// record that can only describe agreement is evidence of nothing.
//
// IMMUTABILITY. Once written a record is never updated. A correction is a NEW
// record, the same discipline rate table versions follow. `InsuranceAdviceRecord
// .quoteId` is `@unique`, so in practice a correction means re-quoting and
// advising afresh — the second record hangs off the second quote. That is the
// intended shape and not an accident of the schema: the advice given was given
// against a specific set of prices and lives, so an amended record against the
// original quote would claim different advice was given at the moment those
// prices were shown. `recordAdvice` therefore refuses outright when a record
// already exists rather than updating in place.
//
// The `contentHash` reuses the evidence pattern established by
// `createCreditLifeDisclosureSha256`: canonical JSON with a FIXED key order,
// hashed sha256 and stored as hex. Same mechanism, same reason — a stored PDF
// can be proved to be the document that was actually presented. Key order is
// load-bearing: `JSON.stringify` emits keys in insertion order, so reordering
// the object literal below silently invalidates every hash already stored.

import { createHash } from "node:crypto"
import { Prisma } from "@prisma/client"
import type { ClientDecision, PrismaClient, QuoteStatus } from "@prisma/client"
import { canTransition } from "../quote/lifecycle"

/**
 * What the hash is taken over: the advice itself, and the quote it was given
 * against. The quote number and its total premium are included deliberately —
 * advice is only meaningful against the figures the client was shown, so a
 * record whose quote was re-priced must not still verify.
 */
export interface AdviceEvidence {
  quoteId: string
  quoteNumber: string
  totalPremium: string | null
  needsAnalysis: string
  productsConsidered: unknown
  recommendation: string
  clientDecision: ClientDecision
  reasonIfDifferent: string | null
}

/**
 * sha256 over the canonical advice payload, hex-encoded.
 *
 * Mirrors `createCreditLifeDisclosureSha256` in
 * `lib/insurance/credit-life-election.server.ts`. DO NOT REORDER THESE KEYS —
 * see the note at the top of the file.
 */
export function createAdviceRecordSha256(evidence: AdviceEvidence): string {
  const canonical = JSON.stringify({
    quoteId: evidence.quoteId,
    quoteNumber: evidence.quoteNumber,
    totalPremium: evidence.totalPremium,
    needsAnalysis: evidence.needsAnalysis,
    productsConsidered: evidence.productsConsidered,
    recommendation: evidence.recommendation,
    clientDecision: evidence.clientDecision,
    reasonIfDifferent: evidence.reasonIfDifferent,
  })
  return createHash("sha256").update(canonical, "utf8").digest("hex")
}

/**
 * Decisions that mean the client did not take the recommendation, and must
 * therefore say why. A record that noted a departure without its reason would
 * satisfy the column and defeat the obligation.
 */
const DECISIONS_REQUIRING_REASON: readonly ClientDecision[] = [
  "CHOSE_ALTERNATIVE",
  "DECLINED_ADVICE",
]

export interface RecordAdviceParams {
  tenantId: string
  quoteId: string
  needsAnalysis: string
  productsConsidered: unknown
  recommendation: string
  clientDecision: ClientDecision
  reasonIfDifferent?: string | null
  pdfUrl?: string | null
  recordedById?: string | null
}

export type RecordAdviceRefusal =
  | "QUOTE_NOT_FOUND"
  | "QUOTE_CHANGED"
  | "ALREADY_RECORDED"
  | "REASON_REQUIRED"
  | "MISSING_FIELD"
  | "QUOTE_NOT_ADVISABLE"

export type RecordAdviceResult =
  | {
      ok: true
      adviceRecordId: string
      contentHash: string
      quoteStatus: QuoteStatus
    }
  | { ok: false; reason: RecordAdviceRefusal; detail: string }

type AdviceStore = Pick<PrismaClient, "insuranceQuote" | "insuranceAdviceRecord" | "$transaction">

/**
 * Write the record of advice for a quote, and advance the quote to
 * ADVICE_RECORDED in the same transaction.
 *
 * One transaction because the two facts are one fact: a quote sitting in
 * ADVICE_RECORDED with no record, or a record attached to a quote still showing
 * QUOTED, are both states an auditor would read as a control that does not work.
 */
export async function recordAdvice(
  prisma: AdviceStore,
  params: RecordAdviceParams,
): Promise<RecordAdviceResult> {
  const needsAnalysis = params.needsAnalysis?.trim() ?? ""
  const recommendation = params.recommendation?.trim() ?? ""
  const reasonIfDifferent = params.reasonIfDifferent?.trim() || null

  if (!needsAnalysis || !recommendation) {
    return {
      ok: false,
      reason: "MISSING_FIELD",
      detail: "needsAnalysis and recommendation are both required",
    }
  }

  if (DECISIONS_REQUIRING_REASON.includes(params.clientDecision) && !reasonIfDifferent) {
    return {
      ok: false,
      reason: "REASON_REQUIRED",
      detail: `clientDecision ${params.clientDecision} requires reasonIfDifferent`,
    }
  }

  // Tenant-scoped: a quote belonging to another tenant is NOT_FOUND, never a
  // refusal that would confirm the id exists.
  const quote = await prisma.insuranceQuote.findFirst({
    where: { id: params.quoteId, tenantId: params.tenantId },
    select: {
      id: true,
      quoteNumber: true,
      status: true,
      totalPremium: true,
      adviceRecord: { select: { id: true } },
    },
  })
  if (!quote) {
    return { ok: false, reason: "QUOTE_NOT_FOUND", detail: "Quote not found" }
  }

  if (quote.adviceRecord) {
    return {
      ok: false,
      reason: "ALREADY_RECORDED",
      detail:
        "This quote already has a record of advice. A record is immutable — a correction is a new quote with a new record.",
    }
  }

  // The transition table is the authority on whether this quote may reach
  // ADVICE_RECORDED at all, so a DRAFT that never priced, or a REJECTED quote,
  // is refused here rather than acquiring advice it can never act on.
  // `hasAdviceRecord` is declared true because this call is what creates it.
  const transition = canTransition(quote.status, "ADVICE_RECORDED", { hasAdviceRecord: true })
  if (!transition.ok) {
    return { ok: false, reason: "QUOTE_NOT_ADVISABLE", detail: transition.detail }
  }

  const contentHash = createAdviceRecordSha256({
    quoteId: quote.id,
    quoteNumber: quote.quoteNumber,
    // Decimal to string, so the hash is over the figure as stored rather than
    // over a float that lost the last cent on the way through.
    totalPremium: quote.totalPremium === null ? null : quote.totalPremium.toFixed(2),
    needsAnalysis,
    productsConsidered: params.productsConsidered,
    recommendation,
    clientDecision: params.clientDecision,
    reasonIfDifferent,
  })

  // Interactive transaction, not the array form, and `updateMany` with the
  // expected status in the WHERE clause rather than `update` by id.
  //
  // The read at the top of this function is not a lock. Between it and this
  // write, a concurrent PATCH .../status can move the quote to REJECTED or
  // EXPIRED — and an `update` by id alone would happily overwrite that terminal
  // status back to ADVICE_RECORDED, silently resurrecting a quote a human just
  // killed. A count of 0 means someone else moved it, and the whole transaction
  // rolls back so no orphan advice record survives. The sibling at
  // app/api/insurance/quotes/[id]/status/route.ts already guards this way.
  let record: { id: string }
  try {
    record = await prisma.$transaction(async (tx) => {
      const created = await tx.insuranceAdviceRecord.create({
        data: {
          tenantId: params.tenantId,
          quoteId: quote.id,
          needsAnalysis,
          productsConsidered: params.productsConsidered as Prisma.InputJsonValue,
          recommendation,
          clientDecision: params.clientDecision,
          reasonIfDifferent,
          pdfUrl: params.pdfUrl ?? null,
          contentHash,
          recordedById: params.recordedById ?? null,
        },
        select: { id: true },
      })

      const advanced = await tx.insuranceQuote.updateMany({
        where: { id: quote.id, tenantId: params.tenantId, status: quote.status },
        data: { status: "ADVICE_RECORDED" },
      })
      if (advanced.count === 0) throw new ConcurrentQuoteChange()

      return created
    })
  } catch (error) {
    if (error instanceof ConcurrentQuoteChange) {
      return {
        ok: false,
        reason: "QUOTE_CHANGED",
        detail: "The quote changed status concurrently, so no advice was recorded. Re-read it and retry.",
      }
    }
    throw error
  }

  return {
    ok: true,
    adviceRecordId: record.id,
    contentHash,
    quoteStatus: "ADVICE_RECORDED",
  }
}

/**
 * Does a stored record still match the advice it claims to record?
 *
 * The read side of the evidence pattern, mirroring how the credit life
 * disclosure is verified: recompute over the stored fields and compare. A
 * mismatch means the row was edited after the fact — which the write path
 * forbids, so this is the detector for it having happened anyway.
 */
export function verifyAdviceRecordHash(
  stored: { contentHash: string | null } & AdviceEvidence,
): { ok: true } | { ok: false; reason: "NO_HASH" | "HASH_MISMATCH"; expected?: string } {
  if (!stored.contentHash) return { ok: false, reason: "NO_HASH" }
  const expected = createAdviceRecordSha256(stored)
  if (expected !== stored.contentHash) return { ok: false, reason: "HASH_MISMATCH", expected }
  return { ok: true }
}

/** Signals that another request moved the quote first; rolls the transaction back. */
class ConcurrentQuoteChange extends Error {
  constructor() {
    super("Quote status changed concurrently")
    this.name = "ConcurrentQuoteChange"
  }
}
