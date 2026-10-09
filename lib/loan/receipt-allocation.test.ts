import { describe, expect, it } from "vitest"
import { allocateReceipt, type AllocationRow } from "./receipt-allocation"

const principalOf = (rows: AllocationRow[], paid: number[]) =>
  rows.map((row, i) => Math.min(row.principalDue, Math.max(0, paid[i] - (row.totalDue - row.principalDue))))

describe("allocateReceipt", () => {
  const rows: AllocationRow[] = [
    { dueDay: 10, principalDue: 100_000, interestDue: 10_000, totalDue: 115_000 },
    { dueDay: 40, principalDue: 100_000, interestDue: 10_000, totalDue: 115_000 },
    { dueDay: 70, principalDue: 100_000, interestDue: 10_000, totalDue: 115_000 },
  ]

  it("s126(3): default and due contractual interest, then charges and due fees, then due principal, then the instalments not yet due", () => {
    const paid = [0, 0, 0]
    const split = allocateReceipt({ amount: 260_000, day: 40, defaultInterestOwed: 3_000, chargesOwed: 8_200, rows, paid, s126: true })
    expect(split).toEqual({ toDefaultInterest: 3_000, toFees: 8_200, toSchedule: 248_800, unallocated: 0 })
    expect(paid).toEqual([115_000, 115_000, 18_800])
  })

  it("stops at each tier: a receipt that covers only the due interest pays no charge", () => {
    const paid = [0, 0, 0]
    expect(allocateReceipt({ amount: 23_000, day: 40, defaultInterestOwed: 3_000, chargesOwed: 8_200, rows, paid, s126: true }))
      .toEqual({ toDefaultInterest: 3_000, toFees: 0, toSchedule: 20_000, unallocated: 0 })
    expect(paid).toEqual([10_000, 10_000, 0])
  })

  it("legacy: default interest, charges, then the schedule instalment by instalment", () => {
    const paid = [0, 0, 0]
    expect(allocateReceipt({ amount: 23_000, day: 40, defaultInterestOwed: 3_000, chargesOwed: 8_200, rows, paid, s126: false }))
      .toEqual({ toDefaultInterest: 3_000, toFees: 8_200, toSchedule: 11_800, unallocated: 0 })
    expect(paid).toEqual([11_800, 0, 0])
  })

  it("over 20,000 random states: both orders allocate the same total; the principal matches whenever at most one due instalment is unpaid, and is never higher under s126(3)", () => {
    const bad: unknown[] = []
    for (let seed = 1; seed < 20_000; seed++) {
      let x = seed
      const rnd = () => ((x = (x * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
      const n = 1 + Math.floor(rnd() * 4)
      const rs: AllocationRow[] = Array.from({ length: n }, (_, i) => {
        const principalDue = Math.floor(rnd() * 50_000)
        const interestDue = Math.floor(rnd() * 8_000)
        return { dueDay: i * 30, principalDue, interestDue, totalDue: principalDue + interestDue + Math.floor(rnd() * 3_000) }
      })
      // Any per-instalment state either order can reach: part-paid rows anywhere.
      const start = rs.map((r) => (rnd() < 0.5 ? 0 : Math.floor(rnd() * (r.totalDue + 1))))
      const args = {
        amount: Math.floor(rnd() * 150_000), day: Math.floor(rnd() * 120),
        defaultInterestOwed: Math.floor(rnd() * 5_000), chargesOwed: Math.floor(rnd() * 15_000), rows: rs,
      }
      const [legacyPaid, s126Paid] = [[...start], [...start]]
      const legacy = allocateReceipt({ ...args, paid: legacyPaid, s126: false })
      const s126 = allocateReceipt({ ...args, paid: s126Paid, s126: true })
      const total = (a: typeof legacy) => a.toDefaultInterest + a.toFees + a.toSchedule
      const [pl, ps] = [principalOf(rs, legacyPaid), principalOf(rs, s126Paid)]
      const sum = (v: number[]) => v.reduce((s, p) => s + p, 0)
      const dueUnpaid = rs.filter((r, i) => r.dueDay <= args.day && start[i] < r.totalDue).length
      if (
        total(legacy) !== total(s126) || legacy.unallocated !== s126.unallocated
        || total(s126) + s126.unallocated !== args.amount
        || (dueUnpaid <= 1 && JSON.stringify(pl) !== JSON.stringify(ps))
        || sum(ps) > sum(pl)
      ) bad.push({ seed, legacy, s126, pl, ps })
    }
    expect(bad.slice(0, 3)).toEqual([])
  })
})
