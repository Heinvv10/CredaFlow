// A DebiCheck mandate is monthly with one recurring amount and one debit day. A loan on a repayment structure (lib/product-engine)
// has no such schedule, so staff cannot register one for it: it is collected by EFT until the mandate follows the schedule.
import { beforeEach, describe, expect, it, vi } from "vitest"

const loanFindFirst = vi.hoisted(() => vi.fn())
const loadEngineContext = vi.hoisted(() => vi.fn())
vi.mock("@/lib/prisma", () => ({ prisma: { loan: { findFirst: loanFindFirst } } }))
vi.mock("./context", async (importOriginal) => ({ ...(await importOriginal<typeof import("./context")>()), loadEngineContext }))

import { createDebitMandate, MandateError } from "./mandates"

const actor = { userId: "u1", userEmail: "u@example.test" } as never
const input = { loanId: "loan-1", authType: "TT1" as const, debitDay: 25, trackingDays: 3 }
const loan = (terms: Array<{ structure: string }>) => ({
  id: "loan-1", reference: "LN-1", status: "ACTIVE", clientId: "c1", terms,
  client: { firstName: "A", lastName: "B", idNumber: "1", phone: "1", bankName: "FNB", bankAccountNumber: "123", bankBranchCode: "250655", accountType: "SAVINGS" },
  repaymentSchedule: [],
})

beforeEach(() => {
  vi.clearAllMocks()
  loadEngineContext.mockResolvedValue({ provider: { id: "STUB" } })
})

describe("createDebitMandate", () => {
  it("refuses a loan on a repayment structure: collect by EFT", async () => {
    loanFindFirst.mockResolvedValue(loan([{ structure: "AMORTISING" }]))
    await expect(createDebitMandate("t1", actor, input)).rejects.toMatchObject({ code: "NOT_ELIGIBLE", message: expect.stringContaining("repayment structure") })
  })

  it("asks only for the terms that carry a structure: a loan whose terms have none (a version with no structure) is as it was", async () => {
    loanFindFirst.mockResolvedValue(loan([]))
    // it goes on to the schedule check, where this fixture has nothing outstanding: a different refusal, not the structure one
    const error = await createDebitMandate("t1", actor, input).catch((e) => e as MandateError)
    expect(error).toMatchObject({ code: "NOT_ELIGIBLE", message: "Nothing is outstanding on the schedule" })
    expect(loanFindFirst).toHaveBeenCalledWith(expect.objectContaining({ select: expect.objectContaining({ terms: { select: { structure: true }, where: { structure: { not: null } }, take: 1 } }) }))
  })
})
