import { beforeEach, describe, expect, it, vi } from "vitest"

const { syncLoanCharges } = vi.hoisted(() => ({ syncLoanCharges: vi.fn() }))
vi.mock("@/lib/loan/charges-sync", () => ({ syncLoanCharges }))
vi.mock("@/lib/loan/lock", () => ({ lockLoanForUpdate: vi.fn() }))

import { sweepTenantCharges } from "./charges-sweep"

function makeDb(statusUnderLock: string) {
  const tx = {
    loan: { findUnique: vi.fn().mockResolvedValue({ status: statusUnderLock }) },
    $executeRawUnsafe: vi.fn(),
  }
  return {
    loan: { findMany: vi.fn().mockResolvedValue([{ id: "loan-1" }]) },
    $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  syncLoanCharges.mockResolvedValue({ changed: true })
})

describe("sweepTenantCharges", () => {
  it("syncs a loan still in the collectible book under the lock", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await sweepTenantCharges(makeDb("DEFAULTED") as any, "t1", new Date(), { source: "cron" })
    expect(syncLoanCharges).toHaveBeenCalledOnce()
    expect(result).toMatchObject({ loans: 1, changed: 1, failures: [] })
  })

  it("skips a loan that left the collectible book between the listing and the lock", async () => {
    for (const status of ["COMPLETED", "WRITTEN_OFF", "CANCELLED"]) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await sweepTenantCharges(makeDb(status) as any, "t1", new Date(), { source: "cron" })
      expect(result).toMatchObject({ changed: 0, failures: [] })
    }
    expect(syncLoanCharges).not.toHaveBeenCalled()
  })
})
