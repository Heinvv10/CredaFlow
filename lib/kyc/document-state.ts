import {
  assessBiometricEvidence,
  type BiometricDocumentEvidence,
  type BiometricEvidenceAssessment,
  type BiometricEvidenceFailureReason,
  type BiometricSubjectClient,
} from "@/lib/kyc/biometric-evidence"
import { isSha256Digest } from "@/lib/documents/content-integrity"
import {
  currentManualKycException,
  type ManualKycExceptionEvidence,
  type ManualKycExceptionRecord,
} from "@/lib/kyc/manual-exception"

import {
  BLOCKING_SELFIE_CONDITIONS,
  currentInPersonKycVerification,
  ID_PORTRAIT_REFUSAL_CONDITIONS,
  idDocumentPortraitRefused,
  selfieBlocksInPersonVerification,
  type InPersonRouteState,
  type InPersonKycVerificationEvidence,
  type InPersonKycVerificationRecord,
  type InspectedIdDocument,
} from "@/lib/kyc/in-person-verification"

export const CORE_KYC_DOCUMENT_TYPES = [
  "ID_COPY",
  "PROOF_OF_ADDRESS",
  "PAYSLIP",
  "BANK_STATEMENT",
] as const

export type CoreKycDocumentType = (typeof CORE_KYC_DOCUMENT_TYPES)[number]

export interface DocumentKycInput {
  docType: string
  verified: boolean
  verificationNote: string | null
  /** Set only when a named reviewer refused this document. */
  verificationRejectedById?: string | null
}

/**
 * A core document as the composite reader selects it. Extends the bare input
 * with the identity an in-person attestation binds to. Selection of the ID row
 * MUST stay identical to subject_has_in_person_kyc_verification in
 * prisma/migrations — the database enforces the same rule independently, so a
 * divergence means one layer accepts what the other rejects.
 */
/** A core document row carrying enough to identify the CURRENT one per type. */
export interface CoreDocumentClassificationRow extends DocumentKycInput {
  id: string
  createdAt: Date
}

export interface CoreKycDocumentRow extends CoreDocumentClassificationRow {
  contentSha256: string | null
  verificationRejectedAt: Date | null
}

export type CoreDocumentGapState =
  | "not_uploaded"
  | "awaiting_verification"
  // A note with NO named author: the system re-flagged this document, e.g. a
  // bank-detail change requiring re-verification. Nobody refused it.
  | "flagged"
  // A named reviewer refused it — distinguishable only because the verify
  // endpoint records verificationRejectedById. The note alone cannot say who.
  | "rejected"

export interface CoreDocumentGap {
  docType: CoreKycDocumentType
  state: CoreDocumentGapState
}

export interface ClientKycState {
  kycStatus: "PENDING" | "VERIFIED" | "FAILED" | "EXPIRED"
  kycVerifiedAt: Date | null
  kycVerifiedById: string | null
  kycVerificationMethod: "PHYSICAL" | "DIGITAL" | "BIOMETRIC" | "SMILE_IDENTITY" | null
}

export interface ClientKycExistingState extends ClientKycState {
  kycManualRejectionActive?: boolean
  kycManualRejectionAt?: Date | null
  kycManualRejectionById?: string | null
  kycManualRejectionReason?: string | null
  kycManualRejectionResolvedAt?: Date | null
  kycManualRejectionResolvedById?: string | null
  kycManualRejectionResolutionReason?: string | null
}

export type CompositeKycResult = {
  ok: boolean
  state: ClientKycState
  missingCoreDocuments: CoreKycDocumentType[]
  /**
   * Why each core document is outstanding. "Missing" conflates three states
   * that need three different actions: chase the client for an upload, wait
   * for a reviewer, or tell the client their document was refused. Staff
   * reading "missing" against a document already on file go looking for an
   * upload that is right there.
   */
  coreDocumentGaps: CoreDocumentGap[]
  biometricEvidence: BiometricEvidenceFailureReason | null
  manualRejectionActive: boolean
  /**
   * Documents-grade. Origination only — NEVER payout.
   *
   * Policy: a selfie is not compulsory to review or approve an
   * application, but is required before money moves. So this requires the four
   * core documents and no active manual rejection, and tolerates a biometric
   * that was never captured. It does NOT tolerate one that was captured and
   * failed: that is an adverse result, not a missing step, and the senior
   * exception exists for it. `ok` remains the strict, payout-grade value.
   */
  okForOrigination: boolean
  /**
   * A selfie exists, did not pass, and nothing covers it. Not set when the
   * only refusal is that the match was run against an ID copy that is not the
   * newest verified one (biometricIdDocumentNotCurrent): that awaits a new
   * selfie or staff verifying the copy, like a selfie never taken.
   */
  biometricAttemptFailed: boolean
  /** The latest selfie's only refusal is its ID-copy binding. */
  biometricIdDocumentNotCurrent: boolean
  manualExceptionActive: boolean
  /**
   * Which substitute is carrying the biometric requirement, so readers can say
   * something true. "senior_exception" means a selfie was captured and did not
   * pass; "in_person" means none was ever captured. Rendering one as the other
   * states a compliance fact that did not happen.
   */
  substituteKind: "senior_exception" | "in_person" | null
  manualException: ManualKycExceptionEvidence | null
  /** Set when the exception covering biometrics is an in-person attestation. */
  inPersonVerification: InPersonKycVerificationEvidence | null
}

type CurrentBiometricDocument = BiometricDocumentEvidence & {
  id: string
  contentSha256: string | null
}

export type LatestSelfieOrder = [
  { biometricAttemptSequence: "desc" },
  { createdAt: "desc" },
  { id: "desc" },
]

/** The database-assigned attempt sequence is the authoritative chronology. */
export function latestSelfieOrder(): LatestSelfieOrder {
  return [
    { biometricAttemptSequence: "desc" },
    { createdAt: "desc" },
    { id: "desc" },
  ]
}

export interface CompositeKycReader {
  clientDocument: {
    findMany: ((args: {
      where: {
        tenantId: string
        clientId: string
        deletedAt: null
        docType: { in: CoreKycDocumentType[] }
      }
      select: {
        docType: true
        verified: true
        verificationNote: true
        verificationRejectedById: true
        verificationRejectedAt: true
        id: true
        contentSha256: true
        createdAt: true
      }
    }) => Promise<CoreKycDocumentRow[]>) &
      ((args: {
        where: { tenantId: string; clientId: string } & typeof ID_PORTRAIT_REFUSAL_CONDITIONS
        select: { biometricResult: true }
      }) => Promise<Array<{ biometricResult: unknown }>>) &
      ((args: {
        where: { tenantId: string; clientId: string } & typeof BLOCKING_SELFIE_CONDITIONS
        select: { extractionStatus: true; biometricResult: true; createdAt: true }
      }) => Promise<Array<{ extractionStatus: string | null; biometricResult: unknown; createdAt: Date }>>)
    findFirst: (args: {
      where: { tenantId: string; clientId: string; docType: "SELFIE" }
      orderBy: LatestSelfieOrder
      select: {
        id: true
        contentSha256: true
        deletedAt: true
        verified: true
        extractionStatus: true
        extractionResult: true
        extractionError: true
        validationMismatch: true
        validationScore: true
        biometricMatchScore: true
        biometricLiveness: true
        biometricVerifiedAt: true
        biometricResult: true
      }
    }) => Promise<CurrentBiometricDocument | null>
  }
  complianceRecord?: {
    findFirst: (args: {
      where: {
        tenantId: string
        type: "KYC_EXCEPTION"
        referenceId: string
        status: "COMPLETED"
        completedAt: { not: null }
      }
      orderBy: [{ completedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }]
      select: { id: true; completedAt: true; data: true }
    }) => Promise<ManualKycExceptionRecord | null>
  }
}

function coherentVerifiedProvenance(state: ClientKycState): boolean {
  return state.kycStatus === "VERIFIED" &&
    state.kycVerifiedAt !== null &&
    state.kycVerificationMethod !== null &&
    // Automated providers verify with no staff actor: SMILE_IDENTITY for
    // legacy rows verified by SMILE_IDENTITY, BIOMETRIC for the VLM
    // face match. Every other method needs a named verifier.
    (state.kycVerificationMethod === "SMILE_IDENTITY"
      || state.kycVerificationMethod === "BIOMETRIC"
      || state.kycVerifiedById !== null)
}

/**
 * Derive the only KYC state that may gate review, approval, signing, or payout.
 * The cached Client fields are a projection of this composite evidence, never
 * a substitute for it: all four core documents and the current latest valid
 * biometric attempt are mandatory.
 */
export function deriveCompositeKycState(args: {
  documents: readonly CoreDocumentClassificationRow[]
  biometricDocumentPresent: boolean
  biometricAssessment: BiometricEvidenceAssessment
  existing: ClientKycExistingState
  completion: {
    verifiedAt: Date
    verifiedById: string | null
    method: NonNullable<ClientKycState["kycVerificationMethod"]>
  }
  manualException?: ManualKycExceptionEvidence | null
  inPersonVerification?: InPersonKycVerificationEvidence | null
  preserveVerifiedProvenance?: boolean
}): CompositeKycResult {
  const verifiedTypes = new Set(
    args.documents
      .filter((document) => document.verified)
      .map((document) => document.docType),
  )
  const missingCoreDocuments = CORE_KYC_DOCUMENT_TYPES.filter(
    (docType) => !verifiedTypes.has(docType),
  )
  const coreDocumentGaps: CoreDocumentGap[] = missingCoreDocuments.map((docType) => {
    // The CURRENT document decides, not any historical one. A client who was
    // refused and has since re-uploaded needs their new document reviewed, not
    // to be told to upload again — and the client KYC checklist already reads
    // latest-first (app/api/clients/[id]/documents/route.ts), so anything else
    // makes two staff screens disagree about the same document.
    const current = args.documents
      .filter((document) => document.docType === docType)
      .reduce<CoreDocumentClassificationRow | null>((latest, document) => {
        if (latest === null) return document
        const byCreatedAt = document.createdAt.getTime() - latest.createdAt.getTime()
        if (byCreatedAt !== 0) return byCreatedAt > 0 ? document : latest
        // createdAt is @default(now()), and Postgres freezes now() per
        // transaction — two rows of one docType written in a single
        // transaction tie EXACTLY. Without a tiebreak the winner would be
        // whichever the unordered findMany happened to return first, so the
        // same data could classify differently between requests.
        return document.id > latest.id ? document : latest
      }, null)
    if (current === null) return { docType, state: "not_uploaded" as const }
    if (current.verificationRejectedById) return { docType, state: "rejected" as const }
    return {
      docType,
      state: current.verificationNote?.trim()
        ? ("flagged" as const)
        : ("awaiting_verification" as const),
    }
  })
  const biometricEvidence = args.biometricAssessment.ok
    ? null
    : args.biometricAssessment.reason
  const manualRejectionActive = args.existing.kycManualRejectionActive === true
  // Either substitute for a remote biometric counts: a senior exception over a
  // failed attempt, or an in-person attestation where none was captured. They
  // are mutually exclusive by construction (one needs a selfie, one needs none).
  const substituteEvidence =
    args.manualException ?? args.inPersonVerification ?? null
  const manualExceptionActive =
    substituteEvidence !== null && !manualRejectionActive
  const evidenceValid =
    missingCoreDocuments.length === 0 &&
    (biometricEvidence === null || manualExceptionActive)
  const ok = evidenceValid && !manualRejectionActive
  // An attempt that exists and did not pass, with nothing covering it.
  const biometricIdDocumentNotCurrent =
    !args.biometricAssessment.ok && args.biometricAssessment.idDocumentNotCurrent === true
  const biometricAttemptFailed =
    args.biometricDocumentPresent &&
    biometricEvidence !== null &&
    !manualExceptionActive &&
    !biometricIdDocumentNotCurrent
  const substituteKind: "senior_exception" | "in_person" | null =
    args.manualException ? "senior_exception" : args.inPersonVerification ? "in_person" : null
  const okForOrigination =
    missingCoreDocuments.length === 0 &&
    !manualRejectionActive &&
    !biometricAttemptFailed

  if (manualRejectionActive) {
    return {
      ok,
      state: {
        kycStatus: "FAILED",
        kycVerifiedAt: null,
        kycVerifiedById: null,
        kycVerificationMethod: null,
      },
      missingCoreDocuments,
      coreDocumentGaps,
      biometricEvidence,
      // A manual rejection is authoritative over every stage, origination too.
      okForOrigination: false,
      biometricAttemptFailed,
      biometricIdDocumentNotCurrent,
      manualRejectionActive,
      manualExceptionActive: false,
      substituteKind: null,
      manualException: null,
      inPersonVerification: null,
    }
  }

  if (ok) {
    const state = manualExceptionActive && substituteEvidence
      ? {
          kycStatus: "VERIFIED" as const,
          kycVerifiedAt: new Date(substituteEvidence.approvedAt),
          kycVerifiedById: substituteEvidence.approvedById,
          // A senior exception is a reasoned physical/manual acceptance. It
          // must never be projected as SMILE_IDENTITY or BIOMETRIC success.
          kycVerificationMethod: "PHYSICAL" as const,
        }
      : args.preserveVerifiedProvenance && coherentVerifiedProvenance(args.existing)
      ? {
          kycStatus: args.existing.kycStatus,
          kycVerifiedAt: args.existing.kycVerifiedAt,
          kycVerifiedById: args.existing.kycVerifiedById,
          kycVerificationMethod: args.existing.kycVerificationMethod,
        }
      : {
          kycStatus: "VERIFIED" as const,
          kycVerifiedAt: args.completion.verifiedAt,
          kycVerifiedById: args.completion.verifiedById,
          kycVerificationMethod: args.completion.method,
        }
    return {
      ok,
      state,
      missingCoreDocuments,
      coreDocumentGaps,
      biometricEvidence,
      okForOrigination,
      biometricAttemptFailed,
      biometricIdDocumentNotCurrent,
      manualRejectionActive,
      manualExceptionActive,
      substituteKind: manualExceptionActive ? substituteKind : null,
      manualException: manualExceptionActive ? args.manualException ?? null : null,
      inPersonVerification: manualExceptionActive
        ? args.inPersonVerification ?? null
        : null,
    }
  }

  const currentBiometricFailed = args.biometricDocumentPresent &&
    biometricEvidence !== null &&
    !biometricIdDocumentNotCurrent
  // Was a CURRENT core document refused by a named reviewer? Keyed off the same
  // classification the UI renders, so the rollup and the per-document copy can
  // never tell different stories. A note with no author is excluded: the system
  // writes those when a bank-detail change re-flags a statement, and treating
  // that as failure marked innocent clients FAILED.
  const rejectedByReviewer = coreDocumentGaps.some((gap) => gap.state === "rejected")
  return {
    ok,
    biometricAttemptFailed,
    biometricIdDocumentNotCurrent,
    state: {
      kycStatus: currentBiometricFailed || rejectedByReviewer ? "FAILED" : "PENDING",
      kycVerifiedAt: null,
      kycVerifiedById: null,
      kycVerificationMethod: null,
    },
    missingCoreDocuments,
    coreDocumentGaps,
    biometricEvidence,
    okForOrigination,
    manualRejectionActive,
    manualExceptionActive,
    substituteKind: manualExceptionActive ? substituteKind : null,
    manualException: manualExceptionActive ? args.manualException ?? null : null,
    inPersonVerification: manualExceptionActive
      ? args.inPersonVerification ?? null
      : null,
  }
}

export async function readCompositeKycState(
  reader: CompositeKycReader,
  args: {
    tenantId: string
    clientId: string
    subject: BiometricSubjectClient
    existing: ClientKycExistingState
    completion?: {
      verifiedAt: Date
      verifiedById: string | null
      method: NonNullable<ClientKycState["kycVerificationMethod"]>
    }
    preserveVerifiedProvenance?: boolean
  },
): Promise<CompositeKycResult & { latestSelfieId: string | null; inPersonRoute: InPersonRouteState }> {
  const [documents, latestSelfie, blockingCandidates, exceptionRecord, portraitRefusals] = await Promise.all([
    reader.clientDocument.findMany({
      where: {
        tenantId: args.tenantId,
        clientId: args.clientId,
        deletedAt: null,
        docType: { in: [...CORE_KYC_DOCUMENT_TYPES] },
      },
      select: {
        docType: true,
        verified: true,
        verificationNote: true,
        verificationRejectedById: true,
        verificationRejectedAt: true,
        id: true,
        contentSha256: true,
        createdAt: true,
      },
    }),
    reader.clientDocument.findFirst({
      where: {
        tenantId: args.tenantId,
        clientId: args.clientId,
        docType: "SELFIE",
      },
      orderBy: latestSelfieOrder(),
      select: {
        id: true,
        contentSha256: true,
        deletedAt: true,
        verified: true,
        extractionStatus: true,
        extractionResult: true,
        extractionError: true,
        validationMismatch: true,
        validationScore: true,
        biometricMatchScore: true,
        biometricLiveness: true,
        biometricVerifiedAt: true,
        biometricResult: true,
      },
    }),
    // EVERY blocking candidate — not just the latest — mirrors the SQL
    // predicate's EXISTS exactly; the two enforcement layers must reach the
    // same verdict. selfieBlocksInPersonVerification then releases a passed
    // one whose ID copy was rejected or deleted.
    reader.clientDocument.findMany({
      where: {
        tenantId: args.tenantId,
        clientId: args.clientId,
        ...BLOCKING_SELFIE_CONDITIONS,
      },
      select: { extractionStatus: true, biometricResult: true, createdAt: true },
    }),
    reader.complianceRecord?.findFirst({
      where: {
        tenantId: args.tenantId,
        type: "KYC_EXCEPTION",
        referenceId: args.clientId,
        status: "COMPLETED",
        completedAt: { not: null },
      },
      orderBy: [
        { completedAt: "desc" },
        { createdAt: "desc" },
        { id: "desc" },
      ],
      select: { id: true, completedAt: true, data: true },
    }) ?? Promise.resolve(null),
    // Every attempt that refused an ID portrait, deleted or not: one standing
    // against the attested copy closes the in-person route, whatever came after.
    reader.clientDocument.findMany({
      where: {
        tenantId: args.tenantId,
        clientId: args.clientId,
        ...ID_PORTRAIT_REFUSAL_CONDITIONS,
      },
      select: { biometricResult: true },
    }),
  ])
  // Deterministic, and identical to the SQL predicate's row choice: verified
  // ID_COPY rows only (the query already excludes deleted), newest first with
  // id as the tiebreak. `find` over an unordered result could bind on one
  // request and lapse on the next.
  const idDocument: InspectedIdDocument | null =
    documents
      .filter((document) => document.docType === "ID_COPY" && document.verified)
      .sort((a, b) => {
        const byCreatedAt = b.createdAt.getTime() - a.createdAt.getTime()
        if (byCreatedAt !== 0) return byCreatedAt
        // Code-unit comparison, not localeCompare: the SQL predicate breaks the
        // same tie with ORDER BY "id" DESC under the database collation, and
        // ICU locale rules are not that. Ids are cuids, so the two agree today
        // either way — but these layers are meant to be exactly aligned, and
        // "agree today" is how a divergence gets in.
        if (a.id === b.id) return 0
        return a.id < b.id ? 1 : -1
      })
      .map((document) => ({
        id: document.id,
        contentSha256: document.contentSha256,
        deletedAt: null,
        verified: document.verified,
      }))[0] ?? null
  // The client's non-deleted ID copies (the query's filter), verified or not.
  const idDocumentCopies = documents.filter((document) => document.docType === "ID_COPY")
  // The selfie counts only against that same ID copy (subject_has_composite_kyc).
  const biometricAssessment = latestSelfie
    ? assessBiometricEvidence(latestSelfie, {
        subject: args.subject,
        idDocument,
        idDocumentCopies,
      })
    : { ok: false as const, reason: "biometric_evidence_missing" as const }
  const manualException = currentManualKycException(exceptionRecord, {
    clientId: args.clientId,
    subject: args.subject,
    latestSelfie,
    biometricAssessment,
  })
  // Judged against the attestation on file for the record being read, and
  // against one written now for the route's offer.
  const blocksAttestationOnFile = blockingCandidates.some((selfie) =>
    selfieBlocksInPersonVerification(selfie, idDocumentCopies, exceptionRecord?.completedAt ?? null))
  const now = new Date()
  const blockingBiometricAttempt = blockingCandidates.some((selfie) =>
    selfieBlocksInPersonVerification(selfie, idDocumentCopies, now))
  const inPersonVerification = manualException
    ? null
    : currentInPersonKycVerification(
        exceptionRecord as InPersonKycVerificationRecord | null,
        {
          clientId: args.clientId,
          subject: args.subject,
          idDocument,
          blockingBiometricAttempt: blocksAttestationOnFile,
          biometricAssessment,
          portraitRefusals,
        },
      )
  const result = deriveCompositeKycState({
    documents,
    biometricDocumentPresent: latestSelfie !== null,
    biometricAssessment,
    existing: args.existing,
    manualException,
    inPersonVerification,
    completion: args.completion ?? {
      verifiedAt: latestSelfie?.biometricVerifiedAt ?? new Date(),
      verifiedById: null,
      // The biometric provider is the VLM face match; SMILE_IDENTITY remains
      // in the enum only for legacy rows.
      method: "BIOMETRIC",
    },
    preserveVerifiedProvenance: args.preserveVerifiedProvenance,
  })
  return {
    ...result,
    latestSelfieId: latestSelfie?.id ?? null,
    inPersonRoute: {
      blockingBiometricAttempt,
      // The copy the route would attest against: the newest verified one,
      // with a usable digest, not closed by an ID-portrait refusal.
      idDocumentAdmissible: idDocument !== null &&
        isSha256Digest(idDocument.contentSha256) &&
        !idDocumentPortraitRefused(portraitRefusals, idDocument),
    },
  }
}

export function isCoreKycDocumentType(docType: string): docType is CoreKycDocumentType {
  return (CORE_KYC_DOCUMENT_TYPES as readonly string[]).includes(docType)
}

/**
 * Derive the manual-document KYC roll-up from the current, non-deleted rows.
 * A complete set of verified core documents is physical KYC. Any incomplete
 * set clears the prior verification timestamp and method so those provenance
 * fields can never describe evidence that no longer exists.
 */
export function deriveCoreDocumentKycState(
  documents: readonly DocumentKycInput[],
  verifiedAt: Date = new Date(),
  verifiedById: string | null = null,
): ClientKycState {
  const verifiedTypes = new Set(
    documents.filter((document) => document.verified).map((document) => document.docType),
  )
  const allCoreVerified = CORE_KYC_DOCUMENT_TYPES.every((docType) => verifiedTypes.has(docType))
  if (allCoreVerified) {
    return {
      kycStatus: "VERIFIED",
      kycVerifiedAt: verifiedAt,
      kycVerifiedById: verifiedById,
      kycVerificationMethod: "PHYSICAL",
    }
  }

  // Same rule as the composite roll-up: only a NAMED reviewer's refusal is an
  // adverse finding about the client. A note alone may be the system's.
  const rejectedByReviewer = documents.some(
    (document) => !document.verified && Boolean(document.verificationRejectedById),
  )
  return {
    kycStatus: rejectedByReviewer ? "FAILED" : "PENDING",
    kycVerifiedAt: null,
    kycVerifiedById: null,
    kycVerificationMethod: null,
  }
}

export function clientKycAuditValue(state: ClientKycExistingState) {
  return {
    kycStatus: state.kycStatus,
    kycVerifiedAt: state.kycVerifiedAt?.toISOString() ?? null,
    kycVerifiedById: state.kycVerifiedById,
    kycVerificationMethod: state.kycVerificationMethod,
    ...("kycManualRejectionActive" in state && {
      kycManualRejectionActive: state.kycManualRejectionActive ?? false,
      kycManualRejectionAt: state.kycManualRejectionAt?.toISOString() ?? null,
      kycManualRejectionById: state.kycManualRejectionById ?? null,
      kycManualRejectionReason: state.kycManualRejectionReason ?? null,
      kycManualRejectionResolvedAt:
        state.kycManualRejectionResolvedAt?.toISOString() ?? null,
      kycManualRejectionResolvedById: state.kycManualRejectionResolvedById ?? null,
      kycManualRejectionResolutionReason:
        state.kycManualRejectionResolutionReason ?? null,
    }),
  }
}
