import { createHash } from "node:crypto"
import { UNKNOWN_SUBSCRIBER, type BureauAccount } from "@/lib/integrations/bureau-accounts"
import type { BureauReport, BureauTradeline } from "./types"

/** SHA-256 of a raw response (string as sent, anything else as JSON); null when there was none. */
export function rawPayloadSha256(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null
  const text = typeof raw === "string" ? raw : JSON.stringify(raw)
  return createHash("sha256").update(text).digest("hex")
}

/** Integer cents from a bureau amount in RANDS; non-numbers count as zero. */
export function randsToCents(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value * 100) : 0
}

/**
 * The monthly instalments the bureau shows the consumer paying, in cents —
 * the figure affordability takes as `bureauObligationsCents`.
 *
 * RULE: the larger of (a) the total the bureau states and (b) the sum of the
 * instalments on tradelines that are open or of unknown status. Taking the
 * larger means a bureau total that leaves accounts out, or a tradeline list
 * cut short, can never lower the consumer's debt. Unknown counts as open for
 * the same reason (reckless-lending risk sits on the side of understating).
 *
 * Null when the report carries neither a total nor a tradeline, so a report
 * that says nothing about debt is not mistaken for one that says "none": it
 * is stored as `totalMonthly: null` and the bureau gate sends it to manual
 * review (lib/decision/bureau-gate.ts). A negative amount (a credit balance,
 * a parse error) never offsets real debt: each is counted as zero.
 *
 * Affordability then uses max(application debts, client-record debts, this):
 * lib/decision/affordability-gate.ts and the database's approval verifier
 * (GREATEST(declared_debt, bureau_debt)) both apply it.
 */
export function bureauInstalmentTotalCents(
  report: Pick<BureauReport, "tradelines" | "statedMonthlyInstalmentCents">,
): number | null {
  const counted = report.tradelines.filter((t) => t.open !== false)
  // An open account whose amount could not be read makes the whole figure
  // unknown: any number here would understate it.
  if (counted.some((t) => t.instalmentCents === null)) return null
  const summed = counted.reduce((sum, t) => sum + nonNegative(t.instalmentCents ?? 0), 0)
  if (report.statedMonthlyInstalmentCents == null && report.tradelines.length === 0) return null
  return Math.max(nonNegative(report.statedMonthlyInstalmentCents ?? 0), summed)
}

function nonNegative(cents: number): number {
  return Number.isFinite(cents) && cents > 0 ? cents : 0
}

/**
 * The account list the credit checks read (lib/credit-checks/load-facts.ts):
 * named accounts with a readable amount only, since they match debit orders
 * by creditor name and amount. The debt total above counts every account.
 */
export function tradelineAccounts(tradelines: readonly BureauTradeline[]): BureauAccount[] {
  return tradelines.flatMap((t) =>
    t.subscriber !== UNKNOWN_SUBSCRIBER && t.instalmentCents !== null
      ? [{ subscriber: t.subscriber, accountType: t.accountType, instalmentCents: t.instalmentCents, status: t.status }]
      : [])
}

/** Replace SA-ID-shaped digit runs: provider error text can echo the request. */
export function redactIdNumbers(text: string): string {
  return text.replace(/\d{13}/g, "[id]").slice(0, 500)
}
