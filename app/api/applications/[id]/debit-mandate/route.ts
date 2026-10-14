import { debitMandateBranchCodeError } from "@/lib/loan/debit-mandate-bank-validation"
import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { Prisma } from "@prisma/client"
import { auth } from "@/lib/auth"
import { requireOwnerOrStaff } from "@/lib/auth-guards"
import { prisma } from "@/lib/prisma"
import { withTenantContext } from "@/lib/tenant"
import { AuditAction } from "@/lib/audit"
import { recordedCallerIp } from "@/lib/rate-limit"
import { verifyLockedCurrentAffordabilityApproval } from "@/lib/affordability/current-approval"
import { requireDebitMandateBankDetails } from "@/lib/loan/debit-mandate"
import {
  createDebitMandateEvidence,
  debitMandateContractTerms,
  debitMandateEvidenceSha256,
  maskDebitMandateAccountNumber,
  type DebitMandateBankDetails,
} from "@/lib/compliance/debit-mandate"
import {
  debitMandateApplicationArgs,
  findVerifiedBankStatementForMandate,
  renderApplicationDebitMandatePdf,
  verifyCurrentStoredDebitMandate,
} from "@/lib/compliance/debit-mandate.server"
import {
  documentBytesMatchSha256,
  sha256DocumentBytes,
} from "@/lib/documents/content-integrity"
import { readFile } from "@/lib/storage"
import { DebitMandateConfigurationError } from "@/lib/config/debit-mandate"
import { LenderIdentityError } from "@/lib/config/identity"
import { EntityBorrowerError, hasClientBorrower, isEntityBorrowerError } from "@/lib/borrower"

type RouteCtx = { params: Promise<{ id: string }> }

class DebitMandatePreparationError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
    message: string,
  ) {
    super(message)
    this.name = "DebitMandatePreparationError"
  }
}

function parseBankDetails(body: unknown): DebitMandateBankDetails {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new DebitMandatePreparationError(400, "invalid_body", "Invalid request body.")
  }
  const value = body as Record<string, unknown>
  const stringValue = (key: string) =>
    typeof value[key] === "string" ? value[key].trim() : ""
  const accountType = stringValue("accountType")
  const candidate = {
    firstName: "Synthetic",
    lastName: "Account Holder",
    bankName: stringValue("bankName") || null,
    bankBranchCode: stringValue("branchCode") || null,
    bankAccountNumber: stringValue("accountNumber") || null,
    accountType,
  }
  try {
    return requireDebitMandateBankDetails(candidate)
  } catch {
    throw new DebitMandatePreparationError(
      400,
      "invalid_bank_details",
      "Enter a valid bank, six-digit branch code, 6-16 digit account number, and account type.",
    )
  }
}

function failureResponse(error: unknown) {
  if (error instanceof DebitMandatePreparationError) {
    return NextResponse.json(
      { error: error.message, debitMandate: error.reason },
      { status: error.status },
    )
  }
  if (error instanceof DebitMandateConfigurationError || error instanceof LenderIdentityError) {
    return NextResponse.json(
      { error: error.message, debitMandate: "configuration" },
      { status: 503 },
    )
  }
  if (isEntityBorrowerError(error)) {
    return NextResponse.json({ error: error.message }, { status: error.status })
  }
  console.error("[debit-mandate] failed:", error)
  return NextResponse.json(
    { error: "Failed to prepare or retrieve the debit mandate." },
    { status: 500 },
  )
}

export async function POST(req: NextRequest, { params }: RouteCtx) {
  const session = await auth()
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  if (session.user.role !== "CLIENT") {
    return NextResponse.json(
      { error: "The account holder must prepare the debit mandate in the customer portal." },
      { status: 403 },
    )
  }

  let bankDetails: DebitMandateBankDetails
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json(
      { error: "Invalid request body.", debitMandate: "invalid_body" },
      { status: 400 },
    )
  }
  try {
    bankDetails = parseBankDetails(body)
  } catch (error) {
    return failureResponse(error)
  }

  const { id } = await params
  try {
    return await withTenantContext(req, async (tenant) => {
      const result = await prisma.$transaction(async (tx) => {
        const locked = await verifyLockedCurrentAffordabilityApproval(tx, {
          tenantId: tenant.id,
          applicationId: id,
        })
        if (!locked.ok) {
          throw new DebitMandatePreparationError(
            409,
            locked.reason,
            "The approved affordability or compliance evidence changed. Return the application to review before preparing a debit mandate.",
          )
        }
        const application = await tx.loanApplication.findUnique({
          where: { id, tenantId: tenant.id },
          ...debitMandateApplicationArgs,
        })
        if (
          !application
          || application.clientId !== session.user.id
          || !hasClientBorrower(application)
        ) {
          throw new DebitMandatePreparationError(404, "not_found", "Application not found.")
        }
        if (application.status !== "APPROVED" || !application.agreementSignedAt) {
          throw new DebitMandatePreparationError(
            409,
            "agreement_not_signed",
            "Sign the approved credit agreement before setting up the debit mandate.",
          )
        }
        if (application.repaymentMethod !== "DEBIT_ORDER") {
          throw new DebitMandatePreparationError(
            409,
            "repayment_method_eft",
            "This application is approved for EFT repayment and does not require a debit mandate.",
          )
        }
        if (application.debitMandateSignedAt) {
          throw new DebitMandatePreparationError(
            409,
            "already_signed",
            "The debit mandate is already signed and cannot be replaced.",
          )
        }

        // A CONSUMER may not change the branch code here.
        //
        // Every other field on this form is bound to evidence: the account
        // number, the bank name and the account type are all compared against a
        // verified bank statement below, so a consumer can only move them to
        // something a statement supports. The branch code is not — that leg was
        // removed from `verifiedBankStatementEvidence` because SA banks use one
        // universal code and mostly do not print it, and the DISBURSED guard
        // now asserts only that it is non-null.
        //
        // That left this route writing an unbound six-digit value, from a
        // client session, straight onto the payout tuple that becomes
        // `Loan.disbursementBranchCode` — with no statement revocation, because
        // the statement still matches on the legs it does cover. Nothing
        // anywhere validates a branch code against a bank.
        //
        // So the rule is narrow rather than a blanket refusal: a consumer may
        // REPLACE a branch code that is unusable — absent, or failing
        // `debitMandateBranchCodeError` (not six digits, or a repeated-digit
        // placeholder like "000000") — because that is a genuine correction and
        // the consumer would otherwise be stuck with a code no payout can use.
        // They may NOT swap one VALID code for a different valid one, which is
        // the move that buys an attacker anything.
        //
        // Blanket refusal was the first attempt and was wrong: it broke the
        // real flow where staff capture a placeholder and the consumer supplies
        // the true code at mandate time. Revoking the verified statement on the
        // change — the way the staff edit path does — was the second attempt and
        // is also wrong here: this route embeds that statement's id in
        // `debitMandateEvidence`, so revoking it invalidates the mandate the
        // consumer is in the middle of signing.
        const storedBranchCode = application.client.bankBranchCode?.trim() ?? ""
        const storedIsUsable =
          storedBranchCode.length > 0
          && debitMandateBranchCodeError(storedBranchCode) === null
        if (
          storedIsUsable
          && storedBranchCode.replace(/\D/g, "")
            !== bankDetails.branchCode.replace(/\D/g, "")
        ) {
          throw new DebitMandatePreparationError(
            422,
            "branch_code_change_not_permitted",
            "The branch code on file cannot be changed here. Contact us if it is wrong and we will correct it.",
          )
        }

        const bankStatement = await findVerifiedBankStatementForMandate(
          tx as unknown as Parameters<typeof findVerifiedBankStatementForMandate>[0],
          {
            tenantId: tenant.id,
            clientId: application.clientId,
            bankDetails,
          },
        )
        if (!bankStatement.ok) {
          throw new DebitMandatePreparationError(
            422,
            bankStatement.reason,
            bankStatement.reason === "verified_bank_statement_mismatch"
              ? "The entered bank, account number, or account type does not match a verified bank statement."
              : "A verified bank statement with intact stored bytes and extracted banking details is required.",
          )
        }

        let contract
        try {
          contract = debitMandateContractTerms(
            application.affordabilityResult,
            application.pasqEvidence,
          )
        } catch {
          throw new DebitMandatePreparationError(
            422,
            "contract_invalid",
            "The immutable repayment schedule is missing or invalid.",
          )
        }
        const tenantInfo = await tx.tenant.findUnique({
          where: { id: tenant.id },
          select: { id: true },
        })
        if (!tenantInfo) {
          throw new DebitMandatePreparationError(
            503,
            "tenant_configuration",
            "Tenant configuration is unavailable.",
          )
        }

        const preparedAt = new Date()
        const collectionReference =
          application.debitMandateReference ?? `LN-${application.id}`
        const evidence = createDebitMandateEvidence({
          applicationId: application.id,
          clientId: application.clientId,
          collectionReference,
          contractFingerprint: contract.contractFingerprint,
          bankDetails,
          bankStatement: bankStatement.evidence,
          terms: contract.evidence,
          preparedAt,
        })
        const evidenceSha256 = debitMandateEvidenceSha256(evidence)
        const draft = await renderApplicationDebitMandatePdf({
          tenant: {
            id: tenantInfo.id,
          },
          application,
          collectionReference,
          bankDetails,
          paymentTerms: contract.paymentTerms,
          generatedAt: preparedAt,
        })
        const draftSha256 = sha256DocumentBytes(draft)
        const oldBank = {
          bankName: application.client.bankName,
          branchCode: application.client.bankBranchCode,
          accountNumberMasked: application.client.bankAccountNumber
            ? maskDebitMandateAccountNumber(application.client.bankAccountNumber)
            : null,
          accountType: application.client.accountType,
        }
        const newBank = {
          bankName: bankDetails.bankName,
          branchCode: bankDetails.branchCode,
          accountNumberMasked: maskDebitMandateAccountNumber(bankDetails.accountNumber),
          accountType: bankDetails.accountType,
        }
        const bankChanged =
          application.client.bankName !== bankDetails.bankName
          || application.client.bankBranchCode !== bankDetails.branchCode
          || application.client.bankAccountNumber !== bankDetails.accountNumber
          || application.client.accountType !== bankDetails.accountType

        if (bankChanged) {
          await tx.client.update({
            where: { id: application.clientId, tenantId: tenant.id },
            data: {
              bankName: bankDetails.bankName,
              bankBranchCode: bankDetails.branchCode,
              bankAccountNumber: bankDetails.accountNumber,
              accountType: bankDetails.accountType,
            },
          })
          await tx.auditLog.create({
            data: {
              tenantId: tenant.id,
              userId: null,
              userEmail: session.user.email,
              action: AuditAction.CLIENT_UPDATED,
              entity: "Client",
              entityId: application.clientId,
              oldValue: { banking: oldBank },
              newValue: {
                banking: newBank,
                source: "customer_debit_mandate",
                bankStatementDocumentId: bankStatement.evidence.documentId,
              },
            },
          })
        }

        const changed = await tx.loanApplication.updateMany({
          where: {
            id,
            tenantId: tenant.id,
            status: "APPROVED",
            repaymentMethod: "DEBIT_ORDER",
            updatedAt: application.updatedAt,
            agreementSignedAt: application.agreementSignedAt,
            debitMandateSignedAt: null,
          },
          data: {
            debitMandatePreparedAt: preparedAt,
            debitMandateReference: collectionReference,
            debitMandateDraftSha256: draftSha256,
            debitMandateEvidence: evidence as unknown as Prisma.InputJsonValue,
            debitMandateEvidenceSha256: evidenceSha256,
            debitMandateSignedMethod: null,
            debitMandateSignedByIp: null,
            debitMandateSignatureData: null,
            debitMandateSignatureSha256: null,
            debitMandateDocumentId: null,
            debitMandateDocumentSha256: null,
          },
        })
        if (changed.count !== 1) {
          throw new DebitMandatePreparationError(
            409,
            "application_changed",
            "The application changed while the mandate was being prepared. Refresh and try again.",
          )
        }
        await tx.auditLog.create({
          data: {
            tenantId: tenant.id,
            userId: null,
            userEmail: session.user.email,
            action: AuditAction.DEBIT_MANDATE_PREPARED,
            entity: "LoanApplication",
            entityId: id,
            oldValue: {
              draftDocumentSha256: application.debitMandateDraftSha256,
              evidenceSha256: application.debitMandateEvidenceSha256,
            },
            newValue: {
              preparedAt: preparedAt.toISOString(),
              collectionReference,
              draftDocumentSha256: draftSha256,
              evidenceSha256,
              contractFingerprint: contract.contractFingerprint,
              bankDetailsSha256: evidence.bankDetailsSha256,
              bankAccountMasked: evidence.bankAccountMasked,
              bankStatement: evidence.bankStatement,
              paymentTerms: evidence.terms,
            },
          },
        })
        return {
          preparedAt,
          collectionReference,
          draftDocumentSha256: draftSha256,
          evidenceSha256,
        }
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })

      return NextResponse.json(result)
    })
  } catch (error) {
    return failureResponse(error)
  }
}

export async function GET(req: NextRequest, { params }: RouteCtx) {
  const { id } = await params
  try {
    return await withTenantContext(req, async (tenant) => {
      const application = await prisma.loanApplication.findUnique({
        where: { id, tenantId: tenant.id },
        ...debitMandateApplicationArgs,
      })
      if (!application) {
        return NextResponse.json({ error: "Application not found" }, { status: 404 })
      }
      // A debit mandate is a consumer document; an entity borrower is refused.
      if (!hasClientBorrower(application)) {
        return NextResponse.json({ error: new EntityBorrowerError().message }, { status: 409 })
      }
      const access = await requireOwnerOrStaff(application.clientId)
      if (access.error) return access.error
      if (application.repaymentMethod !== "DEBIT_ORDER") {
        return NextResponse.json(
          {
            error: "This application is approved for EFT repayment and does not require a debit mandate.",
            debitMandate: "repayment_method_eft",
          },
          { status: 409 },
        )
      }
      if (!application.debitMandatePreparedAt) {
        return NextResponse.json(
          { error: "Debit mandate has not been prepared yet" },
          { status: 404 },
        )
      }
      if (application.debitMandateSignedAt) {
        const verification = await verifyCurrentStoredDebitMandate(
          prisma as unknown as Parameters<typeof verifyCurrentStoredDebitMandate>[0],
          {
            tenantId: tenant.id,
            application,
            requireSignature: true,
          },
        )
        if (!verification.ok) {
          return NextResponse.json(
            {
              error: "The debit-mandate banking, statement, schedule, or signature evidence no longer matches.",
              debitMandate: verification.reason,
            },
            { status: 422 },
          )
        }
        const document = await prisma.clientDocument.findFirst({
          where: {
            id: verification.documentId,
            tenantId: tenant.id,
            clientId: application.clientId,
            docType: "DEBIT_MANDATE",
            deletedAt: null,
            verified: true,
            signatureState: "signed",
            signedAt: verification.signedAt,
            contentSha256: verification.documentSha256,
            storagePath: { not: null },
          },
          select: { id: true, storagePath: true },
        })
        if (!document?.storagePath) {
          return NextResponse.json(
            { error: "The signed debit-mandate document is missing." },
            { status: 422 },
          )
        }
        let bytes: Buffer
        try {
          bytes = await readFile(document.storagePath)
        } catch {
          return NextResponse.json(
            { error: "The signed debit-mandate bytes are unavailable." },
            { status: 422 },
          )
        }
        if (!documentBytesMatchSha256(bytes, verification.documentSha256)) {
          return NextResponse.json(
            { error: "The signed debit-mandate bytes failed their integrity check." },
            { status: 422 },
          )
        }
        await prisma.documentAccessLog.create({
          data: {
            documentId: document.id,
            accessorType: access.type,
            accessorId: access.type === "staff" ? access.user.id : access.clientId,
            action: "view",
            ipAddress: recordedCallerIp(req),
            userAgent: req.headers.get("user-agent") ?? null,
          },
        })
        return new Response(new Uint8Array(bytes), {
          headers: {
            "Content-Type": "application/pdf",
            "Content-Disposition": `inline; filename="Debit-Mandate-${verification.evidence.collectionReference}.pdf"`,
            "Cache-Control": "private, no-store",
            "X-Document-State": "SIGNED",
            "X-Document-SHA256": verification.documentSha256,
          },
        })
      }

      const verification = await verifyCurrentStoredDebitMandate(
        prisma as unknown as Parameters<typeof verifyCurrentStoredDebitMandate>[0],
        {
          tenantId: tenant.id,
          application,
          requireSignature: false,
        },
      )
      if (!verification.ok) {
        return NextResponse.json(
          {
            error: "The debit-mandate banking, statement, or schedule evidence no longer matches.",
            debitMandate: verification.reason,
          },
          { status: 422 },
        )
      }

      const tenantInfo = await prisma.tenant.findUnique({
        where: { id: tenant.id },
        select: { id: true },
      })
      if (!tenantInfo) {
        return NextResponse.json(
          { error: "Tenant configuration is unavailable." },
          { status: 503 },
        )
      }
      const draft = await renderApplicationDebitMandatePdf({
        tenant: {
          id: tenantInfo.id,
        },
        application,
        collectionReference: verification.evidence.collectionReference,
        bankDetails: verification.bankDetails,
        paymentTerms: verification.contract.paymentTerms,
        generatedAt: application.debitMandatePreparedAt,
      })
      if (!documentBytesMatchSha256(draft, verification.draftDocumentSha256)) {
        return NextResponse.json(
          {
            error: "The prepared debit-mandate preview no longer matches its recorded hash.",
            debitMandate: "draft_bytes_changed",
          },
          { status: 422 },
        )
      }
      await prisma.documentAccessLog.create({
        data: {
          documentId: application.id,
          accessorType: access.type,
          accessorId: access.type === "staff" ? access.user.id : access.clientId,
          action: "view_debit_mandate_draft",
          ipAddress: recordedCallerIp(req),
          userAgent: req.headers.get("user-agent") ?? null,
        },
      })
      return new Response(new Uint8Array(draft), {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `inline; filename="Debit-Mandate-DRAFT-${verification.evidence.collectionReference}.pdf"`,
          "Cache-Control": "private, no-store",
          "X-Document-State": "DRAFT",
          "X-Document-SHA256": verification.draftDocumentSha256,
        },
      })
    })
  } catch (error) {
    return failureResponse(error)
  }
}
