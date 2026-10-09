import { describe, expect, it, vi } from "vitest"
import {
  deletePortalDocumentAndReconcile,
  PortalDocumentPoller,
  type PortalPollingState,
} from "@/lib/kyc/portal-document-poller"

function timerHarness() {
  let nextId = 1
  const callbacks = new Map<number, () => void>()
  const schedule = vi.fn((callback: () => void) => {
    const id = nextId++
    callbacks.set(id, callback)
    return id as unknown as ReturnType<typeof setTimeout>
  })
  const cancel = vi.fn((timer: ReturnType<typeof setTimeout>) => {
    callbacks.delete(timer as unknown as number)
  })
  const runNext = () => {
    const next = callbacks.entries().next()
    if (next.done) throw new Error("No scheduled poll")
    const [id, callback] = next.value
    callbacks.delete(id)
    callback()
  }
  return { callbacks, schedule, cancel, runNext }
}

async function flushPromises() {
  await Promise.resolve()
  await Promise.resolve()
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe("PortalDocumentPoller", () => {
  it("calls default browser timers with the native global receiver", async () => {
    let nextId = 1
    const callbacks = new Map<number, () => void>()
    const browserSchedule = vi.fn(function (
      this: unknown,
      callback: () => void,
    ) {
      if (this !== globalThis) throw new TypeError("Illegal invocation")
      const id = nextId++
      callbacks.set(id, callback)
      return id as unknown as ReturnType<typeof setTimeout>
    })
    const browserCancel = vi.fn(function (
      this: unknown,
      timer: ReturnType<typeof setTimeout>,
    ) {
      if (this !== globalThis) throw new TypeError("Illegal invocation")
      callbacks.delete(timer as unknown as number)
    })
    vi.stubGlobal("setTimeout", browserSchedule)
    vi.stubGlobal("clearTimeout", browserCancel)

    try {
      const refresh = vi.fn().mockResolvedValue({
        documents: [{ id: "doc-browser", extractionStatus: "processing" }],
      })
      const poller = new PortalDocumentPoller(refresh)

      poller.start("doc-browser")
      await flushPromises()

      expect(browserSchedule).toHaveBeenCalledOnce()
      expect(callbacks.size).toBe(1)

      poller.dispose()

      expect(browserCancel).toHaveBeenCalledOnce()
      expect(callbacks.size).toBe(0)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("starts polling documents that were already in progress on initial sync", async () => {
    const timers = timerHarness()
    const refresh = vi.fn().mockResolvedValue({
      documents: [{ id: "doc-initial", extractionStatus: "processing" }],
    })
    const poller = new PortalDocumentPoller(
      refresh,
      3_000,
      timers.schedule,
      timers.cancel,
    )

    poller.sync([{ id: "doc-initial", extractionStatus: "pending" }])
    await flushPromises()

    expect(refresh).toHaveBeenCalledTimes(1)
    expect(poller.isActive("doc-initial")).toBe(true)
    expect(timers.schedule).toHaveBeenCalledWith(expect.any(Function), 3_000)
  })

  it("retries null and rejected refreshes, then stops on a terminal state", async () => {
    const timers = timerHarness()
    const refresh = vi.fn()
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error("network unavailable"))
      .mockResolvedValueOnce({
        documents: [{ id: "doc-1", extractionStatus: "failed" }],
      })
    const poller = new PortalDocumentPoller(
      refresh,
      3_000,
      timers.schedule,
      timers.cancel,
    )

    poller.start("doc-1")
    await flushPromises()
    expect(timers.callbacks.size).toBe(1)
    expect(poller.isActive("doc-1")).toBe(true)

    timers.runNext()
    await flushPromises()
    expect(timers.callbacks.size).toBe(1)
    expect(poller.isActive("doc-1")).toBe(true)

    timers.runNext()
    await flushPromises()
    expect(refresh).toHaveBeenCalledTimes(3)
    expect(poller.isActive("doc-1")).toBe(false)
    expect(timers.callbacks.size).toBe(0)
  })

  it("deduplicates active IDs and cancels every timer on dispose", async () => {
    const timers = timerHarness()
    const refresh = vi.fn().mockResolvedValue({
      documents: [{ id: "doc-1", extractionStatus: "processing" }],
    })
    const poller = new PortalDocumentPoller(
      refresh,
      3_000,
      timers.schedule,
      timers.cancel,
    )

    poller.start("doc-1")
    poller.start("doc-1")
    await flushPromises()
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(timers.callbacks.size).toBe(1)

    poller.dispose()

    expect(poller.isActive("doc-1")).toBe(false)
    expect(timers.callbacks.size).toBe(0)
    expect(timers.cancel).toHaveBeenCalledTimes(1)
  })

  it("uses one serialized refresh for multiple active documents", async () => {
    const timers = timerHarness()
    const first = deferred<PortalPollingState | null>()
    const refresh = vi.fn().mockImplementation(() => first.promise)
    const poller = new PortalDocumentPoller(
      refresh,
      3_000,
      timers.schedule,
      timers.cancel,
    )

    poller.sync([
      { id: "doc-1", extractionStatus: "processing" },
      { id: "doc-2", extractionStatus: "pending" },
    ])
    poller.start("doc-3")

    expect(refresh).toHaveBeenCalledTimes(1)

    first.resolve({
      documents: [
        { id: "doc-1", extractionStatus: "processing" },
        { id: "doc-2", extractionStatus: "processing" },
        { id: "doc-3", extractionStatus: "processing" },
      ],
    })
    await flushPromises()

    expect(refresh).toHaveBeenCalledTimes(1)
    expect(timers.callbacks.size).toBe(1)
    expect(poller.isActive("doc-1")).toBe(true)
    expect(poller.isActive("doc-2")).toBe(true)
    expect(poller.isActive("doc-3")).toBe(true)
  })

  it("retries upload reconciliation without a known ID, then starts document polling", async () => {
    const timers = timerHarness()
    const refresh = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValue({
        documents: [{ id: "doc-new", extractionStatus: "processing" }],
      })
    const poller = new PortalDocumentPoller(
      refresh,
      3_000,
      timers.schedule,
      timers.cancel,
    )

    poller.reconcile()
    await flushPromises()
    expect(poller.isReconciling()).toBe(true)
    expect(timers.callbacks.size).toBe(1)

    timers.runNext()
    await flushPromises()

    expect(refresh).toHaveBeenCalledTimes(2)
    expect(poller.isReconciling()).toBe(false)
    expect(poller.isActive("doc-new")).toBe(true)
    expect(timers.callbacks.size).toBe(1)
  })

  it("cancels an upload-reconciliation retry on dispose", async () => {
    const timers = timerHarness()
    const refresh = vi.fn().mockResolvedValue(null)
    const poller = new PortalDocumentPoller(
      refresh,
      3_000,
      timers.schedule,
      timers.cancel,
    )

    poller.reconcile()
    await flushPromises()
    expect(timers.callbacks.size).toBe(1)

    poller.dispose()

    expect(poller.isReconciling()).toBe(false)
    expect(timers.callbacks.size).toBe(0)
    expect(timers.cancel).toHaveBeenCalledTimes(1)
  })

  it("serializes refreshes and queues reconciliation requested in flight", async () => {
    const timers = timerHarness()
    const first = deferred<PortalPollingState | null>()
    const second = deferred<PortalPollingState | null>()
    const refresh = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
    const poller = new PortalDocumentPoller(
      refresh,
      3_000,
      timers.schedule,
      timers.cancel,
    )

    poller.reconcile()
    poller.reconcile()

    expect(refresh).toHaveBeenCalledTimes(1)
    expect(poller.isReconciling()).toBe(true)

    first.resolve({ documents: [] })
    await flushPromises()

    expect(refresh).toHaveBeenCalledTimes(2)
    expect(poller.isReconciling()).toBe(true)
    expect(timers.callbacks.size).toBe(0)

    second.resolve({ documents: [] })
    await flushPromises()

    expect(refresh).toHaveBeenCalledTimes(2)
    expect(poller.isReconciling()).toBe(false)
    expect(timers.callbacks.size).toBe(0)
  })

  it("retries authoritative state after a successful delete refresh fails", async () => {
    const timers = timerHarness()
    const request = vi.fn().mockResolvedValue({ ok: true })
    const refresh = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ documents: [] })
    const poller = new PortalDocumentPoller(
      refresh,
      3_000,
      timers.schedule,
      timers.cancel,
    )

    const deleted = await deletePortalDocumentAndReconcile({
      documentId: "doc-deleted",
      request,
      reconcile: () => poller.reconcile(),
    })
    await flushPromises()

    expect(deleted).toEqual({ ok: true })
    expect(request).toHaveBeenCalledWith(
      "/api/documents/doc-deleted",
      { method: "DELETE" },
    )
    expect(poller.isReconciling()).toBe(true)
    expect(timers.callbacks.size).toBe(1)

    timers.runNext()
    await flushPromises()

    expect(refresh).toHaveBeenCalledTimes(2)
    expect(poller.isReconciling()).toBe(false)
    expect(timers.callbacks.size).toBe(0)
  })
})
