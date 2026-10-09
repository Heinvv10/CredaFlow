import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./providers", () => ({ dispatch: vi.fn() }))

import { dispatch } from "./providers"
import {
  MESSAGE_DISPATCH_LEASE_MS,
  dispatchWithinTimeout,
} from "./provider-timeout"

describe("dispatchWithinTimeout", () => {
  beforeEach(() => vi.resetAllMocks())

  it("aborts a provider call before its durable lease can expire", async () => {
    vi.useFakeTimers()
    vi.mocked(dispatch).mockImplementation((_channel, _provider, _rendered, opts) => (
      new Promise((_resolve, reject) => {
        opts.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
      })
    ))

    const pending = dispatchWithinTimeout(
      "SMS",
      "BULKSMS",
      { subject: null, html: null, text: "hello" },
      { tenantId: "tenant-1", toValue: "27820000000" },
      1_000,
    )
    const assertion = expect(pending).rejects.toThrow(/deadline|aborted/i)
    await vi.advanceTimersByTimeAsync(1_000)
    await assertion
    expect(1_000).toBeLessThan(MESSAGE_DISPATCH_LEASE_MS)
    vi.useRealTimers()
  })

  it("refuses a timeout that could outlive the lease", async () => {
    await expect(dispatchWithinTimeout(
      "SMS",
      "BULKSMS",
      { subject: null, html: null, text: "hello" },
      { tenantId: "tenant-1", toValue: "27820000000" },
      MESSAGE_DISPATCH_LEASE_MS,
    )).rejects.toThrow(/shorter than the dispatch lease/i)
    expect(dispatch).not.toHaveBeenCalled()
  })
})
