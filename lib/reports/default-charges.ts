import type { ChargeType } from "@/lib/loan/default-charges"
import { isBalanceWaiver } from "@/lib/payments/waiver"
import { sastParts } from "@/lib/date/sast"

/**
 * The Default charges report: per SAST calendar month and loan product, what
 * was accrued, collected (cash), waived, left outstanding, and exempted.
 * ALL money is CENTS. Pure — the queries are lib/reports/default-charges-loader.ts.
 *
 * History is as currently derived: LoanCharge rows and receipt splits are
 * rewritten on every sync, so a later reversal or exemption changes the months
 * it reaches back into.
 */

export interface DefaultChargesInput {
  products: Map<string, string>
  now: Date
  /** TenantConfig.defaultChargesStoppedAt: nothing is collected from then on */
  stoppedAt: Date | null
  charges: Array<{ productId: string; type: ChargeType; day: Date; amount: number }>
  receipts: Array<{
    productId: string
    receivedAt: Date
    paymentMethod: string
    reversed: boolean
    allocationStatus: string
    defaultInterestAllocated: number
    chargeFeesAllocated: number
  }>
  /** DEFAULT_CHARGES_EXEMPTION_CHANGED audit rows */
  exemptions: Array<{ productId: string; at: Date; from: boolean; to: boolean }>
  /** PAYMENT_REFUND_DUE_SPLIT audit rows: charges already paid, owed back */
  refunds: Array<{ productId: string; at: Date; cents: number }>
}

export interface DefaultChargesMonth {
  month: string
  interest: number
  fees: number
  letters: number
  accrued: number
  collected: number
  waived: number
  outstanding: number
  exemptionsSet: number
  exemptionsLifted: number
  refundDue: number
}

export type DefaultChargesRow = DefaultChargesMonth & { productId: string; productName: string }

const FLOWS = ["interest", "fees", "letters", "accrued", "collected", "waived", "exemptionsSet", "exemptionsLifted", "refundDue"] as const

export function sastMonthKey(instant: Date): string {
  const { year, month } = sastParts(instant)
  return `${year}-${String(month + 1).padStart(2, "0")}`
}

function nextMonth(key: string): string {
  const [year, month] = key.split("-").map(Number)
  return month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, "0")}`
}

const emptyMonth = (month: string): DefaultChargesMonth => ({
  month, interest: 0, fees: 0, letters: 0, accrued: 0, collected: 0, waived: 0,
  outstanding: 0, exemptionsSet: 0, exemptionsLifted: 0, refundDue: 0,
})

export function defaultChargesByMonth(input: DefaultChargesInput): { rows: DefaultChargesRow[]; months: DefaultChargesMonth[] } {
  const flows = new Map<string, DefaultChargesMonth>()
  const add = (productId: string, at: Date, apply: (m: DefaultChargesMonth) => void) => {
    const month = sastMonthKey(at)
    const key = `${month}|${productId}`
    const entry = flows.get(key) ?? emptyMonth(month)
    apply(entry)
    flows.set(key, entry)
  }

  for (const c of input.charges) {
    add(c.productId, c.day, (m) => {
      if (c.type === "DEFAULT_INTEREST") m.interest += c.amount
      else if (c.type === "SERVICE_FEE" || c.type === "COLLECTION_FEE") m.fees += c.amount
      else m.letters += c.amount
      m.accrued += c.amount
    })
  }
  for (const r of input.receipts) {
    const paid = r.defaultInterestAllocated + r.chargeFeesAllocated
    if (r.reversed || r.allocationStatus !== "ALLOCATED" || paid === 0) continue
    add(r.productId, r.receivedAt, (m) => {
      if (isBalanceWaiver(r.paymentMethod)) m.waived += paid
      else m.collected += paid
    })
  }
  for (const e of input.exemptions) {
    if (e.from === e.to) continue
    add(e.productId, e.at, (m) => {
      if (e.to) m.exemptionsSet += 1
      else m.exemptionsLifted += 1
    })
  }
  for (const r of input.refunds) add(r.productId, r.at, (m) => { m.refundDue += r.cents })

  const keys = [...flows.keys()].map((k) => k.split("|") as [string, string])
  if (keys.length === 0) return { rows: [], months: [] }
  const last = sastMonthKey(input.now)
  const stopMonth = input.stoppedAt ? sastMonthKey(input.stoppedAt) : null
  const productIds = [...new Set(keys.map(([, p]) => p))].sort((a, b) =>
    (input.products.get(a) ?? a).localeCompare(input.products.get(b) ?? b))

  const rows: DefaultChargesRow[] = []
  const months: DefaultChargesMonth[] = []
  const running = new Map<string, number>()
  const started = new Set<string>()
  let month = keys.map(([m]) => m).sort()[0]
  for (; month <= last; month = nextMonth(month)) {
    const total = emptyMonth(month)
    for (const productId of productIds) {
      const entry = flows.get(`${month}|${productId}`)
      if (entry) started.add(productId)
      if (!started.has(productId)) continue
      const m = entry ?? emptyMonth(month)
      const balance = (running.get(productId) ?? 0) + m.accrued - m.collected - m.waived
      running.set(productId, balance)
      // Once charges were stopped, unpaid charges are not collected: nothing is shown owing.
      m.outstanding = stopMonth !== null && month >= stopMonth ? 0 : balance
      rows.push({ ...m, productId, productName: input.products.get(productId) ?? "Unknown product" })
      for (const f of FLOWS) total[f] += m[f]
      total.outstanding += m.outstanding
    }
    months.push(total)
  }
  return { rows, months }
}
