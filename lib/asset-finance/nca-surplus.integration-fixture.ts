import { expect } from "vitest"
import { recordSurplusDetermination } from "./nca-surplus-determination"
import type { RecoveryFixture } from "./recovery.integration-fixture"
/** Synthetic evidence exercises the real writer, rather than defaulting absent credit data to no. */
export async function determineSurplusRecipient(fx: Pick<RecoveryFixture, "tenantId" | "officer">, loanId: string, competingAgreement = false) {
  const result = await recordSurplusDetermination({ tenantId: fx.tenantId, userId: fx.officer }, loanId, {
    competingAgreement, basis: competingAgreement ? "TEST retained registered credit agreement with this same consumer covers these same goods" : "TEST retained enquiry and creditor confirmation establishes no other provider has a registered credit agreement with this same consumer concerning these same goods",
    upload: { file: new File(["%PDF-1.4 TEST synthetic credit enquiry and creditor confirmation"], "credit-determination.pdf", { type: "application/pdf" }), docType: "OTHER", dealId: null },
  })
  expect(result.kind).toBe("done")
  return result
}
