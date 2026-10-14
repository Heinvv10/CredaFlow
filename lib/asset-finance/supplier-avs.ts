/**
 * The bank-account verification recorded when a supplier account is approved
 * (DESIGN D8, "AVS runs on approval").
 *
 * AVS cannot run for a supplier yet. The only AVS integration
 * (`CollectionProvider.verifyAccount`, lib/integrations/collections/) binds an
 * account to a natural person's SA ID number: the Netcash wire hardcodes
 * `<IsIdNumber>true</IsIdNumber>` and `passed` requires `idNumberMatch`. A
 * supplier is a juristic person with a registration number, so a call would
 * either always fail or verify nothing. Verifying a juristic account needs
 * provider support (a registration-number query), which is a new integration
 * and waits for Hein's go-ahead.
 *
 * Until then an approval stores `status: "NOT_RUN"` with the approver's manual
 * verification evidence (e.g. a bank-stamped confirmation letter), and
 * `avsPassed` stays NULL. The payout gate must treat an APPROVED account with
 * `avsPassed = NULL` as verified only by that manual evidence, confirmed on
 * its own SUPPLIER_BANK_VERIFIED checklist item.
 */
import type { Prisma } from "@prisma/client"

export const SUPPLIER_AVS_NOT_RUN_REASON =
  "Supplier AVS needs provider support: the AVS integration verifies an account against a natural person's ID number only"

export interface SupplierAvsRecord {
  status: "NOT_RUN"
  reason: string
  manualVerification: { note: string; verifiedById: string; verifiedAt: string }
}

export function supplierAvsNotRun(params: { note: string; verifiedById: string; verifiedAt: Date }): {
  avsResult: Prisma.InputJsonObject
  avsPassed: null
} {
  const record: SupplierAvsRecord = {
    status: "NOT_RUN",
    reason: SUPPLIER_AVS_NOT_RUN_REASON,
    manualVerification: {
      note: params.note,
      verifiedById: params.verifiedById,
      verifiedAt: params.verifiedAt.toISOString(),
    },
  }
  return { avsResult: { ...record, manualVerification: { ...record.manualVerification } }, avsPassed: null }
}
