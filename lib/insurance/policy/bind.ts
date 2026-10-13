// Converting an accepted quote into an in-force policy.
//
// ONE transaction, three facts that must be true together: the policy row
// exists, its `InsuredLife` rows are ACTIVE, and the quote is CONVERTED with
// `convertedPolicyId` pointing at the policy. Any two without the third is a
// state someone has to reconcile by hand — a policy with no covered lives, or
// an accepted quote that can be bound a second time.
//
// PRICE COMES FROM THE QUOTE. Not from the request, not from the product's flat
// columns, not from a recalculation at bind time. The request supplies a quote
// id and a disclosure token and nothing priced, so there is no parameter here
// through which a caller could name their own premium. This is the whole point
// of the phase: the quote is where a price was derived from the insurer's card,
// screened, and shown to a client, and the bind's job is to honour that figure
// rather than to arrive at one.
//
// Re-rating at bind time would be the subtle version of the same mistake. The
// card may have been retired between quote and bind, so re-deriving could
// produce a price the client never saw and never agreed to.
//
// TWO LIVE DB CONSTRAINTS THIS SATISFIES RATHER THAN WORKS AROUND:
//
//   1. CHECK `InsurancePolicy_standalone_fais_required` rejects any
//      STANDALONE row whose `faisDisclosureAt` or `faisDisclosurePdfUrl` is
//      null. The bind therefore runs the SAME
//      draft-token chain the existing policy route runs — it does not invent a
//      disclosure or coerce `policySource` to dodge the constraint.
//   2. UNIQUE `InsurancePolicy_faisDraftTokenHash_key` makes a token
//      single-use. It is checked before the write for a clean refusal and
//      caught as P2002 after it, because the gap between the two is a real
//      TOCTOU window that two concurrent binds can both pass.

import { Prisma } from "@prisma/client"
import type { InsuredLifeType, PrismaClient } from "@prisma/client"
import { toCents } from "../rand-cents"
import { canTransition } from "../quote/lifecycle"
import { hashDraftToken, verifyDraftToken } from "../disclosure-token"
import { loadEligibilityRules } from "../eligibility/rules"
import { evaluate, resolveRule } from "../eligibility/evaluate"
import { sastMonthStart, sastParts } from "@/lib/date/sast"

export interface BindQuoteParams {
  tenantId: string
  quoteId: string
  /**
   * The FAIS disclosure token issued by the draft route and presented to the
   * client. Consumed here: its sha256 is persisted, so it binds exactly once.
   */
  draftToken: string
  /** Cover start. Caller-supplied so a bind is reproducible and a test can pin it. */
  startDate: Date
  /**
   * The instant the bind is judged at. Caller-supplied rather than `new Date()`
   * here, so backdating and expiry are both reproducible and pinnable.
   */
  now?: Date
  boundById?: string | null
}

export type BindRefusal =
  | "QUOTE_NOT_FOUND"
  | "ALREADY_CONVERTED"
  | "NOT_BINDABLE"
  | "NOT_PRICED"
  | "NO_LIVES"
  | "NOT_ELIGIBLE"
  | "WAITING_PERIOD_INVALID"
  | "START_DATE_OUT_OF_RANGE"
  | "QUOTE_EXPIRED"
  | "TOKEN_INVALID"
  | "TOKEN_MISMATCH"
  | "TOKEN_REPLAYED"

export type BindQuoteResult =
  | {
      ok: true
      policyId: string
      policyNumber: string
      premiumAmount: string
      sumAssured: string
      livesActivated: number
      /** Echoed back so the caller's audit row names who bound it. */
      boundById: string | null
    }
  | { ok: false; reason: BindRefusal; detail: string }

type BindStore = Pick<
  PrismaClient,
  "insuranceQuote" | "insurancePolicy" | "insuranceEligibilityRule" | "$transaction"
>

/** Months of premium scheduled at bind, matching the sibling policy writer. */
const PREMIUM_SCHEDULE_MONTHS = 12

const POLICY_NUMBER_ATTEMPTS = 3

/** Policy-number prefixes. Both policy writers (this bind and
 *  app/api/insurance/policies/route.ts) number policies through this. */
const PREFIX_BY_TYPE: Record<string, string> = {
  FUNERAL_COVER: "FUN",
  CREDIT_LIFE: "CRL",
  LIFE_INSURANCE: "LIFE",
}

export function policyNumberPrefix(type: string): string {
  return PREFIX_BY_TYPE[type] ?? "STI"
}

/** Either a resolved waiting period (possibly none), or a refusal to guess. */
export type WaitingPeriodResult =
  | { ok: true; endsAt: Date | null }
  | { ok: false; detail: string }

/**
 * When a life's waiting period ends, from the insurer's WAITING_PERIOD_DAYS
 * term. Resolved per life type, so a product that waives the wait for children
 * is honoured.
 *
 * FAILS CLOSED ON AN UNUSABLE VALUE, and that distinction is the whole point of
 * the result type. This used to return `null` for a term it could not read, and
 * `null` means IMMEDIATE COVER — so a mis-typed rule value silently granted
 * cover from day one that the insurer never granted. If the client then claimed
 * inside that window the insurer would refuse, having been told by the broker
 * that they were covered.
 *
 * `evaluate` does NOT close this: it checks that WAITING_PERIOD_DAYS resolves
 * and carries a value, but never parses that value, because it screens on the
 * four limit types only. So an unusable value passes the screen and reaches
 * here. This is the only guard on it.
 *
 * `endsAt: null` is reserved for the two cases that legitimately mean immediate
 * cover: no term configured for this life type, or one configured as zero.
 */
export function waitingPeriodEndsFor(
  rules: Parameters<typeof resolveRule>[0],
  lifeType: InsuredLifeType,
  startDate: Date,
): WaitingPeriodResult {
  const resolved = resolveRule(rules, "WAITING_PERIOD_DAYS", lifeType)
  if (resolved.status !== "OK") return { ok: true, endsAt: null }

  let days: number
  try {
    // Rule values are stored as rand-scaled decimals; `toCents` is the exact
    // reader for them, so a count of days comes back x100.
    days = toCents(resolved.numericValue) / 100
  } catch (error) {
    return {
      ok: false,
      detail: `WAITING_PERIOD_DAYS for ${lifeType} is configured with an unusable value: ${(error as Error).message}`,
    }
  }
  if (!Number.isFinite(days)) {
    return { ok: false, detail: `WAITING_PERIOD_DAYS for ${lifeType} is not a finite number of days` }
  }
  if (days < 0) {
    return { ok: false, detail: `WAITING_PERIOD_DAYS for ${lifeType} is negative` }
  }
  if (days === 0) return { ok: true, endsAt: null }

  const ends = new Date(startDate)
  ends.setUTCDate(ends.getUTCDate() + Math.round(days))
  return { ok: true, endsAt: ends }
}

/**
 * Bind an ACCEPTED quote to a policy.
 *
 * Every refusal is a returned reason rather than a throw, so the route can name
 * it. The only throws that escape are genuine infrastructure faults.
 */
export async function bindQuote(
  prisma: BindStore,
  params: BindQuoteParams,
): Promise<BindQuoteResult> {
  const { tenantId, quoteId, draftToken, startDate, now = new Date(), boundById = null } = params

  const quote = await prisma.insuranceQuote.findFirst({
    where: { id: quoteId, tenantId },
    select: {
      id: true,
      clientId: true,
      productId: true,
      advisorId: true,
      status: true,
      totalPremium: true,
      totalSumAssured: true,
      effectiveDate: true,
      expiresAt: true,
      convertedPolicyId: true,
      adviceRecord: { select: { id: true } },
      product: { select: { id: true, type: true, commissionRate: true } },
      // dateOfBirth and sumAssured are selected so the bind can RE-SCREEN,
      // not merely to activate the rows.
      lives: { select: { id: true, lifeType: true, dateOfBirth: true, sumAssured: true } },
    },
  })
  if (!quote) {
    return { ok: false, reason: "QUOTE_NOT_FOUND", detail: "Quote not found" }
  }

  // Checked before the transition table so a second bind attempt says what
  // actually happened rather than "CONVERTED is terminal".
  if (quote.convertedPolicyId) {
    return {
      ok: false,
      reason: "ALREADY_CONVERTED",
      detail: `Quote is already bound to policy ${quote.convertedPolicyId}`,
    }
  }

  // `via: "BIND"` is passed explicitly — this is the one caller entitled to it,
  // and the lifecycle defaults every other caller to the constrained "API".
  // It still enforces ACCEPTED as the only source status AND the presence of a
  // record of advice, so neither check is restated here.
  const transition = canTransition(quote.status, "CONVERTED", {
    hasAdviceRecord: quote.adviceRecord !== null,
    via: "BIND",
  })
  if (!transition.ok) {
    return { ok: false, reason: "NOT_BINDABLE", detail: transition.detail }
  }

  // The columns are nullable because a DRAFT quote carries no price. A quote
  // that reached ACCEPTED always has both, so this is unreachable in practice —
  // and it is exactly the guard that keeps it unreachable, because a null here
  // would otherwise become a policy with no premium.
  if (quote.totalPremium === null || quote.totalSumAssured === null) {
    return {
      ok: false,
      reason: "NOT_PRICED",
      detail: "Quote carries no premium — an unpriced quote can never be bound",
    }
  }
  if (quote.lives.length === 0) {
    return { ok: false, reason: "NO_LIVES", detail: "Quote covers no lives" }
  }

  const premiumAmount = quote.totalPremium.toFixed(2)
  const sumAssured = quote.totalSumAssured.toFixed(2)

  // B4 — the start date is BOUNDED.
  //
  // It was accepted unchecked, so `{"startDate":"2024-01-01"}` produced a
  // `waitingPeriodEnds` already in the past — defeating the insurer's mandatory
  // waiting period outright — with cover retroactive to before the quote
  // existed and a `renewalDate` that had already passed, all on an ACTIVE
  // policy. Cover may not start before the quote it was priced from, and may
  // not be backdated at all.
  if (startDate < quote.effectiveDate) {
    return {
      ok: false,
      reason: "START_DATE_OUT_OF_RANGE",
      detail: `Cover cannot start (${startDate.toISOString()}) before the quote's effective date (${quote.effectiveDate.toISOString()})`,
    }
  }
  if (startDate < now) {
    return {
      ok: false,
      reason: "START_DATE_OUT_OF_RANGE",
      detail: "Cover cannot be backdated — a waiting period that has already elapsed is not a waiting period",
    }
  }

  // B5 — an expired quote does not bind.
  //
  // `expiresAt` was written by the quote path and read by nothing, so a quote
  // priced against a rate card retired long ago stayed bindable at that stale
  // premium — and the bind deliberately does NOT re-rate, so nothing else would
  // have caught it. Enforced here, at the only place that turns a quote into
  // cover.
  if (quote.expiresAt !== null && quote.expiresAt <= now) {
    return {
      ok: false,
      reason: "QUOTE_EXPIRED",
      detail: `This quote expired on ${quote.expiresAt.toISOString()}. Re-quote at current rates.`,
    }
  }

  // ── The FAIS chain. Same token mechanism the existing policy route uses. ──
  const verification = verifyDraftToken(draftToken)
  if (!verification.ok) {
    return {
      ok: false,
      reason: "TOKEN_INVALID",
      detail: `FAIS disclosure token is not usable: ${verification.reason}`,
    }
  }

  // The token's figures must be the QUOTE's figures. This is what makes "price
  // comes from the quote" structural rather than merely intended: the disclosure
  // the client was actually shown has to carry the same numbers, so a token
  // minted for a different amount cannot be redeemed against this quote.
  // Compared in INTEGER CENTS, never as rands.
  //
  // Both sides happen to round-trip identically today, so `===` on the rand
  // floats would pass — which is exactly what makes it a trap rather than a
  // bug: it works until a figure appears that a float cannot hold exactly, and
  // then it refuses a legitimate bind with no explanation. `toCents` is the
  // exact reader and accepts a number, a string or a Prisma Decimal, so it also
  // survives a quote column arriving as the string `Decimal.toJSON()` emits.
  const p = verification.payload
  const mismatch =
    // Asserted explicitly rather than left to cuid global uniqueness. A token
    // minted for another tenant cannot collide on clientId today, so this is
    // not currently exploitable — but every other invariant in this file is
    // pinned down rather than inferred, and a guard resting on an implicit
    // property of an id format is one refactor away from resting on nothing.
    // The token must name THIS quote. A legacy single-life token carries no
    // quoteId at all and is therefore refused outright, which is intended: a
    // disclosure issued for one client's standalone policy is not evidence
    // that a family quote's lives and prices were shown to anybody.
    p.quoteId !== quote.id ||
    p.tenantId !== tenantId ||
    p.clientId !== quote.clientId ||
    p.productId !== quote.productId ||
    // The sibling FAIS gate in app/api/insurance/policies/route.ts checks type
    // too. A token disclosing FUNERAL_COVER must not bind a LIFE_INSURANCE
    // policy: the client was shown terms for a different product.
    p.type !== quote.product.type ||
    toCents(p.premiumAmount) !== toCents(premiumAmount) ||
    toCents(p.sumAssured) !== toCents(sumAssured)
  if (mismatch) {
    return {
      ok: false,
      reason: "TOKEN_MISMATCH",
      detail: "The FAIS disclosure presented to the client does not match this quote",
    }
  }

  const faisDraftTokenHash = hashDraftToken(draftToken)
  const replayed = await prisma.insurancePolicy.findUnique({
    where: { faisDraftTokenHash, tenantId },
    select: { id: true },
  })
  if (replayed) {
    return {
      ok: false,
      reason: "TOKEN_REPLAYED",
      detail: "This FAIS disclosure token has already been used to bind a policy",
    }
  }

  const rules = await loadEligibilityRules(prisma, { tenantId, productId: quote.productId })

  // RE-SCREEN at the bind, against the insurer's CURRENT terms.
  //
  // The quote's status is not evidence. It was set by an earlier request, and
  // the whole B2 finding was that a status can be moved by a caller who never
  // passed the screen. Re-running `evaluate` here means the terminal act — the
  // one that creates a real policy and takes real money — proves for itself
  // that the insurer would accept these lives, rather than trusting a flag some
  // other request wrote. It also catches the honest case: terms that changed
  // between quote and bind.
  //
  // Deliberately NOT a re-rate. The PRICE stays the persisted one, because the
  // client agreed to that figure; only ACCEPTABILITY is re-checked.
  const screen = evaluate({
    rules,
    lives: quote.lives.map((life) => ({
      ref: life.id,
      lifeType: life.lifeType,
      dateOfBirth: life.dateOfBirth,
      sumAssured: life.sumAssured,
    })),
    effectiveDate: quote.effectiveDate,
  })
  if (!screen.pass) {
    return {
      ok: false,
      reason: "NOT_ELIGIBLE",
      detail: `The insurer's acceptance terms refuse this quote: ${screen.failures.map((f) => f.detail).join("; ")}`,
    }
  }

  // Resolved up front, so an unusable term refuses the bind rather than being
  // discovered halfway through writing a policy.
  const waitingPeriods = new Map<string, Date | null>()
  for (const life of quote.lives) {
    const waiting = waitingPeriodEndsFor(rules, life.lifeType, startDate)
    if (!waiting.ok) {
      return { ok: false, reason: "WAITING_PERIOD_INVALID", detail: waiting.detail }
    }
    waitingPeriods.set(life.id, waiting.endsAt)
  }

  const renewalDate = new Date(startDate)
  renewalDate.setUTCFullYear(renewalDate.getUTCFullYear() + 1)

  const type = quote.product.type
  const prefix = policyNumberPrefix(type)
  const commissionRate = Number(quote.product.commissionRate)

  for (let attempt = 1; attempt <= POLICY_NUMBER_ATTEMPTS; attempt += 1) {
    const count = await prisma.insurancePolicy.count({ where: { tenantId } })
    const policyNumber = `${prefix}-${String(count + 1).padStart(4, "0")}`

    try {
      const policy = await prisma.$transaction(async (tx) => {
        const created = await tx.insurancePolicy.create({
          data: {
            tenantId,
            policyNumber,
            clientId: quote.clientId,
            productId: quote.productId,
            advisorId: quote.advisorId,
            type,
            status: "ACTIVE",
            // From the quote. There is no request-body path to either figure.
            premiumAmount,
            sumAssured,
            startDate,
            renewalDate,
            commissionRate,
            commissionAmount: (Number(premiumAmount) * commissionRate).toFixed(2),
            // The CHECK constraint requires all three on a STANDALONE row.
            policySource: "STANDALONE",
            faisDisclosureAt: new Date(),
            faisDisclosurePdfUrl: `/api/insurance/disclosures/${draftToken}`,
            faisDraftTokenHash,
          },
          select: { id: true, policyNumber: true },
        })

        // Lives move to the policy AND to ACTIVE together. Re-reading quoteId
        // in the WHERE clause keeps a concurrent bind of another quote from
        // capturing these rows.
        for (const life of quote.lives) {
          await tx.insuredLife.update({
            where: { id: life.id },
            data: {
              policyId: created.id,
              status: "ACTIVE",
              waitingPeriodEnds: waitingPeriods.get(life.id) ?? null,
            },
          })
        }

        // P2 — the premium schedule. Without it a policy is ACTIVE with no
        // PremiumPayment rows, and app/api/cron/insurance-renewal selects on
        // `premiumPayments: { some: ... }` — so the policy is invisible to it
        // and will never lapse, never renew and never bill.
        //
        // Same 12-month shape as the sibling writer in
        // app/api/insurance/policies, and now the same SAST arithmetic. This
        // was `setUTCMonth` + `setUTCDate(1)`: UTC's 1st, carrying the start
        // instant's time of day. For a policy bound at 22:30 SAST that is
        // 20:30Z, so the row read as the 1st in UTC and the 1st in SAST — but
        // bind it at 00:30 SAST and the same arithmetic lands the premium on
        // the 2nd. Two policies bound minutes apart through different routes
        // would otherwise carry due dates on different South African days, on
        // rows the policyholder is shown.
        const { year: startYear, month: startMonth } = sastParts(startDate)
        await tx.premiumPayment.createMany({
          data: Array.from({ length: PREMIUM_SCHEDULE_MONTHS }, (_, month) => {
            const dueDate = sastMonthStart(startYear, startMonth + month + 1)
            return {
              tenantId,
              policyId: created.id,
              amount: premiumAmount,
              dueDate,
              status: "DUE" as const,
            }
          }),
        })

        // P2 — the advisor's commission.
        //
        // COMPUTED ON PREMIUM, not on sum assured. An intermediary earns a
        // percentage of premium collected; 15% of R20 000 of cover on an R83
        // policy would be R3 000, which is not a commission. The legacy writer
        // uses premium for the AdvisorCommission row too (policies/route.ts:344)
        // and sum assured only for the policy's own column — that column is a
        // pre-existing defect recorded for Phase 3, not a second basis to copy.
        if (quote.advisorId && commissionRate > 0) {
          const period = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`
          try {
            await tx.advisorCommission.create({
              data: {
                tenantId,
                advisorId: quote.advisorId,
                policyId: created.id,
                period,
                amount: (Number(premiumAmount) * commissionRate).toFixed(2),
                rate: commissionRate,
                premiumBase: premiumAmount,
                status: "PENDING",
              },
            })
          } catch (error) {
            // @@unique([advisorId, policyId, period]) — a commission already
            // exists for this advisor, policy and month. Swallowed rather than
            // failing the bind, matching the sibling: the policy is the thing
            // that must exist, and a duplicate commission row is not a reason
            // to refuse cover the client has paid for.
            if (
              !(error instanceof Prisma.PrismaClientKnownRequestError) ||
              error.code !== "P2002"
            ) {
              throw error
            }
          }
        }

        // The quote's own status check is repeated here, in the WHERE clause,
        // because the read at the top of this function is not a lock: two
        // concurrent binds can both have seen ACCEPTED. A count of 0 means the
        // other one committed first, and this transaction must roll back
        // rather than mint a second policy for one quote.
        const converted = await tx.insuranceQuote.updateMany({
          where: { id: quote.id, tenantId, status: quote.status, convertedPolicyId: null },
          data: { status: "CONVERTED", convertedPolicyId: created.id },
        })
        if (converted.count === 0) {
          throw new ConcurrentBind()
        }

        return created
      })

      return {
        ok: true,
        policyId: policy.id,
        policyNumber: policy.policyNumber,
        premiumAmount,
        sumAssured,
        livesActivated: quote.lives.length,
        boundById,
      }
    } catch (error) {
      if (error instanceof ConcurrentBind) {
        return {
          ok: false,
          reason: "ALREADY_CONVERTED",
          detail: "The quote was bound concurrently by another request",
        }
      }

      const target =
        error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"
          ? String(error.meta?.target ?? "")
          : null

      // The racy half of the replay check above. NOT retried — a retry would
      // be a second attempt to spend a token already spent.
      if (target?.includes("faisDraftTokenHash")) {
        return {
          ok: false,
          reason: "TOKEN_REPLAYED",
          detail: "This FAIS disclosure token has already been used to bind a policy",
        }
      }

      // A policy-number collision is a retry; anything else is real.
      if (!target?.includes("policyNumber") || attempt === POLICY_NUMBER_ATTEMPTS) throw error
    }
  }

  throw new Error("Failed to allocate a unique policy number")
}

/** Signals that another request converted this quote first; rolls the transaction back. */
class ConcurrentBind extends Error {
  constructor() {
    super("Quote was converted concurrently")
    this.name = "ConcurrentBind"
  }
}
