import { describe, expect, it, vi } from "vitest"

vi.mock("./env", () => ({ log: vi.fn() }))

import { extractWithRetry, vlmPacing, vlmSlot, type ExtractionAttempt } from "./vlm-gate"

const PACING = { pauseMs: 5000, backoffMs: [30_000, 60_000, 120_000] }

describe("vlmSlot", () => {
  it("runs one slot at a time across callers, pausing after each", async () => {
    const trace: string[] = []
    let inFlight = 0
    let maxInFlight = 0
    const wait = vi.fn(async (ms: number) => {
      trace.push(`pause ${ms}`)
    })
    const work = (name: string) => async () => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      trace.push(`start ${name}`)
      await new Promise((r) => setTimeout(r, 5))
      trace.push(`end ${name}`)
      inFlight--
      return name
    }

    // Opened together, as two scenarios would if they ever ran concurrently.
    const results = await Promise.all([
      vlmSlot("a", work("a"), PACING, wait),
      vlmSlot("b", work("b"), PACING, wait),
      vlmSlot("c", work("c"), PACING, wait),
    ])

    expect(results).toEqual(["a", "b", "c"])
    expect(maxInFlight).toBe(1)
    expect(trace).toEqual([
      "start a", "end a", "pause 5000",
      "start b", "end b", "pause 5000",
      "start c", "end c", "pause 5000",
    ])
  })

  it("pauses after a failed slot and does not block the next one", async () => {
    const wait = vi.fn(async (_ms: number) => {})
    const failed = vlmSlot("bad", async () => { throw new Error("upload 500") }, PACING, wait)
    const next = vlmSlot("good", async () => "ok", PACING, wait)
    await expect(failed).rejects.toThrow("upload 500")
    await expect(next).resolves.toBe("ok")
    expect(wait).toHaveBeenCalledTimes(2)
  })
})

describe("extractWithRetry", () => {
  const fail = (reason: string): ExtractionAttempt => ({ ok: false, reason })

  it("does not wait or retry when the first attempt succeeds", async () => {
    const wait = vi.fn(async (_ms: number) => {})
    const retry = vi.fn(async (): Promise<ExtractionAttempt> => ({ ok: true }))
    await extractWithRetry("doc", async () => ({ ok: true }), retry, PACING, wait)
    expect(wait).not.toHaveBeenCalled()
    expect(retry).not.toHaveBeenCalled()
  })

  it("backs off 30 s then 60 s and stops at the first success", async () => {
    const wait = vi.fn(async (_ms: number) => {})
    const retry = vi.fn<() => Promise<ExtractionAttempt>>()
      .mockResolvedValueOnce(fail("VLM request timed out after 55s"))
      .mockResolvedValueOnce({ ok: true })
    await extractWithRetry("doc", async () => fail("VLM responded 503"), retry, PACING, wait)
    expect(wait.mock.calls.map(([ms]) => ms)).toEqual([30_000, 60_000])
    expect(retry).toHaveBeenCalledTimes(2)
  })

  it("throws with the last reason once every backoff is spent", async () => {
    const wait = vi.fn(async (_ms: number) => {})
    const retry = vi.fn(async () => fail("re-extract answered 422: fetch failed"))
    await expect(
      extractWithRetry("bg-04 PAYSLIP", async () => fail("fetch failed"), retry, PACING, wait),
    ).rejects.toThrow("bg-04 PAYSLIP: extraction still failing after 3 retries: re-extract answered 422: fetch failed")
    expect(wait.mock.calls.map(([ms]) => ms)).toEqual([30_000, 60_000, 120_000])
    expect(retry).toHaveBeenCalledTimes(3)
  })

  it("treats a thrown error (app unreachable) as a failed attempt", async () => {
    const wait = vi.fn(async (_ms: number) => {})
    const retry = vi.fn<() => Promise<ExtractionAttempt>>().mockResolvedValueOnce({ ok: true })
    await extractWithRetry("doc", async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:3320") }, retry, PACING, wait)
    expect(wait.mock.calls.map(([ms]) => ms)).toEqual([30_000])
    expect(retry).toHaveBeenCalledTimes(1)
  })
})

describe("vlmPacing", () => {
  it("defaults to a 5 s pause and 30/60/120 s backoff", () => {
    expect(vlmPacing({})).toEqual({ pauseMs: 5000, backoffMs: [30_000, 60_000, 120_000] })
  })

  it("reads both settings from the environment", () => {
    expect(vlmPacing({ SIM_VLM_PAUSE_MS: "8000", SIM_VLM_RETRY_BACKOFF_MS: "1000, 2000" }))
      .toEqual({ pauseMs: 8000, backoffMs: [1000, 2000] })
  })

  it.each([["SIM_VLM_PAUSE_MS", "5s"], ["SIM_VLM_PAUSE_MS", "-1"], ["SIM_VLM_RETRY_BACKOFF_MS", "30000,,60000"]])(
    "rejects %s=%j",
    (key, value) => {
      expect(() => vlmPacing({ [key]: value })).toThrow(key)
    },
  )
})
