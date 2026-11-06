/**
 * Mobile-money channels (M-Pesa): how a borrower pays from a phone wallet.
 *
 * An adapter only translates to and from its provider's wire format. Every
 * rule about WHEN money is booked (one receipt per provider transaction, an
 * unmatched account reference books nothing, a simulated callback is refused
 * where simulation is not permitted) lives in lib/mobile-money/c2b-ingest.ts,
 * lib/mobile-money/book.ts and the database, never in an adapter.
 */
import type { GuardedIntegration } from "@/lib/integrations/simulation-guard"

export interface StkPushRequest {
  tenantId: string
  /** International digits, e.g. 254712345678. Only the provider ever sees the whole number. */
  msisdn: string
  /** cents; whole shillings only (M-Pesa takes no cents) */
  amountCents: number
  /** The account the payment is for: the loan reference. */
  accountReference: string
}

/** A provider callback, signed as the provider signs it, for delivery through parseCallback. */
export interface SignedCallback {
  rawBody: string
  headers: Headers
}

/**
 * The outcome of asking a provider to prompt the borrower's phone.
 *  - accepted: the prompt was sent; its result arrives as a callback naming
 *    `checkoutRequestId`. The simulated provider hands that callback back in
 *    `callback`, signed, for in-process delivery.
 *  - rejected: no prompt was sent. No money can move.
 */
export type StkPushResult =
  | { kind: "accepted"; checkoutRequestId: string; callback?: SignedCallback }
  | { kind: "rejected"; reason: string }

/**
 * A verified callback. The payer's phone arrives as its last four digits only:
 * the adapter masks it before anything else sees it.
 */
export type MobileMoneyCallback =
  | {
      kind: "C2B"
      transId: string
      /** The account number the payer typed (BillRefNumber), trimmed. */
      billRef: string
      amountCents: number
      msisdnLast4: string | null
      transactedAt: Date | null
    }
  | {
      kind: "STK_PAID"
      checkoutRequestId: string
      transId: string
      amountCents: number
      msisdnLast4: string | null
      transactedAt: Date | null
    }
  | { kind: "STK_CANCELLED"; checkoutRequestId: string; reason: string }

export interface MobileMoneyProvider {
  id: string
  displayName: string
  /**
   * The simulation-guard key when this adapter answers with simulated
   * results; null when it calls the real provider. lib/mobile-money/registry.ts
   * refuses a simulating provider wherever the guard forbids that simulation,
   * and the ingest refuses its callbacks there.
   */
  simulation(): GuardedIntegration | null
  /** The header every authentic callback carries: the webhook refuses a request without it before reading the body. */
  signatureHeader: string
  requestStkPush(request: StkPushRequest): Promise<StkPushResult>
  /**
   * Verifies and parses a callback body for the lender the request reached
   * (`tenantId`, resolved from the host): a callback signed for another lender
   * does not verify. Returns null when the request is not authentic (or not
   * well-formed): an unverifiable callback must never book money.
   */
  parseCallback(args: { rawBody: string; headers: Headers; tenantId: string; now?: Date }): MobileMoneyCallback | null
}

export type MobileMoneyProviderErrorCode = "UNKNOWN_PROVIDER" | "SIMULATION_FORBIDDEN"

export class MobileMoneyProviderError extends Error {
  constructor(readonly code: MobileMoneyProviderErrorCode, message: string) {
    super(message)
    this.name = "MobileMoneyProviderError"
  }
}

/** The last four digits of a phone number, or null. The rest is never stored. */
export function msisdnLast4(raw: unknown): string | null {
  if (typeof raw !== "string" && typeof raw !== "number") return null
  const digits = String(raw).replace(/\D/g, "")
  return digits.length >= 4 ? digits.slice(-4) : null
}

/** The largest amount a cents column (4-byte integer) holds; far above any M-Pesa transaction limit. */
export const MAX_AMOUNT_CENTS = 2_147_483_647

/** A decimal amount string ("100", "100.5", "100.50") as cents; null unless positive, exact and storable. */
export function amountToCents(raw: unknown): number | null {
  const text = typeof raw === "number" ? String(raw) : raw
  if (typeof text !== "string" || !/^\d{1,12}(\.\d{1,2})?$/.test(text.trim())) return null
  const [whole, fraction = ""] = text.trim().split(".")
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"))
  return Number.isSafeInteger(cents) && cents > 0 && cents <= MAX_AMOUNT_CENTS ? cents : null
}
