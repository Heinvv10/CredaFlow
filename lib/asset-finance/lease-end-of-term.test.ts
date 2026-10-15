import { describe, expect, it, vi } from "vitest"

vi.mock("./lease-portal-route", () => ({ clientLeaseRefusal: vi.fn(async () => null) }))
vi.mock("@/lib/audit", async (original) => ({ ...(await original<typeof import("@/lib/audit")>()), logAuditStrict: vi.fn(async () => undefined) }))

import { dbDate } from "./dates"
import { endExtension } from "./lease-end-of-term"

/** An extension elected 2027-01-05, its last rental due 2027-01-31 (the 31st: later rentals clamp to the 28th). */
function tx(timing: "ARREARS" | "ADVANCE") {
  const update = vi.fn(async () => ({}))
  return {
    update,
    tx: {
      leaseEndOfTerm: {
        findFirst: vi.fn(async () => ({ id: "e1", status: "EXTENDING", extensionNoticeOn: null, electedAt: new Date("2027-01-05T08:00:00Z") })),
        update,
      },
      leaseRental: { findFirst: vi.fn(async () => ({ dueDate: dbDate("2027-01-31") })) },
      assetFinanceDeal: { findFirst: vi.fn(async () => ({ rentalTiming: timing })) },
    },
  }
}
const endsOn = async (timing: "ARREARS" | "ADVANCE", noticeOn: string) => {
  const t = tx(timing)
  const result = await endExtension(t.tx as never, { tenantId: "t1", userId: "u1" }, { loanId: "l1", noticeOn, today: "2027-03-15" })
  expect(result).toMatchObject({ kind: "ok" })
  const data = (t.update.mock.calls[0] as unknown as [{ data: { extensionEndsOn: Date } }])[0].data
  return data.extensionEndsOn.toISOString().slice(0, 10)
}

describe("endExtension: the end steps a month at a time from the last rental, as the daily run appends them (C7)", () => {
  it("in arrears: notice 2027-02-10 → a month later is 2027-03-10 → 31 Jan, 28 Feb, 28 Mar: ends 2027-03-28 (not 31 Mar)", async () => {
    expect(await endsOn("ARREARS", "2027-02-10")).toBe("2027-03-28")
  })
  it("in advance the billed period runs to 2027-02-28 (a month after the last rental): an early notice still ends it no sooner", async () => {
    expect(await endsOn("ADVANCE", "2027-01-10")).toBe("2027-02-28")
  })
  it("refuses a notice dated before the election or after today", async () => {
    const t = tx("ARREARS")
    expect(await endExtension(t.tx as never, { tenantId: "t1", userId: "u1" }, { loanId: "l1", noticeOn: "2027-01-04", today: "2027-03-15" }))
      .toMatchObject({ kind: "refused", reason: "invalid_notice_date" })
    expect(await endExtension(t.tx as never, { tenantId: "t1", userId: "u1" }, { loanId: "l1", noticeOn: "2027-03-16", today: "2027-03-15" }))
      .toMatchObject({ kind: "refused", reason: "invalid_notice_date" })
  })
})
