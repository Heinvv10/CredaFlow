// @vitest-environment jsdom
// Loading behaviour of DocumentsTab: first load, a switch to another client
// (a slow response for the old one must not overwrite the new list), and the
// 5 s poll that runs while a document is still being extracted.
import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DocumentsTab } from "./DocumentsTab"

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

let renderer: ReactTestRenderer

function doc(fileName: string, extractionStatus = "done") {
  return {
    id: `id-${fileName}`, clientId: "c", docType: "PAYSLIP", fileUrl: "/x", fileName,
    verified: false, uploadedByType: "staff", uploadedById: "u1", deletedAt: null,
    fileSize: 1024, mimeType: "application/pdf", extractionStatus, extractionResult: null,
    extractionError: null, validationResult: null, validationMismatch: false, validationScore: null,
    biometricMatchScore: null, biometricLiveness: null, biometricVerifiedAt: null, biometricResult: null,
    verifiedAt: null, verifiedById: null, verificationNote: null, createdAt: "2026-07-29T08:00:00.000Z",
  }
}

function text(): string {
  return JSON.stringify(renderer.toJSON())
}

function json(body: unknown) {
  return { ok: true, status: 200, json: async () => body }
}

type Deferred = { promise: Promise<unknown>; resolve: (v: unknown) => void }
function deferred(): Deferred {
  let resolve!: (v: unknown) => void
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}

beforeEach(() => {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(() => {
  act(() => renderer.unmount())
  vi.useRealTimers()
  vi.unstubAllGlobals()
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = false
})

describe("DocumentsTab loading", () => {
  it("shows no list until the first load lands, then the documents", async () => {
    const pending = deferred()
    vi.stubGlobal("fetch", vi.fn((url: string) =>
      url.includes("signing-packets") ? Promise.resolve(json([])) : pending.promise))
    await act(async () => { renderer = create(<DocumentsTab clientId="a" popiaConsentGiven />) })
    expect(text()).not.toContain("a-payslip.pdf")

    await act(async () => { pending.resolve(json([doc("a-payslip.pdf")])) })
    expect(text()).toContain("a-payslip.pdf")
  })

  it("ignores a slow response for the client the user has already left", async () => {
    const slowA = deferred()
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (url.includes("signing-packets")) return Promise.resolve(json([]))
      return url.includes("/clients/a/") ? slowA.promise : Promise.resolve(json([doc("b-payslip.pdf")]))
    }))
    await act(async () => { renderer = create(<DocumentsTab clientId="a" popiaConsentGiven />) })
    await act(async () => { renderer.update(<DocumentsTab clientId="b" popiaConsentGiven />) })
    expect(text()).toContain("b-payslip.pdf")

    await act(async () => { slowA.resolve(json([doc("a-payslip.pdf")])) })
    expect(text()).toContain("b-payslip.pdf")
    expect(text()).not.toContain("a-payslip.pdf")
  })

  it("keeps polling every 5 s while a document is still being extracted", async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(async (url: string) =>
      json(url.includes("signing-packets") ? [] : [doc("a-payslip.pdf", "processing")]))
    vi.stubGlobal("fetch", fetchMock)
    await act(async () => { renderer = create(<DocumentsTab clientId="a" popiaConsentGiven />) })
    const listCalls = () => fetchMock.mock.calls.filter(([u]) => !String(u).includes("signing-packets")).length
    expect(listCalls()).toBe(1)

    await act(async () => { await vi.advanceTimersByTimeAsync(4999) })
    expect(listCalls()).toBe(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(listCalls()).toBe(2)
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(listCalls()).toBe(3)
  })

  it("does not poll once nothing is being extracted", async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(async (url: string) =>
      json(url.includes("signing-packets") ? [] : [doc("a-payslip.pdf", "done")]))
    vi.stubGlobal("fetch", fetchMock)
    await act(async () => { renderer = create(<DocumentsTab clientId="a" popiaConsentGiven />) })
    await act(async () => { await vi.advanceTimersByTimeAsync(15000) })
    expect(fetchMock).toHaveBeenCalledTimes(2) // one list, one packets
  })
})
