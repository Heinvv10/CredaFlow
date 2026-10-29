import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const findUnique = vi.fn()
const logError = vi.hoisted(() => vi.fn())
vi.mock("@/lib/observability/logger", () => ({ logger: { error: logError } }))
vi.mock("@/lib/prisma", () => ({ prisma: { instanceJurisdiction: { findUnique: (...a: unknown[]) => findUnique(...a) } } }))

import { activeCurrency, activeJurisdiction, isJurisdictionLoaded, resetActiveJurisdiction } from "./active"
import {
  JurisdictionChangedError,
  RELOAD_TTL_MS,
  bootActiveJurisdiction,
  ensureActiveJurisdiction,
  loadActiveJurisdiction,
  resetEnsuredJurisdiction,
} from "./load.server"

const row = (jurisdiction: string, currency: string) => ({ id: 1, jurisdiction, currency })

beforeEach(() => {
  findUnique.mockReset()
  logError.mockReset()
})
afterEach(() => {
  resetActiveJurisdiction()
  resetEnsuredJurisdiction()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe("loadActiveJurisdiction (reads the instance row, not the tenants)", () => {
  it("adopts the instance's jurisdiction and currency", async () => {
    findUnique.mockResolvedValue(row("LS", "LSL"))
    await expect(loadActiveJurisdiction()).resolves.toEqual({ jurisdiction: "LS", currency: "LSL" })
    expect(activeJurisdiction()).toBe("LS")
    expect(activeCurrency()).toBe("LSL")
    expect(findUnique.mock.calls[0][0]).toEqual({ where: { id: 1 } })
  })

  it("keeps ZA (gates on) and stays unloaded when there is no row yet", async () => {
    findUnique.mockResolvedValue(null)
    await expect(loadActiveJurisdiction()).resolves.toEqual({ jurisdiction: "ZA", currency: "ZAR" })
    expect(isJurisdictionLoaded()).toBe(false)
  })

  it("keeps ZA and logs when the read fails, rather than throwing into the layout", async () => {
    findUnique.mockRejectedValue(new Error("db down"))
    await expect(loadActiveJurisdiction()).resolves.toEqual({ jurisdiction: "ZA", currency: "ZAR" })
    expect(logError).toHaveBeenCalled()
  })

  it("keeps ZA when the stored value is not a known code, or ZA with another currency", async () => {
    findUnique.mockResolvedValue(row("XX", "ZAR"))
    await loadActiveJurisdiction()
    findUnique.mockResolvedValue(row("ZA", "LSL"))
    await loadActiveJurisdiction()
    expect(isJurisdictionLoaded()).toBe(false)
    expect(logError).toHaveBeenCalled()
  })

  it("refuses a database value that differs from the one already in use", async () => {
    findUnique.mockResolvedValue(row("LS", "LSL"))
    await loadActiveJurisdiction()
    findUnique.mockResolvedValue(row("ZA", "ZAR"))
    await expect(loadActiveJurisdiction()).rejects.toBeInstanceOf(JurisdictionChangedError)
    expect(activeJurisdiction()).toBe("LS")
  })
})

describe("ensureActiveJurisdiction", () => {
  it("does not query again inside the TTL once loaded, even for ZA", async () => {
    findUnique.mockResolvedValue(row("ZA", "ZAR"))
    await ensureActiveJurisdiction()
    await ensureActiveJurisdiction()
    expect(findUnique).toHaveBeenCalledTimes(1)
  })

  it("re-reads after the TTL, and carries on when the value is unchanged", async () => {
    vi.useFakeTimers()
    findUnique.mockResolvedValue(row("LS", "LSL"))
    await ensureActiveJurisdiction()
    vi.advanceTimersByTime(RELOAD_TTL_MS + 1)
    await expect(ensureActiveJurisdiction()).resolves.toEqual({ jurisdiction: "LS", currency: "LSL" })
    expect(findUnique).toHaveBeenCalledTimes(2)
  })

  it("REFUSES TO SERVE when the database value has changed under a warm process", async () => {
    vi.useFakeTimers()
    findUnique.mockResolvedValue(row("LS", "LSL"))
    await ensureActiveJurisdiction()
    findUnique.mockResolvedValue(row("ZA", "ZAR"))
    vi.advanceTimersByTime(RELOAD_TTL_MS + 1)
    await expect(ensureActiveJurisdiction()).rejects.toBeInstanceOf(JurisdictionChangedError)
    // Not served from the stale cache while it is wrong, and not re-read on every request.
    await expect(ensureActiveJurisdiction()).rejects.toBeInstanceOf(JurisdictionChangedError)
    expect(findUnique).toHaveBeenCalledTimes(2)
    expect(logError).toHaveBeenCalled()
  })

  it("serves again once the database value matches the process again", async () => {
    vi.useFakeTimers()
    findUnique.mockResolvedValueOnce(row("LS", "LSL")).mockResolvedValueOnce(row("ZA", "ZAR")).mockResolvedValue(row("LS", "LSL"))
    await ensureActiveJurisdiction()
    vi.advanceTimersByTime(RELOAD_TTL_MS + 1)
    await expect(ensureActiveJurisdiction()).rejects.toBeInstanceOf(JurisdictionChangedError)
    vi.advanceTimersByTime(6_000)
    await expect(ensureActiveJurisdiction()).resolves.toEqual({ jurisdiction: "LS", currency: "LSL" })
  })

  it("keeps serving the cached value when a periodic re-read merely fails", async () => {
    vi.useFakeTimers()
    findUnique.mockResolvedValueOnce(row("LS", "LSL")).mockRejectedValue(new Error("db blip"))
    await ensureActiveJurisdiction()
    vi.advanceTimersByTime(RELOAD_TTL_MS + 1)
    await expect(ensureActiveJurisdiction()).resolves.toEqual({ jurisdiction: "LS", currency: "LSL" })
  })

  it("does not hammer the database after a failed first read, then tries again", async () => {
    vi.useFakeTimers()
    findUnique.mockRejectedValueOnce(new Error("db down")).mockResolvedValue(row("LS", "LSL"))
    await ensureActiveJurisdiction()
    await ensureActiveJurisdiction()
    expect(findUnique).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(6_000)
    expect((await ensureActiveJurisdiction()).jurisdiction).toBe("LS")
    expect(findUnique).toHaveBeenCalledTimes(2)
  })
})

describe("bootActiveJurisdiction", () => {
  const sleep = () => Promise.resolve()

  it("retries a failed read with backoff until the instance row is read", async () => {
    findUnique.mockRejectedValueOnce(new Error("starting up")).mockRejectedValueOnce(new Error("starting up")).mockResolvedValue(row("LS", "LSL"))
    await expect(bootActiveJurisdiction({ sleep })).resolves.toEqual({ jurisdiction: "LS", currency: "LSL" })
    expect(findUnique).toHaveBeenCalledTimes(3)
  })

  it("boots at once as ZA, logging once, when there is no instance row (not migrated)", async () => {
    findUnique.mockResolvedValue(null)
    const sleeps: number[] = []
    const state = await bootActiveJurisdiction({ sleep: async (ms) => { sleeps.push(ms) } })
    expect(state).toEqual({ jurisdiction: "ZA", currency: "ZAR" })
    expect(findUnique).toHaveBeenCalledTimes(1)
    expect(sleeps).toEqual([])
    expect(logError.mock.calls.filter((c) => String(c[0]).includes("no instance jurisdiction"))).toHaveLength(1)
  })

  it("does not wait for ever on a hung database: boots as ZA after the timeout", async () => {
    vi.useFakeTimers()
    findUnique.mockReturnValue(new Promise(() => {}))
    const booting = bootActiveJurisdiction({ timeoutMs: 1_000, sleep })
    await vi.advanceTimersByTimeAsync(1_001)
    await expect(booting).resolves.toEqual({ jurisdiction: "ZA", currency: "ZAR" })
    expect(logError).toHaveBeenCalledWith(expect.stringContaining("not loaded after 1000 ms"), undefined)
  })
})
