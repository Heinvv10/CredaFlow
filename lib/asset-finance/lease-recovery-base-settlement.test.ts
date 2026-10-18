import { beforeEach, expect, it, vi } from "vitest"
import { leaseRecoveryBaseSettlement } from "./lease-recovery-base-settlement"
import { loadChargesReplay } from "@/lib/loan/charges-replay"
vi.mock("@/lib/loan/charges-replay", () => ({ loadChargesReplay: vi.fn(), chargesOutstandingTotal: (result: { feesOutstanding: number; interestOutstanding: number }) => result.feesOutstanding + result.interestOutstanding }))
const at = new Date("2026-10-18T12:00:00+02:00")
const loan = (amount: number) => ({ id: "lease", tenantId: "tenant", contractType: "OPERATING_LEASE", ncaRegime: "NON_NCA", interestModel: "FLAT", principal: amount, totalInterest: 0, totalRepayable: amount, totalPaid: 0, outstandingPrincipal: amount, arrearsAmount: 0, interestRatePm: 0, status: "ACTIVE", startDate: at, maturityDate: new Date("2027-10-18"), repaymentSchedule: [{ id: "r1", installmentNo: 1, dueDate: at, principalDue: amount, interestDue: 0, feesDue: 0, totalDue: amount, totalPaid: 0, status: "PENDING" }] })
beforeEach(() => vi.clearAllMocks())
it("keeps PV-zero cost-only debt out of the separately stated base, without an invented schedule cent", async () => {
  vi.mocked(loadChargesReplay).mockResolvedValue(null)
  const tx = { payment: { findMany: vi.fn().mockResolvedValue([]) } }
  expect(await leaseRecoveryBaseSettlement(tx as never, loan(0) as never, at, "recovery")).toBe(0)
  expect(loadChargesReplay).toHaveBeenCalledWith(tx, { tenantId: "tenant", loanId: "lease" }, at, { decidingStatus: true, excludeRecoveryCosts: "recovery" })
})
it("replays real cash excluding only the newly stated costs so prior fee allocation cannot count them twice", async () => {
  vi.mocked(loadChargesReplay).mockResolvedValue({ loan: { repaymentSchedule: [{ id: "r1" }] }, result: { scheduleRows: [{ paid: 10_000 }], feesOutstanding: 0, interestOutstanding: 0 } } as never)
  expect(await leaseRecoveryBaseSettlement({} as never, loan(30_000) as never, at, "recovery")).toBe(20_000)
})

it("maps replay allocations by schedule ID when the damages row sorts before cancelled future rentals", async () => {
  const current = loan(30_000)
  current.repaymentSchedule.push({ ...current.repaymentSchedule[0], id: "r2", installmentNo: 2, principalDue: 0, totalDue: 0 })
  vi.mocked(loadChargesReplay).mockResolvedValue({ loan: { repaymentSchedule: [{ id: "r2" }, { id: "r1" }] }, result: { scheduleRows: [{ paid: 0 }, { paid: 10_000 }], feesOutstanding: 0, interestOutstanding: 0 } } as never)
  expect(await leaseRecoveryBaseSettlement({} as never, current as never, at, "recovery")).toBe(20_000)
})
