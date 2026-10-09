import { describe, expect, it } from "vitest"
import {
  assertDisbursementPreconditions,
  DISBURSEMENT_PRECONDITION_ORDER,
  DisbursementPreconditionError,
  type DisbursementPrecondition,
  type DisbursementPreconditionChecks,
} from "./preconditions"

function passingChecks(): DisbursementPreconditionChecks {
  return Object.fromEntries(
    DISBURSEMENT_PRECONDITION_ORDER.map((precondition) => [
      precondition,
      { ok: true, evidence: `${precondition}_intact` },
    ]),
  ) as DisbursementPreconditionChecks
}

describe("assertDisbursementPreconditions", () => {
  it("accepts only when every independently verified requirement passes", () => {
    expect(() => assertDisbursementPreconditions(passingChecks())).not.toThrow()
  })

  for (const missing of DISBURSEMENT_PRECONDITION_ORDER) {
    it(`reports the distinct ${missing} 422 reason when it is absent`, () => {
      const checks = passingChecks()
      checks[missing] = { ok: false, evidence: `${missing}_missing` }

      try {
        assertDisbursementPreconditions(checks)
        throw new Error("Expected the disbursement assertion to fail")
      } catch (error) {
        expect(error).toBeInstanceOf(DisbursementPreconditionError)
        const failure = error as DisbursementPreconditionError
        expect(failure.precondition).toBe(
          missing satisfies DisbursementPrecondition,
        )
        expect(failure.evidence).toBe(`${missing}_missing`)
      }
    })
  }
})
