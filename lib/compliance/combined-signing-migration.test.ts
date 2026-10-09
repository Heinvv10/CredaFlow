import { describe, expect, it } from "vitest"
import { baselineFunctionSql } from "../db-baseline.test-helpers"

const migration = baselineFunctionSql("guardLoanApplicationPasqApproval")

describe("combined PASQ and agreement signing migration", () => {
  it("allows only an atomic acknowledgement plus signature after packet preparation", () => {
    expect(migration).toContain(`OLD."agreementGeneratedAt" IS NOT NULL`)
    expect(migration).toContain(`OLD."agreementSignedAt" IS NULL`)
    expect(migration).toContain(`NEW."agreementSignedAt" IS NOT NULL`)
    expect(migration).toContain(
      `NEW."pasqAcknowledgedBy" = NEW."clientId"`,
    )
    expect(migration).toContain(
      `NEW."pasqAcknowledgedSha256" = NEW."pasqDocumentSha256"`,
    )
    expect(migration).toContain(
      `NEW."pasqEvidence" IS NOT DISTINCT FROM OLD."pasqEvidence"`,
    )
  })
})
