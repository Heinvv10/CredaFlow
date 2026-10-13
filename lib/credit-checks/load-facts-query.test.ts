/** loadApplicationFacts with Prisma and the statement reader mocked: what it asks for and what it builds. */
import { beforeEach, describe, expect, it, vi } from "vitest"

const appFind = vi.fn()
const docFindMany = vi.fn()
const appFindMany = vi.fn()
const bureauFind = vi.fn()
const ensure = vi.fn()
const queueRead = vi.fn()

vi.mock("@/lib/prisma", () => ({
  prisma: {
    loanApplication: { findFirst: (a: unknown) => appFind(a), findMany: (a: unknown) => appFindMany(a) },
    clientDocument: { findMany: (a: unknown) => docFindMany(a) },
    creditBureauCheck: { findFirst: (a: unknown) => bureauFind(a) },
  },
}))
vi.mock("@/lib/statement-analysis/persist", () => ({
  ensureStatementAnalysis: (a: unknown) => ensure(a),
  readStatementInBackground: (...a: unknown[]) => queueRead(...a),
}))

import { loadApplicationFacts } from "./load-facts"

const slipFields = (net: number) => ({
  grossIncome: { value: net + 100_000, validated: true }, totalDeductions: { value: 100_000, validated: true },
  netIncome: { value: net, validated: true }, payDate: { value: "2026-09-25", validated: true },
  employeeIdNumber: { value: "9001015000080", validated: true },
})

type Where = { docType?: string; deletedAt?: unknown }
function documents(byQuery: { statements?: unknown[]; deletedStatements?: unknown[]; payslips?: unknown[]; deletedPayslips?: unknown[] }) {
  docFindMany.mockImplementation(async ({ where }: { where: Where }) => {
    const deleted = where.deletedAt !== null
    if (where.docType === "BANK_STATEMENT") return (deleted ? byQuery.deletedStatements : byQuery.statements) ?? []
    return (deleted ? byQuery.deletedPayslips : byQuery.payslips) ?? []
  })
}

beforeEach(() => {
  vi.resetAllMocks()
  appFind.mockResolvedValue({
    id: "app-1", status: "UNDER_REVIEW", clientId: "client-1", submittedAt: null, createdAt: new Date("2026-10-05T08:00:00Z"),
    client: { firstName: "Thabo", lastName: "Tester", idNumber: "9001015000080", monthlyIncome: 1_800_000, popiaConsentGiven: false, debtObligations: [] },
  })
  appFindMany.mockResolvedValue([])
  bureauFind.mockResolvedValue(null)
  documents({})
})

describe("loadApplicationFacts", () => {
  it("takes the lower of the payslip's net pay and the declared income", async () => {
    documents({ payslips: [{ id: "slip-1", extractionStatus: "done", extractionResult: slipFields(2_500_000), validationMismatch: false }] })
    expect((await loadApplicationFacts("t1", "app-1"))!.facts.monthlyIncomeCents).toBe(1_800_000)
    documents({ payslips: [{ id: "slip-1", extractionStatus: "done", extractionResult: slipFields(1_500_000), validationMismatch: false }] })
    expect((await loadApplicationFacts("t1", "app-1"))!.facts.monthlyIncomeCents).toBe(1_500_000)
  })

  it("ignores a payslip that names someone else for income, and lists every mismatched payslip", async () => {
    const stranger = { ...slipFields(900_000), employeeIdNumber: { value: "8501015000081", validated: true } }
    documents({ payslips: [
      { id: "slip-new", extractionStatus: "done", extractionResult: stranger, validationMismatch: false },
      { id: "slip-old", extractionStatus: "done", extractionResult: slipFields(9_000_000), validationMismatch: true },
    ] })
    const { facts } = (await loadApplicationFacts("t1", "app-1"))!
    expect(facts.monthlyIncomeCents).toBe(1_800_000)
    expect(facts.mismatchedPayslipIds).toEqual(["slip-new", "slip-old"])
  })

  it("lists payslips on file that were not extracted, and does not use them", async () => {
    documents({ payslips: [{ id: "slip-failed", extractionStatus: "failed", extractionResult: null, validationMismatch: false }] })
    const { facts } = (await loadApplicationFacts("t1", "app-1"))!
    expect(facts).toMatchObject({ unreadPayslipIds: ["slip-failed"], extractedPayslipIds: [], payslip: null })
  })

  it("does not read a statement the client uploaded without consent, and reads a staff upload", async () => {
    documents({ statements: [{ id: "portal-1", uploadedByType: "client" }, { id: "staff-1", uploadedByType: "staff" }] })
    ensure.mockResolvedValue({ state: "pending", reason: "vlm_deferred" })
    const { facts } = (await loadApplicationFacts("t1", "app-1"))!
    expect(facts.statements.map((s) => [s.documentId, s.pendingReason])).toEqual([["portal-1", "consent"], ["staff-1", "vlm"]])
    expect(ensure).toHaveBeenCalledTimes(1)
    expect(ensure).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "t1", documentId: "staff-1", allowVlm: false }))
  })

  it("queues a statement waiting for the vision reader, except under the lock", async () => {
    documents({ statements: [{ id: "staff-1", uploadedByType: "staff" }] })
    ensure.mockResolvedValue({ state: "pending", reason: "vlm_deferred" })
    await loadApplicationFacts("t1", "app-1")
    expect(queueRead).toHaveBeenCalledWith("t1", "staff-1")
    queueRead.mockClear()
    const reasons = new Map([["staff-1", "reader_unavailable" as const]])
    const { facts } = (await loadApplicationFacts("t1", "app-1", { persistedOnly: true, pendingReasons: reasons }))!
    expect(queueRead).not.toHaveBeenCalled()
    expect(ensure).toHaveBeenLastCalledWith(expect.objectContaining({ persistedOnly: true }))
    expect(facts.statements[0].pendingReason).toBe("reader_unavailable")
  })

  it("lists deleted read statements, deleted payslips and cancelled applications with open flags", async () => {
    documents({ deletedStatements: [{ id: "gone-1" }], deletedPayslips: [{ id: "slip-gone" }] })
    appFindMany.mockResolvedValue([{ id: "app-cancelled", reference: "APP-9", status: "CANCELLED" }])
    const { facts } = (await loadApplicationFacts("t1", "app-1"))!
    expect(facts).toMatchObject({ deletedStatementIds: ["gone-1"], deletedPayslipIds: ["slip-gone"], priorOpenFlagApplications: [{ id: "app-cancelled", reference: "APP-9", status: "CANCELLED" }] })
    // Any other application with open flags, whatever its status or age.
    const priorWhere = (appFindMany.mock.calls[0][0] as { where: Record<string, unknown> }).where
    // A PRIOR flag on that application does not count, or flags would breed flags.
    expect(priorWhere).toEqual({ tenantId: "t1", clientId: "client-1", id: { not: "app-1" }, checkFlags: { some: { status: "OPEN", code: { not: "PRIOR_OPEN_FLAGS" } } } })
    // A document deleted recently counts however long ago it was uploaded.
    const deletedWhere = docFindMany.mock.calls.map((c) => (c[0] as { where: Record<string, unknown> }).where).find((w) => w.deletedAt !== null)!
    expect(deletedWhere.OR).toEqual([{ createdAt: { gte: expect.any(Date) } }, { deletedAt: { gte: expect.any(Date) } }])
  })

  it("scopes every query to the tenant", async () => {
    await loadApplicationFacts("t1", "app-1")
    for (const m of [appFind, docFindMany, appFindMany, bureauFind]) {
      for (const [arg] of m.mock.calls) expect((arg as { where: { tenantId: string } }).where.tenantId).toBe("t1")
    }
  })
})
