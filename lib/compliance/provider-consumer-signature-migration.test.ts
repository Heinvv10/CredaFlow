import { describe, expect, it } from "vitest"
import {
  baselineConstraintSql,
  baselineFunctionSql,
  baselineTriggerSql,
  readBaselineSql,
} from "../db-baseline.test-helpers"

const migration = baselineFunctionSql("guardLoanApplicationProviderCountersign")
const envelope = baselineFunctionSql("providerCountersignEnvelopeSha256")
const signerTenant = baselineFunctionSql("guardLoanApplicationProviderSignerTenant")

describe("provider-to-consumer signature database binding", () => {
  it("requires the consumer artefact and countersign envelope before disbursement", () => {
    expect(readBaselineSql()).toMatch(
      /^CREATE TABLE "LoanApplication" \([^;]*\n {4}"agreementCountersignatureEnvelopeSha256" TEXT,/m,
    )
    expect(migration).toContain(
      `NEW."agreementSignedMethod" NOT IN ('portal', 'branch')`,
    )
    expect(migration).toContain(`NEW."agreementSignatureData" IS NULL`)
    expect(migration).toContain(
      `NEW."agreementCountersignatureEnvelopeSha256" IS NULL`,
    )
    expect(migration).toContain(
      "provider countersign evidence bound to the exact tenant, consumer signature and agreement",
    )
  })

  it("freezes both sides of the signature evidence after countersign", () => {
    expect(migration).toContain(
      `OLD."agreementCountersignedAt" IS NOT NULL`,
    )
    expect(migration).toContain(
      `NEW."agreementSignatureData" IS DISTINCT FROM OLD."agreementSignatureData"`,
    )
    expect(migration).toContain(
      `NEW."agreementCountersignatureEnvelopeSha256"`,
    )
    expect(migration).toContain(
      "Consumer and provider signature evidence is immutable after provider countersign",
    )
  })

  it("recomputes both provider and consumer-bound envelope hashes in PostgreSQL", () => {
    expect(envelope).toContain(
      `CREATE OR REPLACE FUNCTION public."providerCountersignEnvelopeSha256"`,
    )
    expect(migration).toContain(
      `sha256(convert_to(NEW."agreementCountersignatureData", 'UTF8'))`,
    )
    expect(migration).toContain(
      `sha256(convert_to(NEW."agreementSignatureData", 'UTF8'))`,
    )
    expect(migration).toContain(
      `IS DISTINCT FROM expected_provider_signature_sha256`,
    )
    expect(migration).toContain(
      `IS DISTINCT FROM expected_envelope_sha256`,
    )
    expect(migration).toContain(
      `NEW."agreementSignedMethod" IS NULL`,
    )
    expect(envelope).toContain(
      `'provider-countersign-envelope-v3'`,
    )
    expect(migration).toContain(
      `"providerCountersignEnvelopeSha256"(\n      NEW."tenantId",`,
    )
    expect(migration).toContain(
      `NEW."tenantId" IS DISTINCT FROM OLD."tenantId"`,
    )
    expect(baselineTriggerSql("LoanApplication_guard_provider_countersign_update")).toContain(
      `BEFORE UPDATE ON "LoanApplication"`,
    )
    expect(
      baselineConstraintSql("LoanApplication_tenantId_agreementCountersignedById_fkey"),
    ).toContain(
      `FOREIGN KEY ("tenantId", "agreementCountersignedById")`,
    )
    expect(signerTenant).toContain(
      `CREATE OR REPLACE FUNCTION public."guardLoanApplicationProviderSignerTenant"`,
    )
    expect(signerTenant).toContain(
      `AND signer."active" = TRUE`,
    )
    expect(signerTenant).toContain(
      `'LOAN_ADMIN'::"UserRole"`,
    )
    expect(signerTenant).toContain(
      `'BRANCH_MANAGER'::"UserRole"`,
    )
    expect(signerTenant).not.toContain(
      `'READONLY'::"UserRole"`,
    )
    expect(signerTenant).toContain(
      `NEW."agreementCountersignedAt"\n      IS DISTINCT FROM OLD."agreementCountersignedAt"`,
    )
  })

  it("permits only the complete approved-to-review invalidation path", () => {
    expect(migration).toContain(`OLD."status"::TEXT = 'APPROVED'`)
    expect(migration).toContain(`NEW."status"::TEXT = 'UNDER_REVIEW'`)
    expect(migration).toContain(
      `NEW."agreementCountersignatureEnvelopeSha256" IS NULL`,
    )
  })
})
