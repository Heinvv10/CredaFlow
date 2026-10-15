import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { KycChecklistTab } from "@/components/clients/KycChecklistTab"
import { toast } from "@/lib/toast"
import { VERIFICATION_RESTORABLE_COPY } from "@/lib/kyc/verification-restorable"

const refresh = vi.fn()
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }))
vi.mock("@/lib/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn(), document: { verified: vi.fn() } },
}))

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

const idCopy = (id: string, createdAt: string, verified: boolean) => ({
  id, docType: "ID_COPY", fileName: `${id}.jpg`, mimeType: "image/jpeg", fileSize: 1024,
  deletedAt: null, verified, verifiedAt: null, verificationNote: null, verificationRejectedById: null,
  extractionStatus: "done", createdAt, extractionResult: null,
})
// Newest first, as the list route returns them. id-current is the newest VERIFIED copy.
const DOCUMENTS = [
  idCopy("id-unverified-newest", "2026-07-03T00:00:00.000Z", false),
  idCopy("id-current", "2026-07-02T00:00:00.000Z", true),
  idCopy("id-older", "2026-07-01T00:00:00.000Z", true),
]

const jsonResponse = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response

function textOf(node: { children: unknown[] }): string {
  return node.children
    .map((child) => (typeof child === "string" ? child : textOf(child as { children: unknown[] })))
    .join("")
}

async function mount(verifyResponse: Response) {
  const fetchMock = vi.fn((url: string) =>
    Promise.resolve(url.endsWith("/kyc-rederive") ? verifyResponse : jsonResponse(200, DOCUMENTS)))
  vi.stubGlobal("fetch", fetchMock)
  let renderer!: ReactTestRenderer
  await act(async () => {
    renderer = create(<KycChecklistTab clientId="client-1" kycStatus="PENDING" verificationRestorable />)
  })
  return { renderer, fetchMock }
}

async function clickReverify(renderer: ReactTestRenderer) {
  const button = renderer.root
    .findAll((node) => node.type === "button", { deep: true })
    .find((node) => textOf(node).includes("Re-verify ID"))
  if (!button) throw new Error("no Re-verify ID button")
  await act(async () => { await button.props.onClick() })
}

const writeCalls = (fetchMock: ReturnType<typeof vi.fn>) =>
  fetchMock.mock.calls.filter(([, init]) => init?.method && init.method !== "GET")

describe("Re-verify ID in the restorable-verification hint", () => {
  beforeEach(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    delete actEnvironment.IS_REACT_ACT_ENVIRONMENT
  })

  it("re-derives from the newest verified ID copy, attesting nothing, then refreshes", async () => {
    const { renderer, fetchMock } = await mount(jsonResponse(200, { kycStatus: "VERIFIED" }))
    expect(textOf(renderer.root as unknown as { children: unknown[] })).toContain(VERIFICATION_RESTORABLE_COPY)

    await clickReverify(renderer)

    // One write, to the re-derive route: never the document verify route.
    const calls = writeCalls(fetchMock)
    expect(calls).toHaveLength(1)
    const [url, init] = calls[0] as unknown as [string, RequestInit]
    expect(url).toBe("/api/clients/client-1/kyc-rederive")
    expect(init.method).toBe("POST")
    expect(JSON.parse(String(init.body))).toEqual({ idDocumentId: "id-current" })
    expect(refresh).toHaveBeenCalledTimes(1)
    const shown = textOf(renderer.root as unknown as { children: unknown[] })
    expect(shown).not.toContain(VERIFICATION_RESTORABLE_COPY)
    expect(shown).toContain("VERIFIED")
  })

  it.each([
    [403, "Forbidden"],
    [409, "This ID copy is no longer the client's current verified copy. Reload the page to see its state."],
  ])("shows a %i refusal inline and keeps the hint, without refreshing or a toast", async (status, refusal) => {
    const { renderer } = await mount(jsonResponse(status, { error: refusal }))

    await clickReverify(renderer)

    const shown = textOf(renderer.root as unknown as { children: unknown[] })
    expect(shown).toContain(refusal)
    expect(shown).toContain(VERIFICATION_RESTORABLE_COPY)
    expect(refresh).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it("says so inline when the route answers but KYC did not become VERIFIED", async () => {
    const { renderer } = await mount(jsonResponse(200, { kycStatus: "PENDING" }))

    await clickReverify(renderer)

    expect(textOf(renderer.root as unknown as { children: unknown[] }))
      .toContain("KYC is still PENDING.")
  })
})
