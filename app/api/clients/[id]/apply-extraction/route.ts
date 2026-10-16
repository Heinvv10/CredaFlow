import { NextResponse } from "next/server"
import { isSimulatedBureauCheck } from "@/lib/decision/bureau-simulated"
import type { NextRequest } from "next/server"
import { createHash } from "node:crypto"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { AuditAction } from "@/lib/audit"
import { withTenantContext } from "@/lib/tenant"
import type { Gender, BankAccountType, DocType } from "@prisma/client"
import { lockAffordabilityClientEvidence } from "@/lib/affordability/evidence-locks"
import {
  bankEvidenceAuditValue,
  bankEvidenceFingerprint,
  type BankEvidenceTuple,
} from "@/lib/compliance/bank-evidence"
import { updateClientWithBiometricIdentityRevocation } from "@/lib/kyc/identity-revocation"
import { holdManualPending } from "@/lib/kyc/manual-pending.server"
import { biometricSubjectFingerprint } from "@/lib/kyc/biometric-evidence"
import { bureauSubjectFingerprint } from "@/lib/compliance/bureau-subject"
import { avsSubjectFingerprint } from "@/lib/compliance/avs-subject"
import {
  clientKycAuditValue,
  readCompositeKycState,
  type CompositeKycReader,
} from "@/lib/kyc/document-state"
import {
  resolveExtractedAccountType,
  resolveExtractedBankName,
  type SkippedExtractionField,
} from "@/lib/kyc/extraction-bank-fields"

type ExtractionField = { value: unknown; validated?: boolean }

// Explicit whitelist of fields that extraction may write — nothing outside this
// list can reach prisma.client.update, regardless of what the VLM returns.
interface ExtractionUpdates {
  idNumber?: string
  firstName?: string
  lastName?: string
  dateOfBirth?: Date
  gender?: Gender
  employerName?: string
  grossMonthlyIncome?: number
  monthlyIncome?: number
  bankName?: string
  bankAccountNumber?: string
  bankBranchCode?: string
  accountType?: BankAccountType
  addressLine1?: string
  suburb?: string
  city?: string
  province?: string
  postalCode?: string
}

// Client fields an APPROVED application's decision evidence is fingerprinted on:
// income feeds the immutable affordability snapshot and its Regulation 23A
// expense evidence; identity feeds the bureau subject fingerprint and the
// biometric subject; the bank tuple is what the verified statement must match at
// payout. Employer and address are deliberately absent — no gate binds them, so
// extraction may still correct them on an approved file.
const APPROVAL_BOUND_FIELDS = [
  "monthlyIncome",
  "grossMonthlyIncome",
  "idNumber",
  "firstName",
  "lastName",
  "gender",
  "dateOfBirth",
  "bankName",
  "bankAccountNumber",
  "bankBranchCode",
  "accountType",
] as const satisfies readonly (keyof ExtractionUpdates)[]

// Dates are compared by instant, not identity: `new Date(x) !== new Date(x)`,
// so a re-applied date of birth would otherwise read as a change and block.
function sameStoredValue(next: unknown, current: unknown): boolean {
  if (next instanceof Date || current instanceof Date) {
    const a = next instanceof Date ? next.getTime() : NaN
    const b = current instanceof Date ? current.getTime() : NaN
    return Number.isNaN(a) && Number.isNaN(b) ? next === current : a === b
  }
  return next === current
}

// Maps stored extraction field names → client update field names, per doc type.
// Only fields listed here can be applied — no open-ended dynamic key injection.
type ExtractionMapping = (
  raw: Record<string, ExtractionField>,
  out: ExtractionUpdates
) => void

const APPLY_MAPS: Record<string, ExtractionMapping> = {
  ID_COPY: (raw, out) => {
    // Same rule as PAYSLIP below: a field the extractor flagged is not applied
    // by one click. applyIdValidationPostProcessing (lib/vlm-extract.ts) sets
    // validated:false on documentNumber when the SA ID fails the Luhn checksum
    // or is not 13 digits — the signatures of an OCR misread (O→0, I→1, S→5).
    // That number feeds the bureau subject fingerprint and the biometric
    // subject, so applying a misread one both corrupts the record and revokes
    // the client's biometric evidence. A human retypes it.
    const str = (k: string) => {
      const field = raw[k]
      if (!field || field.validated === false) return undefined
      return field.value != null && field.value !== "" ? String(field.value) : undefined
    }
    const id = str("documentNumber"); if (id) out.idNumber = id
    const fn = str("firstName");      if (fn) out.firstName = fn
    const ln = str("surname");        if (ln) out.lastName = ln
    const gRaw = str("gender")?.toUpperCase()
    if (gRaw === "MALE" || gRaw === "FEMALE" || gRaw === "OTHER") out.gender = gRaw
    const dob = str("dateOfBirth")
    if (dob) { const d = new Date(dob); if (!isNaN(d.getTime())) out.dateOfBirth = d }
  },
  PAYSLIP: (raw, out) => {
    const employer = raw["employerName"]?.value
    if (employer != null && employer !== "") out.employerName = String(employer)
    // applyPayslipPostProcessing (lib/vlm-extract.ts) sets validated:false on the
    // money fields when gross - deductions != net, which is how a year-to-date
    // column read in place of the current month shows up. Such a figure is several
    // times the client's real monthly income and affordability is decided on it,
    // so it must not reach the record from a one-click apply — a human retypes it.
    const money = (k: string) => {
      const field = raw[k]
      if (!field || field.validated === false) return undefined
      const n = Number(field.value)
      return !isNaN(n) && n > 0 ? n : undefined
    }
    const gross = money("grossIncome"); if (gross !== undefined) out.grossMonthlyIncome = gross
    const net = money("netIncome");     if (net !== undefined) out.monthlyIncome = net
  },
  BANK_STATEMENT: (raw, out) => {
    const str = (k: string) => (raw[k]?.value != null && raw[k].value !== "" ? String(raw[k].value) : undefined)
    // Left as printed: bankName is decided against the client record, which
    // this map cannot see. resolveExtractedBankName settles it below.
    const bank = str("bankName");     if (bank) out.bankName = bank
    const acc  = str("accountNumber"); if (acc)  out.bankAccountNumber = acc
    const brc  = str("branchCode");   if (brc)  out.bankBranchCode = brc
    // OTHER is deliberately NOT auto-applied, and this is the one place that
    // decision is enforced.
    //
    // The extraction prompt (lib/vlm-extract.ts) asks the model for exactly
    // CHEQUE, SAVINGS or OTHER, and OTHER is what it returns for the unlisted
    // bank product that BankAccountType.OTHER exists to serve. Letting it land
    // here would make OTHER a thing a document can assert, when the whole point
    // of the value is that a STAFF MEMBER decides, on the record and in the
    // audit log, that a printed product name is neither cheque nor savings.
    //
    // So an extracted OTHER leaves the field untouched. The staff member still
    // sees `accountType: OTHER` on the extraction card and sets it by hand if
    // they agree. This is a deliberate refusal, not the fall-through it looks
    // like — do not "fix" it by adding OTHER to the condition.
    const typeRaw = str("accountType")?.toUpperCase()
    if (typeRaw === "CHEQUE" || typeRaw === "SAVINGS") out.accountType = typeRaw
  },
  PROOF_OF_ADDRESS: (raw, out) => {
    const str = (k: string) => (raw[k]?.value != null && raw[k].value !== "" ? String(raw[k].value) : undefined)
    const a1 = str("addressLine1"); if (a1) out.addressLine1 = a1
    const su = str("suburb");       if (su) out.suburb = su
    const ci = str("city");         if (ci) out.city = ci
    const pr = str("province");     if (pr) out.province = pr
    const pc = str("postalCode");   if (pc) out.postalCode = pc
  },
}

function extractionFieldFingerprints(
  source: object,
  fields: string[],
): Record<string, string> {
  const values = source as Record<string, unknown>
  return Object.fromEntries(fields.map((field) => {
    const value = values[field]
    const normalized = value instanceof Date ? value.toISOString() : value ?? null
    return [field, createHash("sha256").update(JSON.stringify([
      "extraction-field-v1",
      field,
      normalized,
    ])).digest("hex")]
  }))
}

function bankTuple(source: BankEvidenceTuple): BankEvidenceTuple {
  return {
    bankName: source.bankName,
    bankAccountNumber: source.bankAccountNumber,
    bankBranchCode: source.bankBranchCode,
    accountType: source.accountType,
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const guard = await requireApiRole("CREDIT_OFFICER")
    if (guard.error) return guard.error

    return withTenantContext(req, async (tenant) => {
      const { id: clientId } = await params

      const body = (await req.json()) as {
        documentId: string
        acknowledgeIdentityRevocation?: unknown
      }
      const { documentId } = body
      if (typeof documentId !== "string" || !documentId.trim()) {
        return NextResponse.json({ error: "documentId is required" }, { status: 400 })
      }
      // Only a literal true acknowledges. An absent or malformed flag must not
      // read as consent to revoke a client's verified KYC.
      const acknowledgeIdentityRevocation = body.acknowledgeIdentityRevocation === true

      const mutation = await prisma.$transaction(async (tx) => {
        // The document-delete route takes this same lock before soft-deleting.
        // Read extraction evidence only after acquiring it so a deleted or
        // superseded source can never be applied from an earlier snapshot.
        await lockAffordabilityClientEvidence(tx, {
          tenantId: tenant.id,
          clientId,
        })

        const previous = await tx.client.findUnique({
          where: { id: clientId, tenantId: tenant.id },
        })
        if (!previous) {
          return { ok: false as const, status: 404, error: "Client not found" }
        }

        const doc = await tx.clientDocument.findFirst({
          where: {
            id: documentId,
            tenantId: tenant.id,
            clientId,
            deletedAt: null,
          },
          select: {
            id: true,
            docType: true,
            extractionStatus: true,
            extractionGeneration: true,
            extractionResult: true,
            validationResult: true,
            validationScore: true,
            clientId: true,
          },
        } as never) as unknown as {
          id: string
          docType: string
          extractionStatus: string
          extractionGeneration: string | null
          extractionResult: unknown
          validationResult: unknown
          validationScore: number | null
          clientId: string
        } | null
        if (!doc) {
          return { ok: false as const, status: 404, error: "Document not found" }
        }

        const applyMap = APPLY_MAPS[doc.docType]
        if (doc.extractionStatus !== "done") {
          return {
            ok: false as const,
            status: 409,
            error: "Extraction is not complete",
          }
        }
        if (doc.validationResult === null || doc.validationScore === null) {
          return {
            ok: false as const,
            status: 409,
            error: "Document validation is not complete",
          }
        }
        if (!applyMap || !doc.extractionResult) {
          return { ok: false as const, status: 422, error: "No extraction data available" }
        }

        const updates: ExtractionUpdates = {}
        applyMap(doc.extractionResult as Record<string, ExtractionField>, updates)

        // Both bank fields are decided against the client record, which the map
        // above never sees: settled here, under the lock, before any comparison
        // below reads them. A field the record already answers is DELETED, not
        // set to undefined — `data: updates` goes straight to
        // prisma.client.update, where an absent key and an explicit undefined
        // are different statements.
        const accountType = resolveExtractedAccountType({ extracted: updates.accountType, record: previous.accountType })
        if (accountType.apply === undefined) delete updates.accountType
        const bankName = resolveExtractedBankName({ extracted: updates.bankName, record: previous.bankName })
        if (bankName.apply === undefined) delete updates.bankName
        else updates.bankName = bankName.apply
        const skipped: SkippedExtractionField[] = accountType.skipped ? [accountType.skipped] : []

        const appliedFields = Object.keys(updates).filter(
          (key) => updates[key as keyof ExtractionUpdates] !== undefined,
        )
        if (appliedFields.length === 0) {
          // A statement whose only extractable field was an accountType the
          // record already answers has nothing to apply — but saying only
          // "nothing to apply" would hide that a value WAS read and kept out.
          return {
            ok: false as const,
            status: 422,
            error: skipped.length > 0
              ? "No applicable fields to apply; the client record's account type was kept."
              : "No applicable fields to apply",
          }
        }

        // An APPROVED application pins these values inside evidence the
        // disbursement gate re-derives and compares: the immutable affordability
        // snapshot (income), the bureau subject fingerprint (identity), and the
        // payout tuple the verified bank statement must match. Changing any of
        // them afterwards makes the payout unrepairable except by a fresh
        // approval — which means a new PASQ and a new consumer signature.
        //
        // Only a real change counts. Re-applying identical values moves no
        // fingerprint, so routine document housekeeping is not blocked.
        const changedBoundFields = APPROVAL_BOUND_FIELDS.filter((field) => {
          const next = updates[field]
          if (next === undefined) return false
          return !sameStoredValue(next, previous[field])
        })
        if (changedBoundFields.length > 0) {
          const approved = await tx.loanApplication.findFirst({
            where: { tenantId: tenant.id, clientId, status: "APPROVED" },
            select: { id: true, reference: true },
          })
          if (approved) {
            return {
              ok: false as const,
              status: 409,
              error: `Cannot apply extraction: application ${approved.reference} is approved and its decision evidence is bound to ${changedBoundFields.join(", ")}. Return the application to review first, then apply this document and approve it again.`,
            }
          }
        }

        const nextBiometricSubject = {
          id: clientId,
          idNumber: updates.idNumber ?? previous.idNumber,
          firstName: updates.firstName ?? previous.firstName,
          lastName: updates.lastName ?? previous.lastName,
          dateOfBirth: updates.dateOfBirth ?? previous.dateOfBirth,
        }

        // Applying identity fields silently revokes biometric KYC.
        //
        // updateClientWithBiometricIdentityRevocation below un-verifies every
        // verified selfie and resets kycStatus whenever the subject fingerprint
        // moves. That is correct — evidence bound to the old identity does not
        // describe the new one — but it happened with no warning, and OCR'd
        // names arrive here one click away from a bulk apply. An ID_COPY
        // apply can destroy an in-person verification and passing selfies; the
        // only remaining route is to re-verify the person.
        //
        // The APPROVED-application refusal above is the same shape: name what
        // is bound, refuse, say how to proceed. This one is overridable because
        // correcting a genuinely wrong name is a legitimate reason to spend the
        // evidence — but it must be a decision, not a side effect.
        // Three subject fingerprints bind evidence to this client's identity,
        // and they cover different fields — so each is checked on its own. A
        // gender-only correction moves the bureau subject and neither of the
        // others; a bank-detail correction moves only the AVS one. Warning
        // about a subset would state a loss list that is not the loss list.
        const biometricSubjectMoves =
          biometricSubjectFingerprint({
            id: clientId,
            idNumber: previous.idNumber,
            firstName: previous.firstName,
            lastName: previous.lastName,
            dateOfBirth: previous.dateOfBirth,
          }) !== biometricSubjectFingerprint(nextBiometricSubject)

        const previousBureauFingerprint = bureauSubjectFingerprint(previous)
        const bureauSubjectMoves = previousBureauFingerprint !== bureauSubjectFingerprint({
          ...previous,
          idNumber: updates.idNumber ?? previous.idNumber,
          firstName: updates.firstName ?? previous.firstName,
          lastName: updates.lastName ?? previous.lastName,
          gender: updates.gender ?? previous.gender,
          dateOfBirth: updates.dateOfBirth ?? previous.dateOfBirth,
        })

        const previousAvsFingerprint = avsSubjectFingerprint(previous)
        const avsSubjectMoves = previousAvsFingerprint !== avsSubjectFingerprint({
          ...previous,
          idNumber: updates.idNumber ?? previous.idNumber,
          firstName: updates.firstName ?? previous.firstName,
          lastName: updates.lastName ?? previous.lastName,
          bankName: updates.bankName ?? previous.bankName,
          bankBranchCode: updates.bankBranchCode ?? previous.bankBranchCode,
          bankAccountNumber: updates.bankAccountNumber ?? previous.bankAccountNumber,
          accountType: updates.accountType ?? previous.accountType,
        })

        // A bank-tuple change moves the AVS subject and NOTHING else, and this
        // route already owns that case further down: it invalidates the verified
        // bank statements and writes a bankEvidenceRevocation audit, without
        // blocking. Correcting bank details from a bank statement is the normal
        // use of that document. So AVS movement alone does not refuse — it would
        // put a confirmation in front of a routine action that already has a
        // handler. It is still COUNTED below, because when identity really does
        // move it strands the AVS check too and the loss list must say so.
        if (
          (biometricSubjectMoves || bureauSubjectMoves) &&
          !acknowledgeIdentityRevocation
        ) {
          // Count only evidence that is USABLE NOW and would stop being so.
          // A check whose fingerprint already fails to match is stranded
          // already, and re-reporting it as a fresh loss would overstate the
          // cost of this apply. Sequential, not concurrent: these share the
          // transaction's single connection.
          const verifiedSelfies = biometricSubjectMoves
            ? await tx.clientDocument.count({
                where: {
                  tenantId: tenant.id,
                  clientId,
                  docType: "SELFIE" as DocType,
                  deletedAt: null,
                  verified: true,
                },
              })
            : 0
          // `ok`/`passed` false means the check never produced usable evidence
          // (lib/avs.ts refuses a failed AVS check outright). Counting one would
          // bill the operator for a loss that already did not exist.
          // A simulated row cost nothing and is not evidence, so it is not stranded.
          const bureauChecks = bureauSubjectMoves
            ? (
                await tx.creditBureauCheck.findMany({
                  where: {
                    tenantId: tenant.id,
                    clientId,
                    subjectFingerprint: previousBureauFingerprint,
                    ok: true,
                  },
                  select: { obligations: true },
                })
              ).filter((check) => !isSimulatedBureauCheck(check.obligations)).length
            : 0
          const avsChecks = avsSubjectMoves
            ? await tx.avsCheck.count({
                where: {
                  tenantId: tenant.id,
                  clientId,
                  subjectFingerprint: previousAvsFingerprint,
                  passed: true,
                },
              })
            : 0
          const revokesVerifiedKyc = biometricSubjectMoves && previous.kycStatus === "VERIFIED"

          if (verifiedSelfies > 0 || bureauChecks > 0 || avsChecks > 0 || revokesVerifiedKyc) {
            const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`
            const losses = [
              revokesVerifiedKyc
                ? `this client's KYC verification${previous.kycVerificationMethod
                    ? ` (${previous.kycVerificationMethod.toLowerCase()})`
                    : ""}`
                : null,
              verifiedSelfies > 0 ? plural(verifiedSelfies, "verified selfie") : null,
              bureauChecks > 0 ? `${plural(bureauChecks, "credit-bureau check")} (a re-pull needs fresh consent)` : null,
              avsChecks > 0 ? plural(avsChecks, "bank-account verification") : null,
            ].filter(Boolean)
            return {
              ok: false as const,
              status: 409,
              error:
                `Applying this document changes the client's identity details, which makes ${losses.join(", ")} unusable. ` +
                `That evidence would have to be obtained again. ` +
                `Check the extracted values against the document first — if the change is correct, re-apply with acknowledgeIdentityRevocation.`,
              identityRevocation: {
                changedFields: ([
                  "idNumber", "firstName", "lastName", "dateOfBirth", "gender",
                  "bankName", "bankAccountNumber", "bankBranchCode", "accountType",
                ] as const)
                  .filter((f) => updates[f] !== undefined && !sameStoredValue(updates[f], previous[f])),
                verifiedSelfies,
                bureauChecks,
                avsChecks,
                revokesVerifiedKyc,
              },
            }
          }
        }
        const {
          client: updated,
          revocation: biometricIdentityRevocation,
        } = await updateClientWithBiometricIdentityRevocation(tx, {
          tenantId: tenant.id,
          clientId,
          previous,
          nextSubject: nextBiometricSubject,
          where: { id: clientId, tenantId: tenant.id },
          data: updates,
          actor: { userId: guard.user.id, userEmail: guard.user.email },
          source: "document_extraction",
          // Distinguishes a revocation the operator was warned about and chose,
          // from one that simply happened. Both otherwise look identical here.
          acknowledged: acknowledgeIdentityRevocation,
        })

        const previousBank = bankTuple(previous)
        const updatedBank = bankTuple(updated)
        const bankDetailsChanged = doc.docType === "BANK_STATEMENT" &&
          bankEvidenceFingerprint(previousBank) !== bankEvidenceFingerprint(updatedBank)
        const verifiedBankDocuments = bankDetailsChanged
          ? await tx.clientDocument.findMany({
              where: {
                tenantId: tenant.id,
                clientId,
                docType: "BANK_STATEMENT",
                deletedAt: null,
                verified: true,
              },
              select: { id: true },
              orderBy: { id: "asc" },
            })
          : []
        let invalidatedBankDocumentCount = 0
        let bankKycProjection: {
          previous: ReturnType<typeof clientKycAuditValue>
          current: ReturnType<typeof clientKycAuditValue>
        } | null = null

        if (verifiedBankDocuments.length > 0) {
          // Applying extracted account details changes the payout tuple. No
          // previously verified statement remains authoritative until staff
          // verifies it against the newly applied client record.
          const invalidated = await tx.clientDocument.updateMany({
            where: {
              tenantId: tenant.id,
              clientId,
              docType: "BANK_STATEMENT",
              deletedAt: null,
              verified: true,
              id: { in: verifiedBankDocuments.map(({ id }) => id) },
            },
            data: {
              verified: false,
              verifiedAt: null,
              verifiedById: null,
              verificationNote: "Bank details were applied from extraction; verify against the current client account before disbursement.",
            },
          })
          if (invalidated.count !== verifiedBankDocuments.length) {
            throw new Error("Bank evidence changed concurrently; refresh and apply the extraction again")
          }
          invalidatedBankDocumentCount = invalidated.count

          // The database evidence trigger may already have revoked VERIFIED to
          // PENDING as part of the document update. Re-read under the same lock
          // instead of auditing/projecting from the stale pre-trigger `updated`
          // object returned by the earlier Client mutation.
          const clientAfterBankInvalidation = await tx.client.findUnique({
            where: { id: clientId, tenantId: tenant.id },
          })
          if (!clientAfterBankInvalidation) {
            throw new Error("Client disappeared while bank evidence was being invalidated")
          }

          const compositeKyc = await readCompositeKycState(
            tx as unknown as CompositeKycReader,
            {
              tenantId: tenant.id,
              clientId,
              subject: clientAfterBankInvalidation,
              existing: clientAfterBankInvalidation,
              preserveVerifiedProvenance: true,
            },
          )
          const projectedState = await holdManualPending(tx, {
            tenantId: tenant.id, clientId, storedKycStatus: clientAfterBankInvalidation.kycStatus, state: compositeKyc.state,
          })
          const previousKyc = clientKycAuditValue(clientAfterBankInvalidation)
          const currentKyc = clientKycAuditValue(projectedState)
          if (JSON.stringify(previousKyc) !== JSON.stringify(currentKyc)) {
            const projectedClient = await tx.client.update({
              where: { id: clientId, tenantId: tenant.id },
              data: projectedState,
              select: {
                kycStatus: true,
                kycVerifiedAt: true,
                kycVerifiedById: true,
                kycVerificationMethod: true,
              },
            })
            bankKycProjection = {
              previous: previousKyc,
              current: clientKycAuditValue(projectedClient),
            }
            await tx.auditLog.create({
              data: {
                tenantId: tenant.id,
                userId: guard.user.id,
                userEmail: guard.user.email,
                action: AuditAction.KYC_STATUS_CHANGED,
                entity: "Client",
                entityId: clientId,
                oldValue: {
                  source: "document_extraction",
                  reason: "bank_evidence_invalidated",
                  sourceDocumentId: doc.id,
                  clientKyc: bankKycProjection.previous,
                },
                newValue: {
                  source: "document_extraction",
                  reason: "bank_evidence_invalidated",
                  sourceDocumentId: doc.id,
                  invalidatedDocumentIds: verifiedBankDocuments.map(({ id }) => id),
                  clientKyc: bankKycProjection.current,
                },
              },
            })
          }
        }

        await tx.auditLog.create({
          data: {
            tenantId: tenant.id,
            userId: guard.user.id,
            userEmail: guard.user.email,
            action: AuditAction.CLIENT_UPDATED,
            entity: "Client",
            entityId: clientId,
            oldValue: {
              sourceDocumentId: doc.id,
              sourceDocumentType: doc.docType,
              sourceExtractionGeneration: doc.extractionGeneration,
              appliedFields,
              fieldFingerprints: extractionFieldFingerprints(previous, appliedFields),
              ...(doc.docType === "BANK_STATEMENT" && {
                bankEvidence: bankEvidenceAuditValue(previousBank),
              }),
              ...(biometricIdentityRevocation && {
                biometricIdentityEvidence: {
                  subjectFingerprint: biometricIdentityRevocation.previousSubjectFingerprint,
                },
              }),
            },
            newValue: {
              sourceDocumentId: doc.id,
              sourceDocumentType: doc.docType,
              sourceExtractionGeneration: doc.extractionGeneration,
              appliedFields,
              fieldFingerprints: extractionFieldFingerprints(updated, appliedFields),
              ...(doc.docType === "BANK_STATEMENT" && {
                bankEvidence: bankEvidenceAuditValue(updatedBank),
              }),
              ...(bankDetailsChanged && {
                bankEvidenceRevocation: {
                  reason: "bank_details_changed_from_extraction",
                  invalidatedDocumentIds: verifiedBankDocuments.map(({ id }) => id),
                  invalidatedDocumentCount: invalidatedBankDocumentCount,
                },
              }),
              ...(bankKycProjection && {
                clientKyc: bankKycProjection.current,
              }),
              ...(biometricIdentityRevocation && {
                biometricIdentityEvidence: {
                  reason: biometricIdentityRevocation.reason,
                  subjectFingerprint: biometricIdentityRevocation.currentSubjectFingerprint,
                  invalidatedDocumentIds: biometricIdentityRevocation.invalidatedDocumentIds,
                  invalidatedDocumentCount: biometricIdentityRevocation.invalidatedDocumentCount,
                },
              }),
            },
          },
        })

        return { ok: true as const, appliedFields, skipped }
      })

      if (!mutation.ok) {
        return NextResponse.json(
          {
            error: mutation.error,
            // Present only on the identity-revocation refusal, so the UI can
            // name what would be lost instead of restating the message.
            ...("identityRevocation" in mutation
              ? { identityRevocation: mutation.identityRevocation }
              : {}),
          },
          { status: mutation.status },
        )
      }
      return NextResponse.json({
        applied: mutation.appliedFields,
        // Present only when extraction read a value the record already answers,
        // so the UI can say what was kept rather than imply everything landed.
        ...(mutation.skipped.length > 0 ? { skipped: mutation.skipped } : {}),
      })
    })
  } catch (err) {
    console.error("Apply extraction failed:", err)
    return NextResponse.json({ error: "Failed to apply extraction" }, { status: 500 })
  }
}
