import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { KycChecklistTab } from "@/components/clients/KycChecklistTab"
import { VERIFICATION_RESTORABLE_COPY, verificationRestorable } from "@/lib/kyc/verification-restorable"

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }))
vi.mock("@/lib/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn(), document: { verified: vi.fn() } },
}))

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

const ID_COPY = {
  id: "id-current", docType: "ID_COPY", fileName: "id.jpg", mimeType: "image/jpeg", fileSize: 1024,
  deletedAt: null, verified: true, verifiedAt: null, verificationNote: null, verificationRejectedById: null,
  extractionStatus: "done", createdAt: "2026-07-02T00:00:00.000Z", extractionResult: null,
}
const jsonResponse = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response

function textOf(node: ReactTestInstance | string): string {
  if (typeof node === "string") return node
  return node.children.map((child) => textOf(child)).join("")
}

async function mount(props: Partial<Parameters<typeof KycChecklistTab>[0]> & { kycStatus: string }) {
  let renderer!: ReactTestRenderer
  await act(async () => {
    renderer = create(<KycChecklistTab clientId="client-1" {...props} />)
  })
  return renderer
}

/** The text of the "KYC Status" badge in the status banner. */
function statusBadge(renderer: ReactTestRenderer): string {
  const label = renderer.root.find((node) => node.type === "p" && textOf(node) === "KYC Status")
  return textOf(label.parent as ReactTestInstance).replace(/^KYC Status/, "")
}

// The evidence on file derives VERIFIED; only the stored status is PENDING.
const evidenceVerifies = {
  state: { kycStatus: "VERIFIED" as const, kycVerifiedAt: new Date("2026-07-10T09:00:00.000Z"), kycVerifiedById: "attester-1", kycVerificationMethod: "PHYSICAL" as const },
}

describe("KycChecklistTab status banner", () => {
  beforeEach(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, [ID_COPY])))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    delete actEnvironment.IS_REACT_ACT_ENVIRONMENT
  })

  it("shows the stored PENDING, not the in-person provenance the evidence derives", async () => {
    const renderer = await mount({ kycStatus: "PENDING", manualExceptionActive: true, substituteKind: "in_person" })
    expect(statusBadge(renderer)).toBe("PENDING")
  })

  it("shows the stored PENDING, not MANUAL EXCEPTION, under a senior exception", async () => {
    const renderer = await mount({ kycStatus: "PENDING", manualExceptionActive: true, substituteKind: "senior_exception" })
    expect(statusBadge(renderer)).toBe("PENDING")
  })

  it("names the provenance once the stored status is VERIFIED", async () => {
    expect(statusBadge(await mount({ kycStatus: "VERIFIED", manualExceptionActive: true, substituteKind: "in_person" })))
      .toBe("VERIFIED IN PERSON")
    expect(statusBadge(await mount({ kycStatus: "VERIFIED", manualExceptionActive: true, substituteKind: "senior_exception" })))
      .toBe("MANUAL EXCEPTION")
    expect(statusBadge(await mount({ kycStatus: "VERIFIED" }))).toBe("VERIFIED")
  })

  it("hides the Re-verify hint after a deliberate manual PENDING", async () => {
    const hidden = await mount({
      kycStatus: "PENDING",
      verificationRestorable: verificationRestorable("PENDING", evidenceVerifies, { manualPendingStands: true }),
    })
    expect(textOf(hidden.root)).not.toContain(VERIFICATION_RESTORABLE_COPY)
    expect(textOf(hidden.root)).not.toContain("Re-verify ID")

    const shown = await mount({
      kycStatus: "PENDING",
      verificationRestorable: verificationRestorable("PENDING", evidenceVerifies, { manualPendingStands: false }),
    })
    expect(textOf(shown.root)).toContain(VERIFICATION_RESTORABLE_COPY)
    expect(textOf(shown.root)).toContain("Re-verify ID")
  })
})
