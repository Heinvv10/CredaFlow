import { beforeEach, describe, expect, it, vi } from "vitest"
import { Prisma } from "@prisma/client"
import type { RegimeTx } from "./classification"
import { bureauSubjectFingerprint } from "@/lib/compliance/bureau-subject"
import { decideDeal, parseDecideInput } from "./deal-decision"
import { exceptionsFingerprint } from "./deal-exception-severity"

// The screening re-check's own rules are proven in lib/screening; here, only
// that decideDeal obeys it on APPROVE.
const { screeningAllows } = vi.hoisted(() => ({ screeningAllows: vi.fn() }))
vi.mock("@/lib/screening/gate", () => ({ lockedBorrowerScreeningAllows: (...a: unknown[]) => screeningAllows(...a) }))

const REASONS = ["Strong DSCR on audited AFS"]
const actor = { tenantId: "tenant-1", userId: "admin-a", userEmail: "a@lender.test" }

interface Related {
  people?: Array<{ clientId: string; role: string; trusteeKind?: string | null; name: string }>
  loans?: Array<Record<string, unknown>>
  checks?: Array<Record<string, unknown>>
  attempts?: Array<{ data: Record<string, unknown>; createdAt: Date }>
}

function fakeTx(deal: Record<string, unknown> | null, pendingOverride = false, related: Related = {}) {
  const people = related.people ?? []
  const tx = {
    entityRelationship: {
      findMany: vi.fn(async () => people.map((p) => {
        const [firstName, lastName] = p.name.split(" ")
        return { clientId: p.clientId, role: p.role, trusteeKind: p.trusteeKind ?? null, client: { firstName, lastName } }
      })),
    },
    // Honours the status filter the cross-check queries with.
    loan: { findMany: vi.fn(async (args: { where: { status: { in: string[] } } }) =>
      (related.loans ?? []).filter((l) => args.where.status.in.includes(l.status as string))) },
    creditBureauCheck: { findMany: vi.fn(async () => related.checks ?? []) },
    complianceRecord: { findMany: vi.fn(async () => related.attempts ?? []) },
    client: {
      findMany: vi.fn(async () => people.map((p) => ({ id: p.clientId, firstName: p.name.split(" ")[0], lastName: p.name.split(" ")[1] }))),
    },
    $queryRaw: vi.fn(async () => [{ id: "app-1" }]),
    assetFinanceDeal: {
      findFirst: vi.fn(async () => deal),
      update: vi.fn(async () => ({})),
    },
    ncaRegimeOverride: { findFirst: vi.fn(async () => (pendingOverride ? { id: "ovr-1" } : null)) },
    loanApplication: { update: vi.fn(async () => ({})) },
    auditLog: { create: vi.fn(async () => ({})) },
    creditDecisionRecord: { create: vi.fn(async () => ({})) },
  }
  return { tx, asTx: tx as unknown as RegimeTx }
}

const deal = (over: { status?: string; appStatus?: string; ncaRegime?: string; memo?: boolean; assessment?: boolean | null; creditLife?: "ACCEPTED" | "DECLINED" | null; productType?: string } = {}) => ({
  id: "deal-1",
  applicationId: "app-1",
  status: over.status ?? "SUBMITTED",
  financials: over.memo === false ? null : { dscr: new Prisma.Decimal("1.8"), gearing: new Prisma.Decimal("0.25") },
  affordabilityAssessment: over.assessment === null ? null : { affordable: over.assessment ?? true },
  application: {
    clientId: null,
    entityId: "entity-1",
    status: over.appStatus ?? "SUBMITTED",
    ncaRegime: over.ncaRegime ?? "NON_NCA",
    ncaClassificationRule: "JURISTIC_OVER_THRESHOLD",
    appliedAmount: 155_250_000,
    appliedTermDays: 1826,
    creditLifeElection: over.creditLife === undefined ? "DECLINED" : over.creditLife,
    product: { productType: over.productType ?? "ASSET_FINANCE" },
  },
})

describe("parseDecideInput: reasons are mandatory for every decision", () => {
  it.each([
    [{ decision: "APPROVE" }, /reasons/],
    [{ decision: "DECLINE", reasons: [] }, /reasons/],
    [{ decision: "REFER", reasons: ["abcd"] }, /5 to/],
    [{ decision: "APPROVE", reasons: ["   long enough   ", "  no "] }, /5 to/],
    [{ decision: "APPROVE", reasons: [42] }, /5 to/],
    [{ decision: "MAYBE", reasons: REASONS }, /decision/],
    [null, /JSON object/],
  ])("refuses %j", (body, message) => {
    expect(parseDecideInput(body)).toMatch(message)
  })

  it("trims each reason", () => {
    expect(parseDecideInput({ decision: "DECLINE", reasons: ["  Gearing too high  "] })).toEqual({
      decision: "DECLINE",
      reasons: ["Gearing too high"],
      exceptionReason: null,
      exceptionsFingerprint: null,
    })
  })

  it("takes an optional exception reason of at least 20 characters", () => {
    expect(parseDecideInput({ decision: "APPROVE", reasons: REASONS, exceptionReason: "  Arrears under a signed payment plan  " }))
      .toMatchObject({ exceptionReason: "Arrears under a signed payment plan" })
    expect(parseDecideInput({ decision: "APPROVE", reasons: REASONS, exceptionReason: "too short" })).toMatch(/exception reason must be 20/)
    expect(parseDecideInput({ decision: "APPROVE", reasons: REASONS, exceptionReason: 7 })).toMatch(/exceptionReason must be text/)
    expect(parseDecideInput({ decision: "APPROVE", reasons: REASONS, exceptionsFingerprint: "abc" })).toMatch(/exceptionsFingerprint must be/)
    expect(parseDecideInput({ decision: "APPROVE", reasons: REASONS, exceptionsFingerprint: "f".repeat(64) })).toMatchObject({ exceptionsFingerprint: "f".repeat(64) })
  })
})

describe("decideDeal", () => {
  let fake: ReturnType<typeof fakeTx>
  beforeEach(() => {
    vi.clearAllMocks()
    screeningAllows.mockResolvedValue(true)
  })

  it("APPROVE is refused when the borrower's screening blocks, re-read in the transaction before any write", async () => {
    screeningAllows.mockResolvedValueOnce(false)
    fake = fakeTx(deal())
    expect(await decideDeal(fake.asTx, actor, "deal-1", { decision: "APPROVE", reasons: REASONS })).toEqual({ kind: "screening_blocked" })
    expect(screeningAllows).toHaveBeenCalledWith(fake.asTx, "tenant-1", { clientId: null, entityId: "entity-1" }, "admin-a")
    expect(fake.tx.loanApplication.update).not.toHaveBeenCalled()
  })

  it("APPROVE without a credit memo is refused and writes nothing", async () => {
    fake = fakeTx(deal({ memo: false }))
    expect(await decideDeal(fake.asTx, actor, "deal-1", { decision: "APPROVE", reasons: REASONS })).toEqual({ kind: "memo_required" })
    expect(fake.tx.loanApplication.update).not.toHaveBeenCalled()
    expect(fake.tx.assetFinanceDeal.update).not.toHaveBeenCalled()
  })

  it("APPROVE on an NCA application with a pending override waits for the second approver, writing nothing", async () => {
    fake = fakeTx(deal({ ncaRegime: "NCA" }), true)
    expect(await decideDeal(fake.asTx, actor, "deal-1", { decision: "APPROVE", reasons: REASONS })).toEqual({ kind: "awaiting_override" })
    expect(fake.tx.loanApplication.update).not.toHaveBeenCalled()
    expect(fake.tx.auditLog.create).not.toHaveBeenCalled()
  })

  it("APPROVE on an NCA application requires an affordable recorded s81 assessment", async () => {
    fake = fakeTx(deal({ ncaRegime: "NCA", assessment: null }))
    expect(await decideDeal(fake.asTx, actor, "deal-1", { decision: "APPROVE", reasons: REASONS })).toEqual({ kind: "assessment_required" })
    fake = fakeTx(deal({ ncaRegime: "NCA", assessment: false }))
    expect(await decideDeal(fake.asTx, actor, "deal-1", { decision: "APPROVE", reasons: REASONS })).toEqual({ kind: "unaffordable" })
    fake = fakeTx(deal({ ncaRegime: "NCA", assessment: true }))
    expect(await decideDeal(fake.asTx, actor, "deal-1", { decision: "APPROVE", reasons: REASONS })).toMatchObject({ kind: "decided", status: "APPROVED" })
  })

  it("does not approve an NCA deal before the borrower answers the credit-life offer", async () => {
    fake = fakeTx(deal({ ncaRegime: "NCA", creditLife: null }))
    expect(await decideDeal(fake.asTx, actor, "deal-1", { decision: "APPROVE", reasons: REASONS })).toEqual({ kind: "credit_life_required" })
  })

  it("APPROVE moves the application SUBMITTED → UNDER_REVIEW → APPROVED (EFT, approver) and audits the reasons", async () => {
    fake = fakeTx(deal())
    expect(await decideDeal(fake.asTx, actor, "deal-1", { decision: "APPROVE", reasons: REASONS })).toEqual({ kind: "decided", status: "APPROVED" })
    const updates = fake.tx.loanApplication.update.mock.calls.map((call) => (call as unknown as [{ data: { status: string } }])[0].data)
    expect(updates[0]).toEqual({ status: "UNDER_REVIEW" })
    expect(updates[1]).toMatchObject({
      status: "APPROVED", repaymentMethod: "EFT", approvedById: "admin-a", approvedAmount: 155_250_000, approvedTermDays: 1826,
    })
    expect(fake.tx.assetFinanceDeal.update).toHaveBeenCalledWith({
      where: { id: "deal-1", tenantId: "tenant-1" },
      data: expect.objectContaining({ status: "APPROVED", decision: "APPROVE", decisionReasons: REASONS, decidedById: "admin-a" }),
    })
    expect(fake.tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "ASSET_DEAL_DECIDED", newValue: expect.objectContaining({ reasons: REASONS, dscr: "1.8000" }) }),
    })
    // The decision log (lib/learning-loop): the decision, then the offer of the approved terms.
    expect(fake.tx.creditDecisionRecord.create.mock.calls.map((call) => (call as unknown as [{ data: unknown }])[0].data)).toEqual([
      expect.objectContaining({
        kind: "CREDIT_DECISION", decision: "APPROVE", recommendation: "PASS", overridden: false, actorUserId: "admin-a",
        sourceEntityType: "AssetFinanceDeal", sourceEntityId: "deal-1", applicationId: "app-1",
      }),
      expect.objectContaining({ kind: "OFFER", decision: "APPROVED_TERMS" }),
    ])
  })

  // Fair Score audit E5: a director in default with this lender is an exception the approver must answer.
  const director = { clientId: "c-dir", role: "DIRECTOR", name: "Synthetic Director" }
  const defaulted = {
    id: "loan-9", reference: "LN-TEST-0009", status: "DEFAULTED", daysInArrears: 166, arrearsAmount: 9_812_345, clientId: "c-dir", entityId: null,
    client: { firstName: "Synthetic", lastName: "Director" }, entity: null,
  }
  const storedCheck = (clientId: string, name: string) => ({
    clientId,
    subjectFingerprint: bureauSubjectFingerprint({ id: clientId, idNumber: "0000000000000", firstName: name.split(" ")[0], lastName: name.split(" ")[1], gender: null, dateOfBirth: null }), provider: "experian", score: 700, riskGrade: "B", hasAdverse: false, deceased: false, underDebtReview: false,
    hasJudgement: false, ok: true, errorMessage: null, createdAt: new Date("2026-10-16T08:00:00Z"),
    client: { id: clientId, idNumber: "0000000000000", firstName: name.split(" ")[0], lastName: name.split(" ")[1], gender: null, dateOfBirth: null },
  })

  it("E5: APPROVE with a director's loan in default with this lender needs an exception reason, writing nothing without one", async () => {
    fake = fakeTx(deal(), false, { people: [director], loans: [defaulted] })
    const refused = await decideDeal(fake.asTx, actor, "deal-1", { decision: "APPROVE", reasons: REASONS })
    expect(refused).toMatchObject({ kind: "exceptions_unanswered" })
    const [line] = (refused as { exceptions: string[] }).exceptions
    expect(line).toContain("Synthetic Director (Director) has loan LN-TEST-0009 with this lender: Defaulted, 166 days in arrears")
    expect(line).toContain("98,123.45 overdue")
    expect(fake.tx.loanApplication.update).not.toHaveBeenCalled()
    expect(fake.tx.assetFinanceDeal.update).not.toHaveBeenCalled()
  })

  it("E5: with the reason, the approval stores and audits each exception and the reason", async () => {
    fake = fakeTx(deal(), false, { people: [director], loans: [defaulted], checks: [storedCheck("c-dir", "Synthetic Director")] })
    const exceptionReason = "The director's arrears are under a signed settlement"
    const recordedDefault = { key: "ARREARS:loan-9", kind: "ARREARS" as const, status: "DEFAULTED" as const, daysInArrears: 166, arrearsCents: 9_812_345 }
    const fingerprint = exceptionsFingerprint([recordedDefault])
    expect(await decideDeal(fake.asTx, actor, "deal-1", { decision: "APPROVE", reasons: REASONS, exceptionReason, exceptionsFingerprint: fingerprint }))
      .toEqual({ kind: "decided", status: "APPROVED" })
    const written = (fake.tx.assetFinanceDeal.update.mock.calls[0] as unknown as [{ data: { decisionReasons: string[]; approvalExceptions: unknown } }])[0].data
    expect(written.approvalExceptions).toEqual([recordedDefault])
    const stored = written.decisionReasons
    expect(stored[0]).toBe(REASONS[0])
    expect(stored[1]).toMatch(/^Exception: Synthetic Director \(Director\) has loan LN-TEST-0009/)
    expect(stored[2]).toBe(`Approved despite the exceptions: ${exceptionReason}`)
    expect(fake.tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ newValue: expect.objectContaining({ exceptions: [expect.stringContaining("LN-TEST-0009")], exceptionReason }) }),
    })
    // Logged as an override of the exceptions' referral; the exception's loan and person are not.
    const [logged] = fake.tx.creditDecisionRecord.create.mock.calls.map((call) => (call as unknown as [{ data: Record<string, unknown> }])[0].data)
    expect(logged).toMatchObject({
      recommendation: "REFER", overridden: true, overrideReason: exceptionReason,
      inputsSnapshot: expect.objectContaining({ exceptions: { ARREARS: 1 } }), evidenceRefs: expect.objectContaining({ exceptionsFingerprint: fingerprint }),
    })
    expect(JSON.stringify(logged)).not.toMatch(/loan-9|LN-TEST-0009|Synthetic|c-dir/)
  })

  it("E5: the reason binds to the fingerprint of the exceptions shown: a changed set is refused and nothing is written", async () => {
    fake = fakeTx(deal(), false, { people: [director], loans: [defaulted], checks: [storedCheck("c-dir", "Synthetic Director")] })
    // The same loan shown at an earlier, milder severity: the reason answered a different exception.
    const stale = exceptionsFingerprint([{ key: "ARREARS:loan-9", kind: "ARREARS", status: "ACTIVE", daysInArrears: 10, arrearsCents: 50_000 }])
    const exceptionReason = "The director's arrears are under a signed settlement"
    const changed = await decideDeal(fake.asTx, actor, "deal-1", { decision: "APPROVE", reasons: REASONS, exceptionReason, exceptionsFingerprint: stale })
    expect(changed).toMatchObject({ kind: "exceptions_changed", exceptions: [expect.stringContaining("166 days in arrears")] })
    expect(await decideDeal(fake.asTx, actor, "deal-1", { decision: "APPROVE", reasons: REASONS, exceptionReason }))
      .toMatchObject({ kind: "exceptions_changed" })
    expect(fake.tx.assetFinanceDeal.update).not.toHaveBeenCalled()
    expect(fake.tx.loanApplication.update).not.toHaveBeenCalled()
  })

  it("E5: a loan that is current, or closed, is no exception", async () => {
    for (const loan of [{ ...defaulted, status: "ACTIVE", daysInArrears: 0, arrearsAmount: 0 }, { ...defaulted, status: "COMPLETED" }]) {
      fake = fakeTx(deal(), false, { people: [director], loans: [loan], checks: [storedCheck("c-dir", "Synthetic Director")] })
      expect(await decideDeal(fake.asTx, actor, "deal-1", { decision: "APPROVE", reasons: REASONS })).toEqual({ kind: "decided", status: "APPROVED" })
    }
  })

  it("refuses an exception reason when there is no exception to answer", async () => {
    fake = fakeTx(deal(), false, {})
    expect(await decideDeal(fake.asTx, actor, "deal-1", { decision: "APPROVE", reasons: REASONS, exceptionReason: "Nothing to explain here, really" }))
      .toEqual({ kind: "exception_reason_without_exceptions" })
    expect(fake.tx.assetFinanceDeal.update).not.toHaveBeenCalled()
  })

  it("does not approve a deal whose product is not an asset-finance product", async () => {
    fake = fakeTx(deal({ productType: "PERSONAL" }))
    expect(await decideDeal(fake.asTx, actor, "deal-1", { decision: "APPROVE", reasons: REASONS })).toEqual({ kind: "product_not_asset_finance" })
    expect(fake.tx.assetFinanceDeal.update).not.toHaveBeenCalled()
  })

  it("E6: a trustee's bureau check skipped for missing consent is recorded on the approval and needs an exception reason", async () => {
    const trustee = { clientId: "c-tr2", role: "TRUSTEE", trusteeKind: "NATURAL", name: "Synthetic Trustee" }
    const attempts = [{ data: { clientId: "c-tr2", outcome: "skipped", skipped: true, reason: "CONSENT_MISSING", provider: "experian" }, createdAt: new Date("2026-10-16T08:00:00Z") }]
    fake = fakeTx(deal(), false, { people: [trustee], attempts })
    const refused = await decideDeal(fake.asTx, actor, "deal-1", { decision: "APPROVE", reasons: ["Natural trustees' bureau records were checked"] })
    expect(refused).toEqual({ kind: "exceptions_unanswered", exceptions: ["Synthetic Trustee (Trustee): the bureau check was skipped (no bureau consent on record)"] })
    expect(fake.tx.assetFinanceDeal.update).not.toHaveBeenCalled()

    fake = fakeTx(deal(), false, { people: [trustee], attempts })
    await decideDeal(fake.asTx, actor, "deal-1", {
      decision: "APPROVE", reasons: ["Trust cash flow supports the rental"], exceptionReason: "Trustee consent is being obtained; the deal is secured",
      exceptionsFingerprint: exceptionsFingerprint([{ key: "BUREAU:c-tr2", kind: "BUREAU", outcome: "skipped:CONSENT_MISSING" }]),
    })
    const stored = (fake.tx.assetFinanceDeal.update.mock.calls[0] as unknown as [{ data: { decisionReasons: string[] } }])[0].data.decisionReasons
    expect(stored).toContain("Exception: Synthetic Trustee (Trustee): the bureau check was skipped (no bureau consent on record)")
  })

  it("E6: the person's latest attempt decides: a failure after a stored check is an exception, a stored check after a skip is not", async () => {
    const skipped = { data: { clientId: "c-dir", outcome: "skipped", skipped: true, reason: "CONSENT_MISSING", provider: "experian" }, createdAt: new Date("2026-10-15T08:00:00Z") }
    const failed = { data: { clientId: "c-dir", outcome: "failed", error: "bureau timeout", provider: "experian" }, createdAt: new Date("2026-10-17T08:00:00Z") }
    fake = fakeTx(deal(), false, { people: [director], checks: [storedCheck("c-dir", "Synthetic Director")], attempts: [failed] })
    expect(await decideDeal(fake.asTx, actor, "deal-1", { decision: "APPROVE", reasons: REASONS }))
      .toEqual({ kind: "exceptions_unanswered", exceptions: ["Synthetic Director (Director): the bureau check failed (bureau timeout)"] })
    fake = fakeTx(deal(), false, { people: [director], checks: [storedCheck("c-dir", "Synthetic Director")], attempts: [skipped] })
    expect(await decideDeal(fake.asTx, actor, "deal-1", { decision: "APPROVE", reasons: REASONS })).toEqual({ kind: "decided", status: "APPROVED" })
    fake = fakeTx(deal(), false, { people: [{ clientId: "c-jt", role: "TRUSTEE", trusteeKind: "JURISTIC", name: "Synthetic Trustees" }] })
    expect(await decideDeal(fake.asTx, actor, "deal-1", { decision: "APPROVE", reasons: REASONS })).toEqual({ kind: "decided", status: "APPROVED" })
  })

  it("DECLINE needs no memo and no NON_NCA; REFER leaves the application UNDER_REVIEW", async () => {
    fake = fakeTx(deal({ ncaRegime: "NCA", memo: false }))
    expect(await decideDeal(fake.asTx, actor, "deal-1", { decision: "DECLINE", reasons: REASONS })).toEqual({ kind: "decided", status: "DECLINED" })
    expect(fake.tx.loanApplication.update).toHaveBeenCalledWith({
      where: { id: "app-1", tenantId: "tenant-1" }, data: { status: "DECLINED", decisionReason: REASONS[0] },
    })

    fake = fakeTx(deal({ ncaRegime: "NCA", memo: false }))
    expect(await decideDeal(fake.asTx, actor, "deal-1", { decision: "REFER", reasons: REASONS })).toEqual({ kind: "decided", status: "REFERRED" })
    expect(fake.tx.loanApplication.update).toHaveBeenCalledTimes(1)
    expect(fake.tx.loanApplication.update).toHaveBeenCalledWith({ where: { id: "app-1", tenantId: "tenant-1" }, data: { status: "UNDER_REVIEW" } })
  })

  it.each(["DRAFT", "APPROVED", "DECLINED", "REFUSED_NCA"])("a %s deal is not decidable", async (status) => {
    fake = fakeTx(deal({ status }))
    expect(await decideDeal(fake.asTx, actor, "deal-1", { decision: "DECLINE", reasons: REASONS })).toEqual({ kind: "not_decidable", status })
    expect(fake.tx.assetFinanceDeal.update).not.toHaveBeenCalled()
  })

  it("is not_found when the deal is not the tenant's", async () => {
    fake = fakeTx(null)
    expect(await decideDeal(fake.asTx, actor, "deal-x", { decision: "DECLINE", reasons: REASONS })).toEqual({ kind: "not_found" })
  })
})
