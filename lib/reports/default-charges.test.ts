import { describe, expect, it } from "vitest"
import { defaultChargesByMonth, type DefaultChargesInput } from "./default-charges"

const d = (iso: string) => new Date(iso)
const products = new Map([["p1", "Micro"], ["p2", "Personal"]])

const receipt = (over: Partial<DefaultChargesInput["receipts"][number]>) => ({
  productId: "p1", receivedAt: d("2026-09-05T10:00:00Z"), paymentMethod: "EFT", reversed: false,
  allocationStatus: "ALLOCATED", defaultInterestAllocated: 0, chargeFeesAllocated: 0, ...over,
})

const input: DefaultChargesInput = {
  products,
  now: d("2026-09-26T10:00:00+02:00"),
  stoppedAt: null,
  charges: [
    // LoanCharge.day is a @db.Date: UTC midnight of the SAST calendar day.
    { productId: "p1", type: "DEFAULT_INTEREST", day: d("2026-08-31T00:00:00Z"), amount: 1_000 },
    { productId: "p1", type: "SERVICE_FEE", day: d("2026-09-01T00:00:00Z"), amount: 6_900 },
    { productId: "p1", type: "DEFAULT_ADMIN", day: d("2026-09-10T00:00:00Z"), amount: 8_200 },
    { productId: "p1", type: "DEFAULT_INTEREST", day: d("2026-09-30T00:00:00Z"), amount: 500 },
    { productId: "p2", type: "DEFAULT_INTEREST", day: d("2026-09-15T00:00:00Z"), amount: 300 },
  ],
  receipts: [
    // 23:30 SAST on 31 August: August.
    receipt({ receivedAt: d("2026-08-31T21:30:00Z"), defaultInterestAllocated: 1_000 }),
    // 00:30 SAST on 1 September: September.
    receipt({ receivedAt: d("2026-08-31T22:30:00Z"), chargeFeesAllocated: 6_900 }),
    // A waiver is not cash.
    receipt({ receivedAt: d("2026-09-20T10:00:00Z"), paymentMethod: "WAIVER", chargeFeesAllocated: 50 }),
    // Reversed and unapplied money collected nothing.
    receipt({ productId: "p2", reversed: true, defaultInterestAllocated: 300 }),
    receipt({ productId: "p2", allocationStatus: "UNAPPLIED", defaultInterestAllocated: 300 }),
  ],
  exemptions: [
    { productId: "p2", at: d("2026-09-16T08:00:00Z"), from: false, to: true },
    { productId: "p2", at: d("2026-09-17T08:00:00Z"), from: true, to: true }, // reason edit only
  ],
  refunds: [{ productId: "p2", at: d("2026-09-16T08:00:00Z"), cents: 250 }],
}

describe("defaultChargesByMonth", () => {
  const { rows, months } = defaultChargesByMonth(input)
  const row = (month: string, productId: string) => rows.find((r) => r.month === month && r.productId === productId)

  it("buckets accrual by SAST month and charge type", () => {
    expect(row("2026-08", "p1")).toMatchObject({ interest: 1_000, fees: 0, letters: 0, accrued: 1_000 })
    expect(row("2026-09", "p1")).toMatchObject({ interest: 500, fees: 6_900, letters: 8_200, accrued: 15_600 })
  })

  it("counts collected as cash only, by the SAST month the receipt is valued in", () => {
    expect(row("2026-08", "p1")?.collected).toBe(1_000)
    expect(row("2026-09", "p1")?.collected).toBe(6_900)
    expect(row("2026-09", "p2")?.collected).toBe(0)
  })

  it("shows waivers separately from collections", () => {
    expect(row("2026-09", "p1")?.waived).toBe(50)
  })

  it("carries outstanding forward as accrued less collected less waived", () => {
    expect(row("2026-08", "p1")?.outstanding).toBe(0)
    expect(row("2026-09", "p1")?.outstanding).toBe(1_000 + 15_600 - 1_000 - 6_900 - 50)
    expect(row("2026-09", "p2")?.outstanding).toBe(300)
  })

  it("counts exemptions set and lifted and the charges moved to refund-due", () => {
    expect(row("2026-09", "p2")).toMatchObject({ exemptionsSet: 1, exemptionsLifted: 0, refundDue: 250 })
  })

  it("starts a product's rows at its first activity and names it", () => {
    expect(row("2026-08", "p2")).toBeUndefined()
    expect(row("2026-09", "p2")?.productName).toBe("Personal")
    expect(rows.map((r) => r.month + r.productId)).toEqual(["2026-08p1", "2026-09p1", "2026-09p2"])
  })

  it("totals each month across products", () => {
    expect(months.find((m) => m.month === "2026-09")).toMatchObject({
      accrued: 15_900, collected: 6_900, waived: 50, outstanding: 8_650 + 300, refundDue: 250,
    })
  })

  it("shows nothing outstanding from the month charges were stopped", () => {
    const stopped = defaultChargesByMonth({ ...input, stoppedAt: d("2026-09-02T10:00:00Z") })
    expect(stopped.rows.find((r) => r.month === "2026-08")?.outstanding).toBe(0)
    expect(stopped.rows.filter((r) => r.month === "2026-09").map((r) => r.outstanding)).toEqual([0, 0])
    expect(stopped.rows.find((r) => r.month === "2026-09" && r.productId === "p1")?.accrued).toBe(15_600)
  })

  it("keeps an earlier month's outstanding when charges were stopped later", () => {
    const stopped = defaultChargesByMonth({ ...input, stoppedAt: d("2026-10-02T10:00:00Z"), now: d("2026-10-05T10:00:00Z") })
    expect(stopped.rows.find((r) => r.month === "2026-09" && r.productId === "p1")?.outstanding).toBe(8_650)
    expect(stopped.rows.filter((r) => r.month === "2026-10").map((r) => r.outstanding)).toEqual([0, 0])
  })
})
