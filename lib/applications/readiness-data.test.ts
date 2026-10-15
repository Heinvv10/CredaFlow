import { describe, expect, it } from "vitest"
import {
  assembleReadiness,
  inMemoryKycReader,
  type ReadinessBureauRow,
  type ReadinessCoreDocumentRow,
  type ReadinessExceptionRow,
  type ReadinessKycRows,
  type ReadinessSelfieRow,
} from "@/lib/applications/readiness-data"
import {
  CORE_KYC_DOCUMENT_TYPES,
  readCompositeKycState,
  type CompositeKycReader,
} from "@/lib/kyc/document-state"
import { disbursementApplicationFixture } from "@/lib/affordability/__fixtures__/approval-evidence"
import { biometricSubjectFingerprint } from "@/lib/kyc/biometric-evidence"
import { PASSING_FACE_MODEL_EVIDENCE } from "@/lib/kyc/face-model/evidence.test-helpers"
import {
  IN_PERSON_KYC_VERIFICATION_KIND,
  IN_PERSON_KYC_VERIFICATION_VERSION,
} from "@/lib/kyc/in-person-verification"

const TENANT_ID = "tenant-1"
const CLIENT_ID = "client-1"
const OTHER_CLIENT_ID = "client-2"
const NOW = new Date("2026-07-20T09:15:00.000Z")

function coreDocument(
  overrides: Partial<ReadinessCoreDocumentRow> & { docType: string },
): ReadinessCoreDocumentRow {
  return {
    clientId: CLIENT_ID,
    verified: true,
    verificationNote: null,
    verificationRejectedById: null,
    id: `doc-${overrides.docType}-${overrides.clientId ?? CLIENT_ID}`,
    contentSha256: "a".repeat(64),
    createdAt: new Date("2026-07-19T08:00:00.000Z"),
    ...overrides,
  } as ReadinessCoreDocumentRow
}

function allCoreDocuments(clientId = CLIENT_ID): ReadinessCoreDocumentRow[] {
  return CORE_KYC_DOCUMENT_TYPES.map((docType) => coreDocument({ docType, clientId }))
}

function selfie(overrides: Partial<ReadinessSelfieRow> = {}): ReadinessSelfieRow {
  return {
    clientId: CLIENT_ID,
    id: "selfie-1",
    // Before ATTESTED_AT: an attestation recorded after the attempt.
    createdAt: new Date("2026-07-19T09:00:00.000Z"),
    contentSha256: "b".repeat(64),
    deletedAt: null,
    verified: true,
    extractionStatus: "completed",
    extractionResult: null,
    extractionError: null,
    validationMismatch: false,
    validationScore: null,
    biometricMatchScore: 0.99,
    biometricLiveness: 0.99,
    biometricVerifiedAt: new Date("2026-07-19T09:00:00.000Z"),
    biometricResult: null,
    ...overrides,
  } as ReadinessSelfieRow
}

const refusalOf = (idDocumentId: string, idDocumentSha256 = "a".repeat(64)) => ({
  biometricFailureReason: "id_document_portrait_invalid",
  idDocumentId,
  idDocumentSha256,
})

const ATTESTED_AT = new Date("2026-07-19T12:00:00.000Z")

/** A selfie that passed against the client's ID copy `idDocumentId`. */
function passedSelfie(idDocumentId: string, overrides: Partial<ReadinessSelfieRow> = {}): ReadinessSelfieRow {
  return selfie({
    id: "selfie-passed",
    extractionStatus: "done",
    extractionResult: {
      faceDetected: { value: true }, facesCount: { value: 1 }, isLive: { value: true }, quality: { value: "good" },
    },
    validationScore: 90,
    biometricMatchScore: 90,
    biometricLiveness: 95,
    biometricResult: {
      ok: true, verified: true, matchScore: 90, livenessScore: 95,
      provider: "vlm-face-match-v3", idPhotoKind: "photograph", idPhotoIsRealPhotograph: true,
      idPhotoFaceDetected: true, selfieIsRealPhotograph: true, samePerson: "same", faceMatch: true,
      matchConfidence: 0.9, livenessConfidence: 0.95, faceModel: PASSING_FACE_MODEL_EVIDENCE,
      idDocumentId, idDocumentSha256: "a".repeat(64),
      subjectFingerprint: biometricSubjectFingerprint(subject),
    },
    ...overrides,
  })
}

/** The client's first ID copy, not yet verified. */
const unverifiedFirstIdCopies = () => [
  coreDocument({ docType: "ID_COPY", verified: false, verificationRejectedAt: null }),
  ...allCoreDocuments().filter((document) => document.docType !== "ID_COPY"),
]

/** An earlier attempt whose face check came back adverse. */
const mismatchedSelfie = (overrides: Partial<ReadinessSelfieRow> = {}) => selfie({
  id: "selfie-mismatch", verified: false, biometricVerifiedAt: null, extractionStatus: "failed",
  biometricResult: { biometricFailureReason: "provider_verification_failed", idDocumentId: "doc-ID-gone" },
  ...overrides,
})

/** A newer ID copy a reviewer refused. */
function rejectedIdCopy(): ReadinessCoreDocumentRow {
  return coreDocument({
    docType: "ID_COPY",
    id: "doc-ID-rejected",
    verified: false,
    verificationRejectedById: "officer-1",
    verificationRejectedAt: new Date("2026-07-19T11:00:00.000Z"),
    createdAt: new Date("2026-07-19T10:30:00.000Z"),
  })
}

/** An in-person attestation over the client's seeded ID copy. */
function inPersonAttestation(): ReadinessExceptionRow {
  return {
    id: "attestation-1",
    referenceId: CLIENT_ID,
    completedAt: ATTESTED_AT,
    data: {
      kind: IN_PERSON_KYC_VERIFICATION_KIND,
      version: IN_PERSON_KYC_VERIFICATION_VERSION,
      clientId: CLIENT_ID,
      idDocumentId: `doc-ID_COPY-${CLIENT_ID}`,
      idDocumentSha256: "a".repeat(64),
      subjectFingerprint: biometricSubjectFingerprint(subject),
      method: "IN_PERSON_BRANCH",
      note: "Synthetic client attended a branch; face matched the ID photo.",
      approvedAt: ATTESTED_AT.toISOString(),
      approvedById: "admin-1",
      approvedByEmail: "admin@example.test",
    },
  } as ReadinessExceptionRow
}

function rows(overrides: Partial<ReadinessKycRows> = {}): ReadinessKycRows {
  return {
    coreDocuments: allCoreDocuments(),
    selfies: [],
    exceptions: [],
    ...overrides,
  }
}

/**
 * The reader the real code hands `readCompositeKycState`: Prisma itself. Rebuilt
 * here over the same in-memory rows, but honouring the `where` clauses rather
 * than the argument shapes, so the two implementations are independent.
 */
function referenceReader(clientId: string, data: ReadinessKycRows): CompositeKycReader {
  const reader = {
    clientDocument: {
      findMany: async (args: {
        where: {
          docType: { in: string[] } | string
          deletedAt?: null
          OR?: Array<{
            extractionStatus?: { in: string[] }
            verificationRejectedAt?: { not: null }
            verificationRejectedById?: { not: null }
            biometricResult?: { path: string[]; equals: unknown }
          }>
        }
      }) => {
        const { docType } = args.where
        if (typeof docType === "string") {
          const mine = data.selfies.filter((row) => row.clientId === clientId)
          const clauses = args.where.OR ?? []
          if (clauses.some((clause) => clause.biometricResult !== undefined)) {
            // The ID-portrait refusal read: any OR'd path equal to its value.
            return mine.filter((row) => {
              const result = row.biometricResult as Record<string, unknown> | null
              return clauses.some((clause) =>
                clause.biometricResult !== undefined
                && result?.[clause.biometricResult.path[0]] === clause.biometricResult.equals)
            })
          }
          if (args.where.deletedAt === undefined) {
            // The prior-failed-attempt read: deleted or not, any OR'd clause.
            return mine.filter((row) => clauses.some((clause) =>
              (clause.extractionStatus !== undefined
                && clause.extractionStatus.in.includes(row.extractionStatus ?? ""))
              || (clause.verificationRejectedAt !== undefined && (row.verificationRejectedAt ?? null) !== null)
              || (clause.verificationRejectedById !== undefined && (row.verificationRejectedById ?? null) !== null)))
          }
          // The blocking-candidate read.
          return mine.filter(
            (row) =>
              row.deletedAt === null
              && (row.extractionStatus === "processing"
                || (row.verified && row.biometricVerifiedAt !== null)),
          )
        }
        return data.coreDocuments.filter(
          (row) => row.clientId === clientId && docType.in.includes(row.docType),
        )
      },
      // Only the latest-selfie read is a findFirst.
      findFirst: async () => data.selfies.filter((row) => row.clientId === clientId)[0] ?? null,
    },
    complianceRecord: {
      findFirst: async () =>
        data.exceptions.find((record) => record.referenceId === clientId) ?? null,
    },
  }
  return reader as unknown as CompositeKycReader
}

const subject = {
  id: CLIENT_ID,
  idNumber: "9001015800086",
  firstName: "Jane",
  lastName: "Doe",
  dateOfBirth: new Date("1990-01-01T00:00:00.000Z"),
}

const existing = {
  kycStatus: "PENDING" as const,
  kycVerifiedAt: null,
  kycVerifiedById: null,
  kycVerificationMethod: null,
}

function readWith(reader: CompositeKycReader) {
  return readCompositeKycState(reader, {
    tenantId: TENANT_ID,
    clientId: CLIENT_ID,
    subject,
    existing,
    preserveVerifiedProvenance: true,
  })
}

describe("inMemoryKycReader", () => {
  // The reader hand-mirrors predicates the real reader sends to Postgres. Each
  // case below is one way that mirror can be wrong while still returning
  // something plausible — which is how it would go unnoticed.
  const cases: { name: string; data: ReadinessKycRows }[] = [
    { name: "every core document verified, no selfie", data: rows() },
    {
      name: "a core document belonging to a DIFFERENT client",
      // The whole point of the batch: one client's documents must never
      // satisfy another's gate.
      data: rows({
        coreDocuments: [
          ...allCoreDocuments().slice(0, 3),
          coreDocument({ docType: "PAYSLIP", clientId: OTHER_CLIENT_ID }),
        ],
      }),
    },
    {
      name: "a passing selfie",
      data: rows({ selfies: [selfie()] }),
    },
    {
      name: "a soft-deleted selfie, which does not block the in-person route",
      data: rows({ selfies: [selfie({ deletedAt: new Date("2026-07-19T10:00:00.000Z") })] }),
    },
    {
      name: "a selfie still processing, which does block it",
      data: rows({
        selfies: [selfie({ extractionStatus: "processing", biometricVerifiedAt: null })],
      }),
    },
    {
      name: "an unverified selfie with a biometric timestamp",
      data: rows({ selfies: [selfie({ verified: false })] }),
    },
    {
      name: "a verified selfie with no biometric timestamp",
      data: rows({ selfies: [selfie({ biometricVerifiedAt: null })] }),
    },
    {
      name: "an in-person attestation over an ID copy an OLDER attempt refused",
      // The latest attempt failed for another reason; the older refusal of
      // this copy's portrait must still close the route.
      data: rows({
        selfies: [
          selfie({ id: "selfie-latest", verified: false, biometricVerifiedAt: null, extractionStatus: "failed",
            biometricResult: { biometricFailureReason: "face_not_detected" } }),
          selfie({ id: "selfie-older", verified: false, biometricVerifiedAt: null, extractionStatus: "failed",
            deletedAt: new Date("2026-07-19T10:00:00.000Z"),
            biometricResult: refusalOf(`doc-ID_COPY-${CLIENT_ID}`) }),
          selfie({ id: "selfie-other-client", clientId: OTHER_CLIENT_ID, verified: false,
            biometricVerifiedAt: null, extractionStatus: "failed", biometricResult: refusalOf("doc-x") }),
        ],
        exceptions: [inPersonAttestation()],
      }),
    },
    {
      name: "an in-person attestation whose only refusal was of another ID copy",
      data: rows({
        selfies: [
          selfie({ verified: false, biometricVerifiedAt: null, extractionStatus: "failed",
            biometricResult: refusalOf("doc-an-older-id-copy", "c".repeat(64)) }),
        ],
        exceptions: [inPersonAttestation()],
      }),
    },
    {
      name: "an in-person attestation behind a passed selfie bound to a copy staff rejected",
      // The passed selfie no longer blocks: its ID copy was rejected.
      data: rows({
        coreDocuments: [...allCoreDocuments(), rejectedIdCopy()],
        selfies: [selfie({ biometricResult: { idDocumentId: "doc-ID-rejected" } })],
        exceptions: [inPersonAttestation()],
      }),
    },
    {
      name: "an in-person attestation recorded BEFORE a passed selfie bound to a copy staff rejected",
      // Releasing the selfie must not revive an attestation from before it.
      data: rows({
        coreDocuments: [...allCoreDocuments(), rejectedIdCopy()],
        selfies: [selfie({
          createdAt: new Date("2026-07-19T13:00:00.000Z"),
          biometricResult: { idDocumentId: "doc-ID-rejected" },
        })],
        exceptions: [inPersonAttestation()],
      }),
    },
    {
      name: "an in-person attestation behind a passed selfie bound to a copy awaiting review",
      data: rows({
        coreDocuments: [...allCoreDocuments(), coreDocument({ docType: "ID_COPY", id: "doc-ID-awaiting", verified: false })],
        selfies: [selfie({ biometricResult: { idDocumentId: "doc-ID-awaiting" } })],
        exceptions: [inPersonAttestation()],
      }),
    },
    {
      name: "a passed selfie against the client's first, unverified ID copy",
      data: rows({
        coreDocuments: unverifiedFirstIdCopies(),
        selfies: [passedSelfie(`doc-ID_COPY-${CLIENT_ID}`)],
      }),
    },
    {
      name: "the same, after a deleted earlier attempt with an adverse face result",
      data: rows({
        coreDocuments: unverifiedFirstIdCopies(),
        selfies: [
          passedSelfie(`doc-ID_COPY-${CLIENT_ID}`),
          mismatchedSelfie({ deletedAt: new Date("2026-07-19T08:30:00.000Z") }),
        ],
      }),
    },
    {
      name: "the same, where only ANOTHER client had an adverse face result",
      data: rows({
        coreDocuments: unverifiedFirstIdCopies(),
        selfies: [passedSelfie(`doc-ID_COPY-${CLIENT_ID}`), mismatchedSelfie({ clientId: OTHER_CLIENT_ID })],
      }),
    },
    {
      name: "the same, after an earlier attempt that failed with no recorded reason",
      data: rows({
        coreDocuments: unverifiedFirstIdCopies(),
        selfies: [passedSelfie(`doc-ID_COPY-${CLIENT_ID}`), mismatchedSelfie({ biometricResult: null })],
      }),
    },
    {
      name: "the same, after an earlier attempt staff rejected",
      data: rows({
        coreDocuments: unverifiedFirstIdCopies(),
        selfies: [
          passedSelfie(`doc-ID_COPY-${CLIENT_ID}`),
          selfie({ id: "selfie-rejected", verified: false, verificationRejectedAt: new Date("2026-07-19T08:40:00.000Z"),
            verificationRejectedById: "officer-1" }),
        ],
      }),
    },
    {
      name: "the same, after an earlier attempt where no face was found",
      data: rows({
        coreDocuments: unverifiedFirstIdCopies(),
        selfies: [
          passedSelfie(`doc-ID_COPY-${CLIENT_ID}`),
          mismatchedSelfie({ biometricResult: { biometricFailureReason: "face_not_detected" } }),
        ],
      }),
    },
    {
      name: "the same, while an earlier attempt is still processing",
      data: rows({
        coreDocuments: unverifiedFirstIdCopies(),
        selfies: [
          passedSelfie(`doc-ID_COPY-${CLIENT_ID}`),
          selfie({ id: "selfie-in-flight", verified: false, biometricVerifiedAt: null, extractionStatus: "processing" }),
        ],
      }),
    },
    {
      name: "the same, after an earlier attempt deleted while pending",
      data: rows({
        coreDocuments: unverifiedFirstIdCopies(),
        selfies: [
          passedSelfie(`doc-ID_COPY-${CLIENT_ID}`),
          selfie({ id: "selfie-deleted-in-flight", verified: false, biometricVerifiedAt: null, extractionStatus: "pending",
            deletedAt: new Date("2026-07-19T08:45:00.000Z") }),
        ],
      }),
    },
    {
      name: "the same, after an earlier check that did not finish",
      data: rows({
        coreDocuments: unverifiedFirstIdCopies(),
        selfies: [
          passedSelfie(`doc-ID_COPY-${CLIENT_ID}`),
          mismatchedSelfie({ biometricResult: { biometricFailureReason: "extraction_incomplete" } }),
        ],
      }),
    },
    {
      name: "the same, after an unfinished check whose VLM said different",
      data: rows({
        coreDocuments: unverifiedFirstIdCopies(),
        selfies: [
          passedSelfie(`doc-ID_COPY-${CLIENT_ID}`),
          mismatchedSelfie({ biometricResult: {
            biometricFailureReason: "extraction_incomplete",
            faceVerdict: { samePerson: "different", faceMatch: false, faceModelSamePerson: null },
          } }),
        ],
      }),
    },
    {
      name: "a rejected core document",
      data: rows({
        coreDocuments: [
          ...allCoreDocuments().slice(0, 3),
          coreDocument({
            docType: "PAYSLIP",
            verified: false,
            verificationRejectedById: "officer-1",
          }),
        ],
      }),
    },
    {
      name: "a flagged core document",
      data: rows({
        coreDocuments: [
          ...allCoreDocuments().slice(0, 3),
          coreDocument({
            docType: "PAYSLIP",
            verified: false,
            verificationNote: "Name does not match",
          }),
        ],
      }),
    },
  ]

  it.each(cases)(
    "reaches the same composite verdict as a where-honouring reader: $name",
    async ({ data }) => {
      const mine = await readWith(inMemoryKycReader(CLIENT_ID, data))
      const reference = await readWith(referenceReader(CLIENT_ID, data))
      expect({
        ok: mine.ok,
        okForOrigination: mine.okForOrigination,
        missingCoreDocuments: mine.missingCoreDocuments,
        coreDocumentGaps: mine.coreDocumentGaps,
        biometricEvidence: mine.biometricEvidence,
        biometricAttemptFailed: mine.biometricAttemptFailed,
        biometricAwaitingIdVerification: mine.biometricAwaitingIdVerification,
      }).toEqual({
        ok: reference.ok,
        okForOrigination: reference.okForOrigination,
        missingCoreDocuments: reference.missingCoreDocuments,
        coreDocumentGaps: reference.coreDocumentGaps,
        biometricEvidence: reference.biometricEvidence,
        biometricAttemptFailed: reference.biometricAttemptFailed,
        biometricAwaitingIdVerification: reference.biometricAwaitingIdVerification,
      })
    },
  )

  it.each([
    ["a passed selfie against the client's first, unverified ID copy", true],
    ["the same, after a deleted earlier attempt with an adverse face result", false],
    ["the same, where only ANOTHER client had an adverse face result", true],
    ["the same, after an earlier attempt that failed with no recorded reason", false],
    ["the same, after an earlier attempt staff rejected", false],
    ["the same, after an earlier attempt where no face was found", false],
    ["the same, after an earlier check that did not finish", true],
    ["the same, while an earlier attempt is still processing", false],
    ["the same, after an earlier attempt deleted while pending", false],
    ["the same, after an unfinished check whose VLM said different", false],
  ])("awaits ID verification on the board for %s: %s", async (name, awaiting) => {
    const { data } = cases.find((c) => c.name === name)!
    expect((await readWith(inMemoryKycReader(CLIENT_ID, data))).biometricAwaitingIdVerification).toBe(awaiting)
  })

  it.each([
    ["a passed selfie's copy was rejected", "an in-person attestation behind a passed selfie bound to a copy staff rejected", true],
    ["a passed selfie's copy awaits review", "an in-person attestation behind a passed selfie bound to a copy awaiting review", false],
    ["the attestation predates a released selfie", "an in-person attestation recorded BEFORE a passed selfie bound to a copy staff rejected", false],
    ["an OLDER attempt refused", "an in-person attestation over an ID copy an OLDER attempt refused", false],
    ["the only refusal was of another copy", "an in-person attestation whose only refusal was of another ID copy", true],
  ])("closes the in-person route on the board when %s", async (_label, name, ok) => {
    const { data } = cases.find((c) => c.name === name)!
    expect((await readWith(inMemoryKycReader(CLIENT_ID, data))).ok).toBe(ok)
  })

  it("serves the LATEST selfie, trusting the caller's ordering", async () => {
    // The rows arrive pre-sorted by `latestSelfieOrder()`. First-match-wins is
    // what makes that ordering load-bearing, so a reader that picked any other
    // row would silently judge an old attempt.
    const latest = selfie({ id: "selfie-latest" })
    const older = selfie({ id: "selfie-older", verified: false })
    const reader = inMemoryKycReader(CLIENT_ID, rows({ selfies: [latest, older] }))
    const result = await readWith(reader)
    expect(result.latestSelfieId).toBe("selfie-latest")
  })

  it("ignores selfies belonging to another client", async () => {
    const reader = inMemoryKycReader(
      CLIENT_ID,
      rows({ selfies: [selfie({ clientId: OTHER_CLIENT_ID, id: "selfie-theirs" })] }),
    )
    const result = await readWith(reader)
    expect(result.latestSelfieId).toBeNull()
  })

  it("ignores a KYC exception recorded against another client", async () => {
    const exception: ReadinessExceptionRow = {
      id: "exception-1",
      referenceId: OTHER_CLIENT_ID,
      completedAt: new Date("2026-07-19T11:00:00.000Z"),
      data: {},
    } as ReadinessExceptionRow
    const data = rows({
      coreDocuments: allCoreDocuments().slice(0, 3),
      exceptions: [exception],
    })
    const result = await readWith(inMemoryKycReader(CLIENT_ID, data))
    expect(result.manualExceptionActive).toBe(false)
  })
})

describe("assembleReadiness", () => {
  const application = {
    ...disbursementApplicationFixture(),
    status: "APPROVED",
    bankName: null,
  }

  function loaded(overrides: Record<string, unknown> = {}) {
    return {
      ...application,
      client: {
        ...application.client,
        bankName: "Capitec",
        bankBranchCode: "470010",
        bankAccountNumber: "1234567890",
        accountType: "SAVINGS",
      },
      agreementSignedAt: null,
      agreementDocumentId: null,
      agreementDocumentSha256: null,
      agreementCountersignedAt: null,
      agreementCountersignedById: null,
      agreementCountersignedByName: null,
      agreementCountersignedByEmail: null,
      agreementCountersignatureData: null,
      agreementCountersignatureSha256: null,
      agreementCountersignatureEnvelopeSha256: null,
      agreementCountersignedDocumentSha256: null,
      agreementSignatureData: null,
      agreementSignedMethod: null,
      agreementSignedByUserId: null,
      debitMandatePreparedAt: null,
      debitMandateReference: null,
      debitMandateDraftSha256: null,
      debitMandateEvidence: null,
      debitMandateEvidenceSha256: null,
      debitMandateSignedAt: null,
      debitMandateSignedMethod: null,
      debitMandateSignatureData: null,
      debitMandateSignatureSha256: null,
      debitMandateDocumentId: null,
      debitMandateDocumentSha256: null,
      ...overrides,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
  }

  const bureauRow = {
    id: "bureau-1",
    clientId: CLIENT_ID,
    applicationId: "application-1",
    reviewGeneration: "review-generation-1",
    provider: "experian",
    createdAt: new Date("2026-07-20T09:00:00.000Z"),
    subjectFingerprint: null,
    riskGrade: "LOW",
    obligations: { totalMonthly: 25_000 },
    score: 612,
    unscoreable: false,
    hasAdverse: false,
    deceased: false,
    underDebtReview: false,
    hasJudgement: false,
    hasNotice: false,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as ReadinessBureauRow

  const base = {
    tenantId: TENANT_ID,
    kycRows: rows(),
    bureauChecks: [bureauRow],
    tenantConfig: { bureauMinScore: 600, bureauBlockAdverse: false, ndiBufferPct: 110 },
    mismatches: [] as { clientId: string; _count: { _all: number } }[],
    now: NOW,
  }

  it("keys the result by application id and skips statuses with no chip", async () => {
    const result = await assembleReadiness({
      ...base,
      applications: [
        loaded({ id: "application-1" }),
        loaded({ id: "application-2", status: "DRAFT" }),
        loaded({ id: "application-3", status: "DISBURSED" }),
      ],
    })
    expect([...result.keys()]).toEqual(["application-1"])
  })

  it("joins each client's mismatch count to that client's applications only", async () => {
    const result = await assembleReadiness({
      ...base,
      applications: [
        loaded({ id: "application-1", status: "SUBMITTED" }),
        loaded({
          id: "application-2",
          status: "SUBMITTED",
          clientId: OTHER_CLIENT_ID,
          client: { ...loaded().client, id: OTHER_CLIENT_ID },
        }),
      ],
      kycRows: rows({
        coreDocuments: [...allCoreDocuments(), ...allCoreDocuments(OTHER_CLIENT_ID)],
      }),
      mismatches: [{ clientId: CLIENT_ID, _count: { _all: 2 } }],
    })
    expect(result.get("application-1")?.blockers).toContain("2 document mismatches")
    expect(result.get("application-2")?.blockers ?? []).not.toContain(
      "2 document mismatches",
    )
  })

  it("counts zero mismatches for a client with no groupBy row", async () => {
    const result = await assembleReadiness({
      ...base,
      applications: [loaded({ id: "application-1", status: "SUBMITTED" })],
      mismatches: [{ clientId: OTHER_CLIENT_ID, _count: { _all: 5 } }],
    })
    expect(result.get("application-1")).toEqual({ stage: "READY", blockers: [] })
  })

  it("binds a bureau check to the application AND the review generation", async () => {
    const wrongGeneration = await assembleReadiness({
      ...base,
      applications: [loaded({ id: "application-1", status: "UNDER_REVIEW" })],
      bureauChecks: [{ ...bureauRow, reviewGeneration: "review-generation-0" }],
    })
    expect(wrongGeneration.get("application-1")?.blockers).toContain(
      "Bureau check required",
    )

    const wrongApplication = await assembleReadiness({
      ...base,
      applications: [loaded({ id: "application-1", status: "UNDER_REVIEW" })],
      bureauChecks: [{ ...bureauRow, applicationId: "application-9" }],
    })
    expect(wrongApplication.get("application-1")?.blockers).toContain(
      "Bureau check required",
    )
  })

  it("treats a null review generation as no current bureau check", async () => {
    const result = await assembleReadiness({
      ...base,
      applications: [
        loaded({
          id: "application-1",
          status: "UNDER_REVIEW",
          bureauReviewGeneration: null,
        }),
      ],
    })
    expect(result.get("application-1")?.blockers).toContain("Bureau check required")
  })

  it("falls back to the route's own thresholds when a tenant has no config row", async () => {
    // 450 is below the Sigma floor of 480, so the gate demands calibration —
    // the same answer /decide gives an unconfigured tenant. A different
    // fallback here would have the board disagree with the route.
    const result = await assembleReadiness({
      ...base,
      applications: [loaded({ id: "application-1", status: "UNDER_REVIEW" })],
      tenantConfig: null,
    })
    expect(result.get("application-1")?.blockers).toContain("Bureau risk gate")
  })
})
