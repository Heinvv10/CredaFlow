import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SelfieKycTab } from "@/components/clients/SelfieKycTab"

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

const SENIOR_EXCEPTION = {
  reason: "Synthetic: lighting defeated the camera twice.",
  supportingEvidence: "Synthetic branch visit note.",
  biometricFailureReason: "match_score_below_threshold",
  approvedAt: "2026-07-10T09:00:00.000Z",
  approvedByEmail: "senior@test.invalid",
}

function tab(currentKycStatus: "PENDING" | "VERIFIED", withException = false) {
  return (
    <SelfieKycTab
      clientId="client-1"
      currentKycStatus={currentKycStatus}
      currentManualException={withException ? SENIOR_EXCEPTION : null}
      currentManualRejectionActive={false}
      currentManualRejectionReason={null}
      selfieDoc={null}
      imageUrl={null}
      biometricEvidence={null}
      biometricAttemptFailed={false}
      biometricAwaitingIdVerification={false}
      inPersonRoute={{ blockingBiometricAttempt: false, idDocumentAdmissible: true }}
      seniorExceptionAvailable={false}
    />
  )
}

function textOf(node: { children: unknown[] }): string {
  return node.children
    .map((child) => (typeof child === "string" ? child : textOf(child as { children: unknown[] })))
    .join("")
}

function statusCard(renderer: ReactTestRenderer) {
  const card = renderer.root.find((node) => node.props.id === "kyc-identity-verification")
  const badge = card.find((node) => node.type === "span" && String(node.props.className).includes("rounded-full"))
  const approve = card.findAll((node) => node.type === "button")
    .find((button) => textOf(button).includes("Approve KYC"))
  return { status: badge.props.children as string, approveDisabled: Boolean(approve?.props.disabled) }
}

describe("SelfieKycTab KYC Status card", () => {
  beforeEach(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    delete actEnvironment.IS_REACT_ACT_ENVIRONMENT
  })

  // A sibling (the KYC checklist's Re-verify ID) changes the stored status and
  // calls router.refresh(); the card must show the refreshed server status.
  it("follows a refreshed server status instead of keeping its first one", async () => {
    let renderer!: ReactTestRenderer
    await act(async () => {
      renderer = create(tab("PENDING"))
    })
    expect(statusCard(renderer)).toEqual({ status: "PENDING", approveDisabled: false })

    await act(async () => {
      renderer.update(tab("VERIFIED"))
    })

    expect(statusCard(renderer)).toEqual({ status: "VERIFIED", approveDisabled: true })
    await act(async () => renderer.unmount())
  })

  // The badge is the STORED status; the derived exception only names a stored VERIFIED.
  it("shows a stored PENDING under a senior exception, and MANUAL EXCEPTION once VERIFIED", async () => {
    let renderer!: ReactTestRenderer
    await act(async () => {
      renderer = create(tab("PENDING", true))
    })
    expect(statusCard(renderer).status).toBe("PENDING")

    await act(async () => {
      renderer.update(tab("VERIFIED", true))
    })

    expect(statusCard(renderer).status).toBe("MANUAL EXCEPTION")
    await act(async () => renderer.unmount())
  })
})
