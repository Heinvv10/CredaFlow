import { Prisma } from "@prisma/client"
import { describe, expect, it, vi } from "vitest"
import { capRepoRate, checkNcaInterestRateFor } from "./nca-interest-cap.server"

const dec = (rate: string) => new Prisma.Decimal(rate)
function db(approved: string | null, fed: string[] = []) {
  return {
    referenceRate: {
      findFirst: vi.fn(async () => (approved ? { effectiveDate: new Date("2026-05-29T00:00:00Z"), rate: dec(approved) } : null)),
      findMany: vi.fn(async () => fed.map((rate) => ({ rate: dec(rate) }))),
    },
  } as never
}
const unsecured = { creditType: "UNSECURED" as const, interestRatePm: 0.0233, interestModel: "REDUCING_BALANCE" }
const on = new Date("2026-11-25T10:00:00+02:00")

describe("the repo rate the NCA cap uses", () => {
  it("is the approved value when the feed has nothing newer", async () => {
    expect(await capRepoRate(db("0.0725"), "t1", "2026-11-25")).toEqual({ rate: 0.0725, approved: 0.0725 })
  })

  it("is a newer fed value still awaiting approval when it is lower: an unapproved cut lowers the cap at once", async () => {
    expect(await capRepoRate(db("0.0725", ["0.07"]), "t1", "2026-11-25")).toEqual({ rate: 0.07, approved: 0.0725 })
    // 2.33% a month (27.96%) passes at 7.25% (cap 28.25%) and fails at 7% (28%).
    expect(await checkNcaInterestRateFor(db("0.0725"), "t1", unsecured, on)).toEqual({ ok: true })
    expect(await checkNcaInterestRateFor(db("0.0725", ["0.07"]), "t1", unsecured, on)).toEqual({ ok: true })
    expect(await checkNcaInterestRateFor(db("0.0725", ["0.0675"]), "t1", unsecured, on)).toMatchObject({ ok: false, reason: "ABOVE_CAP" })
  })

  it("ignores a newer fed value that is higher until a person approves it", async () => {
    expect(await capRepoRate(db("0.07", ["0.0775"]), "t1", "2026-11-25")).toEqual({ rate: 0.07, approved: 0.07 })
  })

  it("asks only for SARB-fed PENDING repo values dated after the approved one", async () => {
    const d = db("0.07")
    await capRepoRate(d, "t1", "2026-11-25")
    expect((d as unknown as { referenceRate: { findMany: ReturnType<typeof vi.fn> } }).referenceRate.findMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ tenantId: "t1", basis: "REPO", source: "SARB_FEED", status: "PENDING", effectiveDate: expect.objectContaining({ gt: new Date("2026-05-29T00:00:00Z") }) }),
      select: { rate: true },
    })
  })

  it("refuses to price from an approved repo rate outside 1%–20%", async () => {
    expect(await checkNcaInterestRateFor(db("0.35"), "t1", unsecured, on)).toMatchObject({ ok: false, reason: "REPO_IMPLAUSIBLE" })
    expect(await checkNcaInterestRateFor(db("0.005"), "t1", unsecured, on)).toMatchObject({ ok: false, reason: "REPO_IMPLAUSIBLE" })
  })

  it("points at the page every lender can open", async () => {
    const result = await checkNcaInterestRateFor(db(null), "t1", unsecured, on)
    expect(result).toMatchObject({ ok: false, reason: "NO_REPO_RATE" })
    expect(!result.ok && result.message).toContain("Settings → Repo rate")
  })
})
