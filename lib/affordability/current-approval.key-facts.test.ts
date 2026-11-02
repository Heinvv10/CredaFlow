import { describe, expect, it } from "vitest"
import { verifyCurrentAffordabilityApproval } from "@/lib/affordability/current-approval"
import { frozenIdentityInput } from "@/lib/non-nca-documents/identity"
import { biometricSubjectFingerprint } from "@/lib/kyc/biometric-evidence"
import { capturedAt, client, debt, tenantConfig } from "@/lib/affordability/__fixtures__/approval-evidence"
import { keyFactsApplication } from "@/lib/affordability/__fixtures__/key-facts-approval"

const verify = (application: ReturnType<typeof keyFactsApplication>, config = tenantConfig) =>
  verifyCurrentAffordabilityApproval({ application: application as never, bureauCheck: null, tenantConfig: config })

/** Parsed and re-serialised, as a stored snapshot is: the tampering a database write could do. */
function withFrozenPrincipal(application: ReturnType<typeof keyFactsApplication>, principalCents: number) {
  const store = JSON.parse(JSON.stringify(application.affordabilityResult)) as { approval: { inputs: { principalCents: number } } }
  store.approval.inputs.principalCents = principalCents
  return { ...application, affordabilityResult: store }
}

describe("a KEY_FACTS approval at payout: no bureau and no PASQ, everything else as an NCA approval", () => {
  it("holds with neither a bureau check nor a PASQ", () => {
    const result = verify(keyFactsApplication())
    expect(result).toMatchObject({ ok: true })
    expect(result.ok && result.calculation.principal).toBe(500_000)
  })

  it("refuses the frozen terms altered after approval (the snapshot no longer hashes to itself)", () => {
    expect(verify(withFrozenPrincipal(keyFactsApplication(), 800_000))).toEqual({ ok: false, reason: "changed" })
  })

  it("refuses approved terms on the application that differ from the frozen approval", () => {
    expect(verify({ ...keyFactsApplication(), approvedAmount: 800_000 })).toEqual({ ok: false, reason: "changed" })
    expect(verify({ ...keyFactsApplication(), approvedTermDays: 180 })).toEqual({ ok: false, reason: "changed" })
    expect(verify({ ...keyFactsApplication(), initiationFeePayment: "UPFRONT" as "DEFERRED" })).toEqual({ ok: false, reason: "changed" })
    expect(verify({ ...keyFactsApplication(), productId: "another-product" })).toEqual({ ok: false, reason: "changed" })
  })

  it("the approval fingerprint binds the borrower's finances and the lender's policy at payout", () => {
    const application = keyFactsApplication()
    expect(verify({ ...application, client: { ...application.client, monthlyIncome: 900_000 } })).toEqual({ ok: false, reason: "changed" })
    expect(verify({ ...application, client: { ...application.client, debtObligations: [{ ...debt, monthlyInstalment: 90_000 }] } })).toEqual({ ok: false, reason: "changed" })
    expect(verify(application, { ...tenantConfig, ndiBufferPct: 120 })).toEqual({ ok: false, reason: "changed" })
  })

  it("the approval fingerprint binds who the borrower is: a changed name, ID number or date of birth is refused", () => {
    const application = keyFactsApplication()
    for (const change of [{ lastName: "Other" }, { firstName: "Other" }, { email: "someone-else@test.invalid" }, { whatsapp: "+26658999999" as never }, { idNumber: "990000002" }, { dateOfBirth: new Date("1991-01-01T00:00:00.000Z") }]) {
      expect(verify({ ...application, client: { ...application.client, ...change } })).toEqual({ ok: false, reason: "changed" })
    }
  })

  it("a schedule that starts when it is checked instead of when it was approved is not the approved one", () => {
    const result = verify(keyFactsApplication())
    const frozen = (keyFactsApplication().affordabilityResult as { approval: { calculator: { schedule: { dueDate: string }[] } } }).approval.calculator.schedule
    expect(result.ok && result.calculation.schedule.map((s) => s.dueDate.toISOString())).toEqual(frozen.map((s) => s.dueDate))
  })

  it("an NCA approval carries no identity input, so its fingerprints do not move", () => {
    expect(frozenIdentityInput({ disclosureRegime: "NCA_PASQ", client })).toEqual({})
    expect(frozenIdentityInput({ client })).toEqual({})
    expect(frozenIdentityInput({ disclosureRegime: "KEY_FACTS", client })).toEqual({ borrowerIdentity: expect.stringMatching(/^[0-9a-f]{64}$/) })
  })

  it("is not skipped for the submission snapshot or an incomplete bureau override", () => {
    expect(verify({ ...keyFactsApplication(), submittedAt: null as never })).toEqual({ ok: false, reason: "submission_missing" })
    expect(verify({ ...keyFactsApplication(), bureauOverrideAt: capturedAt })).toEqual({ ok: false, reason: "override_incomplete" })
  })

  it("an NCA application is still asked for both", () => {
    const { disclosureRegime: _regime, ...withoutRegime } = keyFactsApplication()
    expect(verify(withoutRegime as never)).toEqual({ ok: false, reason: "bureau_missing" })
    expect(verifyCurrentAffordabilityApproval({
      application: { ...withoutRegime, bureauOverrideAt: capturedAt, bureauOverrideReason: "A reasoned override", bureauOverrideById: "officer-1" } as never,
      bureauCheck: null, tenantConfig,
    })).toEqual({ ok: false, reason: "pasq_changed" })
  })
})
