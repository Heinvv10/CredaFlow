import type { Currency } from "./profiles"

/**
 * The house money format, per currency: symbol, a space, comma-grouped, two
 * decimals ("R 1,234.56", "M 1,234.56"). One spelling in every surface, so the
 * amount on screen is character-for-character the amount on a PDF or SMS.
 * ZAR output is unchanged since the first release.
 */
const SYMBOL: Record<Currency, string> = { ZAR: "R", LSL: "M" }

const group = (digits: string) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",")

/** `cents` of `currency`, e.g. 123456 -> "R 1,234.56". */
export function formatMoney(cents: number, currency: Currency): string {
  return `${SYMBOL[currency]} ${group((cents / 100).toFixed(2))}`
}

/** A value held in whole units (form state), cents dropped: "R 1,000,000". */
export function formatMoneyWhole(units: number, currency: Currency): string {
  return `${SYMBOL[currency]} ${group(Math.round(units).toString())}`
}

/** Abbreviated from CENTS for KPI cards: "R2.5m", "M123k", else the full format. */
export function formatMoneyCompact(cents: number, currency: Currency): string {
  const units = cents / 100
  if (units >= 1_000_000) return `${SYMBOL[currency]}${(units / 1_000_000).toFixed(1)}m`
  if (units >= 1_000) return `${SYMBOL[currency]}${(units / 1_000).toFixed(0)}k`
  return formatMoney(cents, currency)
}
