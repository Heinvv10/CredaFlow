/** The post-check's shared primitives (post-check.ts). */
export interface Allowed {
  /** Amounts in cents, signed: "-R450.00" is allowed only as written, never as "R450.00". */
  amountsCents: Iterable<number>
  /** The amounts that are a month's figure: only these may be called monthly ("R500.00 a month"). */
  monthlyAmountsCents?: Iterable<number>
  /** Amounts that are money in, and money out: a sentence about receiving may not cite money out, nor the reverse. */
  inAmountsCents?: Iterable<number>
  outAmountsCents?: Iterable<number>
  /** Percentages as written, e.g. 12.5 for "12.5%". */
  percents?: Iterable<number>
  /** Plain numbers: counts, days, years. */
  numbers?: Iterable<number>
  /** YYYY-MM-DD */
  dates?: Iterable<string>
  /** YYYY-MM */
  months?: Iterable<string>
  /** Whole tokens copied from the input that may contain digits (row refs "S1-R12", flag codes, query ids). */
  literals?: Iterable<string>
}

export type CheckResult = { ok: true } | { ok: false; reason: string }

export const OK: CheckResult = { ok: true }
export const fail = (reason: string): CheckResult => ({ ok: false, reason })

/**
 * Text as the checks read it: compatibility forms folded (full-width digits
 * become ASCII), invisible format characters removed (a zero-width space
 * inside "fine" must not hide it), every dash a hyphen, whitespace collapsed.
 */
export function norm(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    .replace(/[‐-―−﹣－]/g, "-")
    .replace(/\s+/g, " ")
}

export const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** Removes each literal where it stands as a whole token ("S1-R12" is not removed from "S1-R129"). */
export function stripLiterals(text: string, literals: Iterable<string>): string {
  let out = text
  for (const lit of [...new Set(literals)].map(norm).filter((l) => l.trim()).sort((a, b) => b.length - a.length)) {
    out = out.replace(new RegExp(`(?<![\\w-])${escape(lit)}(?![\\w-])`, "g"), " ")
  }
  return out
}
