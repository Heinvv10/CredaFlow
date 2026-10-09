import { describe, expect, it } from "vitest"
import {
  baselineFunctionSql,
  baselineTriggerSql,
} from "../db-baseline.test-helpers"

const migration = [
  baselineFunctionSql("guardBoundAgreementDocument"),
  baselineTriggerSql("ClientDocument_guard_bound_agreement_delete"),
  baselineTriggerSql("ClientDocument_guard_bound_agreement_update"),
].join("\n")

// Mocked Prisma cannot execute a trigger, so a unit test can never prove this
// guard fires. What it CAN prove is that the migration declares the shape the
// design depends on — and catch a later edit that quietly widens or narrows it.
// The behavioural proof is a real-DB exercise; see the note at the end.
describe("guardBoundAgreementDocument migration", () => {
  it("guards BOTH delete and update on ClientDocument", () => {
    expect(migration).toMatch(
      /CREATE TRIGGER "ClientDocument_guard_bound_agreement_delete"\s+BEFORE DELETE ON "ClientDocument"/,
    )
    expect(migration).toMatch(
      /CREATE TRIGGER "ClientDocument_guard_bound_agreement_update"\s+BEFORE UPDATE ON "ClientDocument"/,
    )
    expect(migration).toContain('EXECUTE FUNCTION "guardBoundAgreementDocument"()')
  })

  it("scopes 'bound' to this application's agreement on an approved or disbursed loan", () => {
    expect(migration).toContain('application."agreementDocumentId" = OLD."id"')
    expect(migration).toContain('application."tenantId" = OLD."tenantId"')
    expect(migration).toContain('application."clientId" = OLD."clientId"')
    expect(migration).toMatch(/status"::TEXT IN \('APPROVED', 'DISBURSED'\)/)
  })

  it("returns early when the document is NOT bound, so regeneration still works", () => {
    // Regeneration repoints agreementDocumentId at the new document BEFORE
    // retiring the superseded draft. If this early return were removed the
    // guard would block the retire and break agreement regeneration outright.
    expect(migration).toMatch(/IF NOT bound THEN\s+RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;/)
  })

  it("refuses a hard DELETE of a bound agreement", () => {
    expect(migration).toMatch(
      /IF TG_OP = 'DELETE' THEN\s+RAISE EXCEPTION USING\s+ERRCODE = '23514'/,
    )
    expect(migration).toContain("A bound credit-agreement document is immutable")
  })

  it("refuses the soft-delete transition specifically, not every update", () => {
    // Narrow on purpose: the signing ceremony writes verified/verifiedAt/
    // verifiedById/signatureState/signedAt onto this same row. A whole-row
    // freeze (as the PASQ guard uses) would break the ceremony this document
    // exists for, so only NULL -> NOT NULL on deletedAt is refused.
    expect(migration).toContain('OLD."deletedAt" IS NULL AND NEW."deletedAt" IS NOT NULL')
    expect(migration).toContain("may not be retired")
    expect(migration).not.toMatch(/TO_JSONB\(NEW\)/)
  })
})
