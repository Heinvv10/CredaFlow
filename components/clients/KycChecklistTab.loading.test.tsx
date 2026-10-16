// @vitest-environment jsdom
// Loading behaviour of KycChecklistTab: the first load, and a switch to another
// client, where a slow response for the old one must not overwrite the new list.
import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { KycChecklistTab } from "./KycChecklistTab"

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }))
vi.mock("@/lib/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}))

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

let renderer: ReactTestRenderer

function idDoc(fileName: string) {
  return {
    id: `id-${fileName}`, docType: "ID_COPY", fileName, mimeType: "image/jpeg", fileSize: 1024,
    deletedAt: null, verified: false, verifiedAt: null, verificationNote: null,
    verificationRejectedById: null, extractionStatus: "skipped", extractionResult: null,
    createdAt: "2026-08-14T12:00:00.000Z",
  }
}

function json(body: unknown) {
  return { ok: true, status: 200, json: async () => body }
}

function text(): string {
  return JSON.stringify(renderer.toJSON())
}

function deferred() {
  let resolve!: (v: unknown) => void
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}

beforeEach(() => { actEnvironment.IS_REACT_ACT_ENVIRONMENT = true })

afterEach(() => {
  act(() => renderer.unmount())
  vi.unstubAllGlobals()
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = false
})

describe("KycChecklistTab loading", () => {
  it("shows the documents once the first load lands", async () => {
    const pending = deferred()
    vi.stubGlobal("fetch", vi.fn(() => pending.promise))
    await act(async () => { renderer = create(<KycChecklistTab clientId="a" kycStatus="PENDING" />) })
    expect(text()).not.toContain("a-id.jpg")

    await act(async () => { pending.resolve(json([idDoc("a-id.jpg")])) })
    expect(text()).toContain("a-id.jpg")
  })

  it("ignores a slow response for the client the user has already left", async () => {
    const slowA = deferred()
    vi.stubGlobal("fetch", vi.fn((url: string) =>
      url.includes("/clients/a/") ? slowA.promise : Promise.resolve(json([idDoc("b-id.jpg")]))))
    await act(async () => { renderer = create(<KycChecklistTab clientId="a" kycStatus="PENDING" />) })
    await act(async () => { renderer.update(<KycChecklistTab clientId="b" kycStatus="PENDING" />) })
    expect(text()).toContain("b-id.jpg")

    await act(async () => { slowA.resolve(json([idDoc("a-id.jpg")])) })
    expect(text()).toContain("b-id.jpg")
    expect(text()).not.toContain("a-id.jpg")
  })
})
