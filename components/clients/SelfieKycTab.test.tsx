import { renderToStaticMarkup } from "react-dom/server"
import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SelfieKycTab } from "@/components/clients/SelfieKycTab"
import { BIOMETRIC_FAILURE_COPY } from "@/lib/kyc/biometric-failure-copy"

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }))

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}))

const actEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean
}

const baseSelfie = {
  id: "selfie-latest",
  fileName: "selfie.jpg",
  mimeType: "image/jpeg",
  deletedAt: null,
  biometricMatchScore: 92,
  biometricLiveness: 95,
  biometricVerifiedAt: "2026-07-23T07:00:00.000Z",
  extractionStatus: "completed",
  verifiedAt: "2026-07-23T07:00:00.000Z",
  verificationNote: null,
  createdAt: "2026-07-23T06:59:00.000Z",
}

/** A real face match the VLM ran and could not confirm — a senior can review it. */
const reviewableFailure = {
  ...baseSelfie,
  verifiedAt: null,
  extractionStatus: "failed",
  biometricVerifiedAt: null,
}

/**
 * What an inherited data repair left behind for a stub attempt that predates the gate: `verified`
 * cleared, but `biometricVerifiedAt` and `extractionStatus: "done"` untouched.
 * The gate refuses it; the tab used to render no fallback at all for it.
 */
const quarantinedStubAttempt = {
  ...baseSelfie,
  verifiedAt: null,
  extractionStatus: "done",
  verificationNote:
    "Legacy biometric evidence was quarantined; capture and verify a new selfie.",
}

function renderSelfie(deletedAt: string | null) {
  return renderToStaticMarkup(
    <SelfieKycTab
      clientId="client-1"
      currentKycStatus={deletedAt ? "FAILED" : "VERIFIED"}
      currentManualRejectionActive={false}
      currentManualRejectionReason={null}
      selfieDoc={{ ...baseSelfie, deletedAt }}
      imageUrl="/api/documents/selfie-latest/view"
      biometricEvidence={deletedAt ? "document_deleted" : null}
      biometricAttemptFailed={Boolean(deletedAt)}
      biometricAwaitingIdVerification={false}
      inPersonRoute={IN_PERSON_ROUTE_OPEN}
      seniorExceptionAvailable={false}
    />,
  )
}


// The route's evidence preconditions hold (no governing selfie, an admissible
// ID copy); each test sets the rest through the tab's own props.
const IN_PERSON_ROUTE_OPEN = { blockingBiometricAttempt: false, idDocumentAdmissible: true }

describe("SelfieKycTab authoritative attempt display", () => {
  beforeEach(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    refresh.mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    delete actEnvironment.IS_REACT_ACT_ENVIRONMENT
  })

  it("renders a deleted latest attempt as a tombstone, never as older accepted evidence", () => {
    const html = renderSelfie("2026-07-23T08:00:00.000Z")

    expect(html).toContain("authoritative latest selfie attempt was deleted")
    expect(html).toContain("Older attempts are not current KYC evidence")
    expect(html).not.toContain('alt="Client selfie"')
    expect(html).not.toContain("Biometrically verified")
  })

  it("renders current non-deleted evidence normally", () => {
    const html = renderSelfie(null)

    expect(html).toContain('alt="Client selfie"')
    expect(html).toContain("Biometrically verified")
    expect(html).not.toContain("authoritative latest selfie attempt was deleted")
  })

  it("offers the dedicated exception action only to a senior reviewer", () => {
    const html = renderToStaticMarkup(
      <SelfieKycTab
        clientId="client-1"
        currentKycStatus="FAILED"
        currentManualRejectionActive={false}
        currentManualRejectionReason={null}
        selfieDoc={reviewableFailure}
        imageUrl="/api/documents/selfie-latest/view"
        canGrantManualException
        biometricEvidence="face_not_detected"
        biometricAttemptFailed
        biometricAwaitingIdVerification={false}
        inPersonRoute={IN_PERSON_ROUTE_OPEN}
        seniorExceptionAvailable
      />,
    )

    expect(html).toContain("ADMIN-only senior exception")
    expect(html).toContain("Grant senior KYC exception")
    expect(html).toContain("ordinary Approve KYC action cannot bypass")
  })

  it("offers the human fallback for a quarantined attempt the gate refuses", () => {
    // The dead end: a stub attempt that predates the gate keeps extractionStatus
    // "done", so the tab's old `extractionStatus === "failed"` test rendered
    // NEITHER fallback — while the API would have accepted an in-person
    // verification all along. Staff saw no admin options at all.
    const html = renderToStaticMarkup(
      <SelfieKycTab
        clientId="client-1"
        currentKycStatus="FAILED"
        currentManualRejectionActive={false}
        currentManualRejectionReason={null}
        selfieDoc={quarantinedStubAttempt}
        imageUrl="/api/documents/selfie-latest/view"
        canGrantManualException
        // The route also needs every core document verified.
        coreDocumentsComplete
        biometricEvidence="simulated_provider_evidence"
        biometricAttemptFailed
        biometricAwaitingIdVerification={false}
        inPersonRoute={IN_PERSON_ROUTE_OPEN}
        seniorExceptionAvailable={false}
      />,
    )

    // The reachable route is offered.
    expect(html).toContain("ADMIN-only in-person verification")
    // The unreachable one is not: the route refuses this reason.
    expect(html).not.toContain("ADMIN-only senior exception")
    expect(html).not.toContain("Grant senior KYC exception")
    expect(html).toContain("A senior exception applies only where the check ran")
    expect(html).toContain("Test result, not a real check")
  })

  it.each([
    ["a selfie still governs", { blockingBiometricAttempt: true, idDocumentAdmissible: true }],
    ["the ID copy cannot be attested against", { blockingBiometricAttempt: false, idDocumentAdmissible: false }],
  ])("does not offer the in-person form the route would refuse: %s", (_label, inPersonRoute) => {
    const html = renderToStaticMarkup(
      <SelfieKycTab
        clientId="client-1"
        currentKycStatus="FAILED"
        currentManualRejectionActive={false}
        currentManualRejectionReason={null}
        selfieDoc={reviewableFailure}
        imageUrl="/api/documents/selfie-latest/view"
        canGrantManualException
        coreDocumentsComplete
        biometricEvidence="subject_identity_changed"
        biometricAttemptFailed
        biometricAwaitingIdVerification={false}
        inPersonRoute={inPersonRoute}
        seniorExceptionAvailable={false}
      />,
    )

    expect(html).not.toContain("ADMIN-only in-person verification")
  })

  it("does not claim a face match never ran, for reasons where one did", () => {
    // `subject_identity_changed` and `superseded_biometric_evidence` are both
    // reachable in normal operation — a correction to the client's name/ID/DOB
    // after a PASSING attempt, or a newer selfie superseding an older one. A
    // face match ran in both. Copy asserting otherwise would state a
    // compliance fact that did not happen, on the screen staff act from.
    for (const reason of ["subject_identity_changed", "superseded_biometric_evidence"]) {
      const html = renderToStaticMarkup(
        <SelfieKycTab
          clientId="client-1"
          currentKycStatus="FAILED"
          currentManualRejectionActive={false}
          currentManualRejectionReason={null}
          selfieDoc={reviewableFailure}
          imageUrl="/api/documents/selfie-latest/view"
          canGrantManualException
          // The route also needs every core document verified.
          coreDocumentsComplete
          biometricEvidence={reason}
          biometricAttemptFailed
          biometricAwaitingIdVerification={false}
          inPersonRoute={IN_PERSON_ROUTE_OPEN}
          seniorExceptionAvailable={false}
        />,
      )

      expect(html).not.toContain("No face match was performed")
      // The reachable remedy is still offered for these.
      expect(html).toContain("ADMIN-only in-person verification")
      expect(html).not.toContain("Grant senior KYC exception")
    }
  })

  it("never shows a green biometric tick over evidence the gate refuses", () => {
    // biometricVerifiedAt survives the data-repair quarantine, so the tab keeps
    // rendering "Biometrically verified" for an attempt that cannot pass.
    const refused = renderToStaticMarkup(
      <SelfieKycTab
        clientId="client-1"
        currentKycStatus="FAILED"
        currentManualRejectionActive={false}
        currentManualRejectionReason={null}
        selfieDoc={quarantinedStubAttempt}
        imageUrl="/api/documents/selfie-latest/view"
        biometricEvidence="simulated_provider_evidence"
        biometricAttemptFailed
        biometricAwaitingIdVerification={false}
        inPersonRoute={IN_PERSON_ROUTE_OPEN}
        seniorExceptionAvailable={false}
      />,
    )
    expect(refused).not.toContain("Biometrically verified")

    // Valid evidence still shows it.
    const accepted = renderToStaticMarkup(
      <SelfieKycTab
        clientId="client-1"
        currentKycStatus="VERIFIED"
        currentManualRejectionActive={false}
        currentManualRejectionReason={null}
        selfieDoc={baseSelfie}
        imageUrl="/api/documents/selfie-latest/view"
        biometricEvidence={null}
        biometricAttemptFailed={false}
        biometricAwaitingIdVerification={false}
        inPersonRoute={IN_PERSON_ROUTE_OPEN}
        seniorExceptionAvailable={false}
      />,
    )
    expect(accepted).toContain("Biometrically verified")
  })

  it("names the biometric blocker the route returned instead of only the rule", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false,
      json: async () => ({
        error: "Cannot approve KYC: all four core documents are required, plus one of …",
        biometricEvidence: "simulated_provider_evidence",
      }),
    })))

    let renderer!: ReactTestRenderer
    await act(async () => {
      renderer = create(
        <SelfieKycTab
          clientId="client-1"
          currentKycStatus="FAILED"
          currentManualRejectionActive={false}
          currentManualRejectionReason={null}
          selfieDoc={reviewableFailure}
          imageUrl="/api/documents/selfie-latest/view"
          biometricEvidence="face_not_detected"
          biometricAttemptFailed
          biometricAwaitingIdVerification={false}
          inPersonRoute={IN_PERSON_ROUTE_OPEN}
          seniorExceptionAvailable
        />,
      )
    })

    const approve = renderer.root.findAllByType("button").find((button) => (
      Array.isArray(button.props.children) &&
      button.props.children.includes("Approve KYC")
    ))
    expect(approve).toBeDefined()
    await act(async () => {
      await approve!.props.onClick()
    })

    expect(JSON.stringify(renderer.toJSON()))
      .toContain("Test result, not a real check")
    await act(async () => renderer.unmount())
  })

  it("labels an accepted exception distinctly from biometric success", () => {
    const html = renderToStaticMarkup(
      <SelfieKycTab
        clientId="client-1"
        currentKycStatus="VERIFIED"
        currentManualRejectionActive={false}
        currentManualRejectionReason={null}
        selfieDoc={reviewableFailure}
        imageUrl="/api/documents/selfie-latest/view"
        currentManualException={{
          reason: "Senior reviewed the physical identity evidence.",
          supportingEvidence: "ID copy and physical comparison were completed.",
          biometricFailureReason: "face_not_detected",
          approvedAt: "2026-07-23T09:00:00.000Z",
          approvedByEmail: "admin@example.test",
        }}
        canGrantManualException
        biometricEvidence="face_not_detected"
        biometricAttemptFailed={false}
        biometricAwaitingIdVerification={false}
        inPersonRoute={IN_PERSON_ROUTE_OPEN}
        seniorExceptionAvailable={false}
      />,
    )

    expect(html).toContain("MANUAL EXCEPTION")
    expect(html).toContain("not a biometric pass")
    expect(html).toContain("face not detected")
    expect(html).not.toContain("ADMIN-only senior exception")
  })

  it("refreshes the surrounding server-rendered KYC summaries after granting an exception", async () => {
    const manualException = {
      reason: "Senior reviewed the physical identity evidence.",
      supportingEvidence: "ID copy and physical comparison were completed.",
      biometricFailureReason: "face_not_detected",
      approvedAt: "2026-07-23T09:00:00.000Z",
      approvedByEmail: "admin@example.test",
    }
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({
        kycStatus: "VERIFIED",
        manualException,
      }),
    })))

    let renderer!: ReactTestRenderer
    await act(async () => {
      renderer = create(
        <SelfieKycTab
          clientId="client-1"
          currentKycStatus="FAILED"
          currentManualRejectionActive={false}
          currentManualRejectionReason={null}
          selfieDoc={reviewableFailure}
          imageUrl="/api/documents/selfie-latest/view"
          canGrantManualException
          biometricEvidence="face_not_detected"
          biometricAttemptFailed
          biometricAwaitingIdVerification={false}
          inPersonRoute={IN_PERSON_ROUTE_OPEN}
          seniorExceptionAvailable
        />,
      )
    })

    const textareas = renderer.root.findAllByType("textarea")
    await act(async () => {
      textareas[0].props.onChange({
        target: { value: "Senior reviewed the physical identity evidence." },
      })
      textareas[1].props.onChange({
        target: { value: "ID copy and physical comparison were completed." },
      })
    })
    const grantButton = renderer.root.findAllByType("button").find((button) => (
      Array.isArray(button.props.children) &&
      button.props.children.includes("Grant senior KYC exception")
    ))
    expect(grantButton).toBeDefined()

    await act(async () => {
      await grantButton!.props.onClick()
    })

    expect(refresh).toHaveBeenCalledOnce()
    expect(JSON.stringify(renderer.toJSON())).toContain("MANUAL EXCEPTION")
    await act(async () => renderer.unmount())
  })
})

describe("SelfieKycTab: a selfie matched against an ID copy awaiting verification", () => {
  const html = renderToStaticMarkup(
    <SelfieKycTab
      clientId="client-1"
      currentKycStatus="PENDING"
      currentManualRejectionActive={false}
      currentManualRejectionReason={null}
      selfieDoc={{ ...baseSelfie, extractionStatus: "done", biometricMatchScore: 90 }}
      imageUrl="/api/documents/selfie-latest/view"
      canGrantManualException
      coreDocumentsComplete
      biometricEvidence="subject_identity_changed"
      biometricAttemptFailed={false}
      biometricAwaitingIdVerification
      // The passed selfie names a current copy, so the route refuses (409).
      inPersonRoute={{ blockingBiometricAttempt: true, idDocumentAdmissible: true }}
      seniorExceptionAvailable={false}
    />,
  ).replaceAll("&#x27;", "'")

  it("tells staff to verify the ID copy, not that the record changed", () => {
    expect(html).toContain("ID copy awaiting verification")
    expect(html).toContain(
      "Selfie matched the client's newest ID copy, which is awaiting verification. Verify the ID copy to complete the identity check.",
    )
    expect(html).toContain(">PENDING<")
    expect(html).not.toContain(BIOMETRIC_FAILURE_COPY.subject_identity_changed.label)
    expect(html).not.toContain("FAILED")
  })

  it("offers no failure remedies: no exception, no in-person form, no tick", () => {
    expect(html).not.toContain("Grant senior KYC exception")
    expect(html).not.toContain("ADMIN-only in-person verification")
    expect(html).not.toContain("Re-capture the selfie")
    expect(html).not.toContain("Biometrically verified")
  })
})

describe("SelfieKycTab failure wording", () => {
  // renderToStaticMarkup escapes apostrophes to &#x27;, so compare decoded.
  const decode = (html: string) => html
    .replaceAll("&#x27;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")

  const render = (reason: string) => renderToStaticMarkup(
    <SelfieKycTab
      clientId="client-1"
      currentKycStatus="FAILED"
      currentManualRejectionActive={false}
      currentManualRejectionReason={null}
      selfieDoc={{ ...baseSelfie, verifiedAt: null, biometricVerifiedAt: null }}
      imageUrl="/api/documents/selfie-latest/view"
      canGrantManualException
      biometricEvidence={reason}
      biometricAttemptFailed
      biometricAwaitingIdVerification={false}
      inPersonRoute={IN_PERSON_ROUTE_OPEN}
      seniorExceptionAvailable={false}
    />,
  )

  it("never puts the word 'fingerprint' in front of staff", () => {
    // The lender collects no fingerprint biometric. "subjectFingerprint" is the
    // SHA-256 digest binding a check to one client record; rendering the raw
    // enum printed "SUBJECT FINGERPRINT MISSING" on the KYC screen, which
    // states a check this lender does not perform.
    for (const reason of Object.keys(BIOMETRIC_FAILURE_COPY)) {
      expect(render(reason).toLowerCase()).not.toContain("fingerprint")
    }
  })

  it("never renders a raw enum identifier", () => {
    for (const reason of Object.keys(BIOMETRIC_FAILURE_COPY)) {
      expect(render(reason)).not.toContain(reason)
      expect(render(reason)).not.toContain(reason.replaceAll("_", " "))
    }
  })

  it("gives every failure reason its own staff wording", () => {
    const labels = Object.values(BIOMETRIC_FAILURE_COPY).map((c) => c.label)
    expect(new Set(labels).size).toBe(labels.length)
    for (const reason of Object.keys(BIOMETRIC_FAILURE_COPY)) {
      const copy = BIOMETRIC_FAILURE_COPY[reason as keyof typeof BIOMETRIC_FAILURE_COPY]
      expect(decode(render(reason))).toContain(copy.label)
      expect(copy.detail.length).toBeGreaterThan(20)
    }
  })

  it("falls back rather than inventing copy for an unknown reason", () => {
    const html = render("some_reason_that_does_not_exist")
    expect(html).toContain("Identity not verified")
    expect(html).not.toContain("some_reason_that_does_not_exist")
  })
})

describe("SelfieKycTab pending override controls", () => {
  it("uses the request kind for approval while keeping decline available", () => {
    const html = renderToStaticMarkup(
      <SelfieKycTab
        clientId="client-1"
        currentKycStatus="FAILED"
        currentManualRejectionActive={false}
        currentManualRejectionReason={null}
        selfieDoc={reviewableFailure}
        imageUrl="/api/documents/selfie-latest/view"
        canGrantManualException={false}
        canRecordInPersonVerification
        canDecideOverrideRequest
        currentUserId="approver-2"
        pendingOverrideRequests={[{
          id: "request-1",
          kind: "EXCEPTION",
          requestedById: "requester-1",
          requestedAt: "2026-10-13T12:00:00.000Z",
          expiresAt: "2026-10-20T12:00:00.000Z",
          requestedBy: { email: "requester@test.invalid", name: "Synthetic Requester" },
        }]}
        biometricEvidence="match_score_below_threshold"
        biometricAttemptFailed
        biometricAwaitingIdVerification={false}
        inPersonRoute={IN_PERSON_ROUTE_OPEN}
        seniorExceptionAvailable
      />,
    )
    expect(html).toContain("Decline")
    expect(html).not.toContain(">Approve<")
  })
})
