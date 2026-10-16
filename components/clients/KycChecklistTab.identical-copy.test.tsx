import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { KycChecklistTab } from "@/components/clients/KycChecklistTab"

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }))
vi.mock("@/lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

const SHA = "a".repeat(64)
const OTHER_SHA = "b".repeat(64)

function doc(id: string, docType: string, day: number, over: Record<string, unknown> = {}) {
  return {
    id, clientId: "client-1", docType, fileName: `${id}.jpg`, fileUrl: "", mimeType: "image/jpeg", fileSize: 1024,
    deletedAt: null, verified: true, verifiedAt: `2026-08-${day}T12:00:00.000Z`, verificationNote: null,
    verificationRejectedById: null, verificationRejectedAt: null, contentSha256: SHA,
    extractionStatus: "skipped", extractionResult: null, createdAt: `2026-08-${day}T12:00:00.000Z`, ...over,
  }
}

const OTHER_CORE = [doc("payslip", "PAYSLIP", 10), doc("statement", "BANK_STATEMENT", 10), doc("address", "PROOF_OF_ADDRESS", 10)]
const VERIFIED_ID = doc("id-verified", "ID_COPY", 10)
const reupload = (over: Record<string, unknown> = {}) =>
  doc("id-reupload", "ID_COPY", 12, { verified: false, verifiedAt: null, ...over })

function textOf(node: { children: unknown[] }): string {
  return node.children
    .map((child) => (typeof child === "string" ? child : textOf(child as { children: unknown[] })))
    .join("")
}

/** Mount with the list newest first, as GET /api/clients/[id]/documents returns it. */
async function mount(kycStatus: string, documents: unknown[]) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => documents } as unknown as Response))
  let renderer!: ReactTestRenderer
  await act(async () => {
    renderer = create(<KycChecklistTab clientId="client-1" kycStatus={kycStatus} />)
  })
  const buttons = (label: string) => renderer.root
    .findAll((node) => node.type === "button", { deep: true })
    .filter((node) => textOf(node).trim() === label).length
  return { text: textOf(renderer.root as unknown as { children: unknown[] }), verify: buttons("Verify"), reject: buttons("Reject") }
}

describe("KycChecklistTab: an identical ID re-upload is the verified copy", () => {
  beforeEach(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    delete actEnvironment.IS_REACT_ACT_ENVIRONMENT
  })

  it("shows the twin as identical, offers no Verify or Reject on it, and counts it verified", async () => {
    const view = await mount("VERIFIED", [reupload(), VERIFIED_ID, ...OTHER_CORE])

    expect(view.text).toContain("Identical to verified copy")
    expect(view.text).toContain("4 / 4 verified")
    expect(view.text).toContain("All required docs verified")
    // Reject sits only on the three other (verified) rows; nothing to verify.
    expect(view).toMatchObject({ verify: 0, reject: 3 })
  })

  it("leaves a re-upload of other bytes pending review, with Verify and Reject", async () => {
    const view = await mount("PENDING", [reupload({ contentSha256: OTHER_SHA }), VERIFIED_ID, ...OTHER_CORE])

    expect(view.text).not.toContain("Identical to verified copy")
    expect(view.text).toContain("3 / 4 verified")
    expect(view).toMatchObject({ verify: 1, reject: 4 })
  })

  it("never matches a re-upload with no digest", async () => {
    const view = await mount("PENDING", [reupload({ contentSha256: null }), VERIFIED_ID, ...OTHER_CORE])

    expect(view.text).not.toContain("Identical to verified copy")
    expect(view.text).toContain("3 / 4 verified")
  })

  it("does not call a refused identical copy identical", async () => {
    const refused = reupload({ verificationRejectedById: "officer-1", verificationRejectedAt: "2026-08-13T09:00:00.000Z", verificationNote: "Synthetic: blurred" })
    const view = await mount("VERIFIED", [refused, VERIFIED_ID, ...OTHER_CORE])

    expect(view.text).not.toContain("Identical to verified copy")
    expect(view.text).toContain("Rejected")
    // The verified copy still carries the KYC: the count agrees with the VERIFIED badge.
    expect(view.text).toContain("4 / 4 verified")
  })

  it("shows the different copy that holds the client PENDING, not a newer twin over it", async () => {
    // V verified, X of other bytes awaiting review, T identical to V and newest.
    const pending = doc("id-pending", "ID_COPY", 11, { verified: false, verifiedAt: null, contentSha256: OTHER_SHA })
    const view = await mount("PENDING", [reupload(), pending, VERIFIED_ID, ...OTHER_CORE])

    expect(view.text).toContain("id-pending.jpg")
    expect(view.text).not.toContain("Identical to verified copy")
    expect(view.text).toContain("3 / 4 verified")
    // Staff can act on the copy that holds the client: Verify and Reject on X.
    expect(view).toMatchObject({ verify: 1, reject: 4 })
  })

  it("offers no Verify on a refused identical copy (the route refuses it: the verified copy already carries it)", async () => {
    const refused = reupload({ verificationRejectedById: "officer-1", verificationRejectedAt: "2026-08-13T09:00:00.000Z", verificationNote: "Synthetic: blurred" })
    const view = await mount("VERIFIED", [refused, VERIFIED_ID, ...OTHER_CORE])

    expect(view.text).toContain("Rejected")
    expect(view.verify).toBe(0)
  })
})
