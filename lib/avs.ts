// lib/avs.ts
/**
 * AVS bank-account verification service (Phase 7 slice 2).
 * Provider comes from the collections registry; result persisted per POPIA
 * audit needs. Gate helpers are pure so route code stays thin.
 */
import { prisma } from "@/lib/prisma"
import { getAvsProvider } from "@/lib/integrations/collections/registry"
import type { AvsChecks } from "@/lib/integrations/collections/types"
import {
  lockAffordabilityApplicationEvidence,
  lockAffordabilityClientEvidence,
} from "@/lib/affordability/evidence-locks"
import {
  avsCheckMatchesSubject,
  avsSubjectFingerprint,
  type AvsSubjectClient,
} from "@/lib/compliance/avs-subject"
import { Prisma, type BankAccountType } from "@prisma/client"

/**
 * The account type to put on the AVS wire for a client.
 *
 * The wire has two values. `AvsRequest["accountType"]` is `"CHEQUE" | "SAVINGS"`
 * because that is what Netcash accepts — there is no third value to send, and
 * AVS is mandatory for EVERY disbursement (`evaluateAvsGate` runs on the EFT
 * path too), so refusing to submit an OTHER client would simply block them.
 *
 * WHAT THIS COSTS, stated plainly: for an OTHER client the AVS result does NOT
 * verify the account type.
 *
 * What it DOES verify is narrow.
 * `netcash-avs-wire.ts` computes `passed = accountActive && acceptsDebits &&
 * idNumberMatch`. `lastNameMatch` is returned but is advisory and does not
 * affect `passed`, so AVS binds the account to an ID NUMBER — not to a name.
 * Do not describe it as verifying the account holder; the holder name is not
 * enforced by AVS here, and it is not enforced by the payout gate either (see
 * verifiedBankStatementEvidence in lib/compliance/debit-mandate.ts).
 *
 * The persisted `AvsCheck.accountType` deliberately records the client's REAL
 * type, not this submitted one, so the evidence row says what we hold rather
 * than what we sent.
 *
 * This exists as a named function because it used to be an inline
 * `=== "SAVINGS" ? "SAVINGS" : "CHEQUE"` ternary, which silently swallowed any
 * third enum value. That was harmless while the enum had two members and became
 * a live silent fallback the moment OTHER was added. A named function with a
 * total switch means the next enum value is a COMPILE error here, not a quiet
 * coercion discovered at runtime.
 */
export function avsWireAccountType(
  accountType: BankAccountType,
): "CHEQUE" | "SAVINGS" {
  switch (accountType) {
    case "SAVINGS":
      return "SAVINGS"
    case "CHEQUE":
      return "CHEQUE"
    case "OTHER":
      // Not verifiable on this wire. See the note above.
      return "CHEQUE"
    case "TRANSMISSION":
      // Retired and removed from every picker — but NOT unreachable. `PUT
      // /api/clients/[id]` writes `accountType: data.accountType` straight
      // through with no allow-list (unlike POST /api/clients, which runs
      // ACCOUNT_TYPE_VALUES), so a CREDIT_OFFICER can still set it, and the
      // value is still a live enum member.
      //
      // Throwing is therefore load-bearing rather than defensive: it fails the
      // AVS check closed instead of verifying the account as a cheque account it
      // is not. Disbursement independently refuses it at
      // `bank_details_incomplete`.
      throw new Error(
        "Cannot run AVS: this client's account type is TRANSMISSION, which was retired. Recapture the account type before verifying.",
      )
  }
}

export function evaluateAvsGate(
  latest: {
    clientId: string
    applicationId: string | null
    subjectFingerprint?: string | null
    passed: boolean
  } | null,
  client: AvsSubjectClient,
  applicationId: string,
): { ok: boolean; reason: string | null } {
  if (
    !client.bankName ||
    !client.bankAccountNumber ||
    !client.bankBranchCode ||
    !client.accountType
  ) return { ok: false, reason: "Client has no complete bank account captured" }
  if (!latest) return { ok: false, reason: "No AVS check on record for this account" }
  if (latest.applicationId !== applicationId)
    return { ok: false, reason: "No application-bound AVS check on record" }
  if (!avsCheckMatchesSubject(latest, client))
    return { ok: false, reason: "Applicant or bank details changed since the last AVS check — re-verify" }
  if (!latest.passed) return { ok: false, reason: "Latest AVS check failed" }
  return { ok: true, reason: null }
}

export async function runAvsCheck(params: {
  tenantId: string
  clientId: string
  applicationId?: string
  actor: { id: string; email: string }
}): Promise<{ id: string; passed: boolean; checks: AvsChecks }> {
  const [config, client] = await Promise.all([
    prisma.tenantConfig.findUnique({ where: { tenantId: params.tenantId } }),
    prisma.client.findUnique({ where: { id: params.clientId } }),
  ])
  if (!client || client.tenantId !== params.tenantId) throw new Error("Client not found")
  if (!client.bankName || !client.bankAccountNumber || !client.bankBranchCode || !client.accountType) {
    throw new Error("Client bank details incomplete — capture bank name, branch, account number and type first")
  }
  const checkedBankName = client.bankName
  const checkedAccountNumber = client.bankAccountNumber
  const checkedBranchCode = client.bankBranchCode
  const checkedAccountType = client.accountType
  const checkedSubjectFingerprint = avsSubjectFingerprint(client)

  const provider = getAvsProvider({
    collectionProvider: config?.collectionProvider ?? null,
    avsProvider: config?.avsProvider ?? null,
  })
  const result = await provider.verifyAccount(
    {
      accountHolder: `${client.firstName} ${client.lastName}`,
      idNumber: client.idNumber,
      bankName: checkedBankName,
      branchCode: checkedBranchCode,
      accountNumber: checkedAccountNumber,
      accountType: avsWireAccountType(checkedAccountType),
    },
    {
      netcashRiskReportsKey: config?.netcashRiskReportsKey,
      netcashDebitOrderKey: config?.netcashDebitOrderKey,
    }
  )

  const row = await prisma.$transaction(async (tx) => {
    // Provider I/O happens before taking database locks. Serialize only the
    // evidence commit with approval/disbursement, then prove that the account
    // checked is still the client's current account before inserting it.
    if (params.applicationId) {
      await lockAffordabilityApplicationEvidence(tx, {
        tenantId: params.tenantId,
        applicationId: params.applicationId,
      })
    }
    await lockAffordabilityClientEvidence(tx, {
      tenantId: params.tenantId,
      clientId: params.clientId,
    })

    const currentClient = await tx.client.findUnique({
      where: { id: params.clientId, tenantId: params.tenantId },
      select: {
        idNumber: true,
        firstName: true,
        lastName: true,
        bankName: true,
        bankAccountNumber: true,
        bankBranchCode: true,
        accountType: true,
      },
    })
    if (!currentClient || avsSubjectFingerprint({ id: client.id, ...currentClient }) !== checkedSubjectFingerprint) {
      throw new Error("Applicant or bank details changed during AVS verification — run the check again")
    }

    const avsCheckData = {
      tenantId: params.tenantId,
      clientId: client.id,
      applicationId: params.applicationId ?? null,
      subjectFingerprint: checkedSubjectFingerprint,
      provider: provider.id,
      accountHolder: `${client.firstName} ${client.lastName}`,
      bankName: checkedBankName,
      branchCode: checkedBranchCode,
      accountNumber: checkedAccountNumber,
      accountType: checkedAccountType,
      passed: result.passed,
      checks: result.checks as object,
      raw: result.raw === undefined ? undefined : (result.raw as object),
      checkedById: params.actor.id,
    } satisfies Prisma.AvsCheckUncheckedCreateInput & { subjectFingerprint: string }

    const row = await tx.avsCheck.create({
      data: avsCheckData,
    })
    await tx.auditLog.create({
      data: {
        tenantId: params.tenantId,
        userId: params.actor.id,
        userEmail: params.actor.email,
        action: "AVS_CHECK_RUN",
        entity: "AvsCheck",
        entityId: row.id,
        newValue: {
          passed: result.passed,
          provider: provider.id,
          applicationId: params.applicationId ?? null,
        },
      },
    })
    return row
  })

  return { id: row.id, passed: result.passed, checks: result.checks }
}
