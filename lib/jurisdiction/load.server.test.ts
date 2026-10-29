import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const findMany = vi.fn()
vi.mock("@/lib/prisma", () => ({ prisma: { tenantConfig: { findMany: (...a: unknown[]) => findMany(...a) } } }))

import { activeCurrency, activeJurisdiction, isJurisdictionLoaded, resetActiveJurisdiction } from "./active"
import {
  JurisdictionConflictError,
  bootActiveJurisdiction,
  ensureActiveJurisdiction,
  loadActiveJurisdiction,
  resetEnsuredJurisdiction,
} from "./load.server"

const original = process.env.NEXT_PUBLIC_TENANT_SLUG
const row = (slug: string, jurisdiction: string, currency: string) => ({ tenant: { slug }, jurisdiction, currency })

beforeEach(() => {
  findMany.mockReset()
  delete process.env.NEXT_PUBLIC_TENANT_SLUG
  vi.spyOn(console, "error").mockImplementation(() => {})
})
afterEach(() => {
  resetActiveJurisdiction()
  resetEnsuredJurisdiction()
  if (original === undefined) delete process.env.NEXT_PUBLIC_TENANT_SLUG
  else process.env.NEXT_PUBLIC_TENANT_SLUG = original
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe("loadActiveJurisdiction", () => {
  it("adopts the jurisdiction and currency of the instance's ACTIVE tenants", async () => {
    findMany.mockResolvedValue([row("a", "LS", "LSL")])
    await expect(loadActiveJurisdiction()).resolves.toEqual({ jurisdiction: "LS", currency: "LSL" })
    expect(activeJurisdiction()).toBe("LS")
    expect(activeCurrency()).toBe("LSL")
    expect(findMany.mock.calls[0][0].where).toEqual({ tenant: { status: "ACTIVE" } })
  })

  it("accepts several tenants that agree", async () => {
    findMany.mockResolvedValue([row("a", "ZA", "ZAR"), row("b", "ZA", "ZAR")])
    await expect(loadActiveJurisdiction()).resolves.toEqual({ jurisdiction: "ZA", currency: "ZAR" })
    expect(isJurisdictionLoaded()).toBe(true)
  })

  it("REFUSES an instance whose ACTIVE tenants disagree, naming them", async () => {
    findMany.mockResolvedValue([row("basotho", "LS", "LSL"), row("acme", "ZA", "ZAR")])
    const failure = await loadActiveJurisdiction().catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(JurisdictionConflictError)
    expect((failure as Error).message).toMatch(/basotho=LS\/LSL.*acme=ZA\/ZAR/)
    expect(isJurisdictionLoaded()).toBe(false)
  })

  it("a slug that names no ACTIVE tenant adopts nothing (a suspended tenant is not the lender)", async () => {
    process.env.NEXT_PUBLIC_TENANT_SLUG = "suspended-one"
    findMany.mockResolvedValue([row("other", "LS", "LSL")])
    await expect(loadActiveJurisdiction()).resolves.toEqual({ jurisdiction: "ZA", currency: "ZAR" })
    expect(isJurisdictionLoaded()).toBe(false)
  })

  it("keeps ZA and logs when the read fails, rather than throwing into the layout", async () => {
    findMany.mockRejectedValue(new Error("db down"))
    await expect(loadActiveJurisdiction()).resolves.toEqual({ jurisdiction: "ZA", currency: "ZAR" })
    expect(console.error).toHaveBeenCalled()
  })

  it("keeps ZA when the stored value is not a known code", async () => {
    findMany.mockResolvedValue([row("a", "XX", "ZAR")])
    await expect(loadActiveJurisdiction()).resolves.toEqual({ jurisdiction: "ZA", currency: "ZAR" })
    expect(console.error).toHaveBeenCalled()
  })

  it("keeps ZA when a ZA tenant is stored with another currency", async () => {
    findMany.mockResolvedValue([row("a", "ZA", "LSL")])
    await expect(loadActiveJurisdiction()).resolves.toEqual({ jurisdiction: "ZA", currency: "ZAR" })
    expect(isJurisdictionLoaded()).toBe(false)
  })
})

describe("ensureActiveJurisdiction", () => {
  it("queries once per process once the lender is known, even for ZA", async () => {
    findMany.mockResolvedValue([row("a", "ZA", "ZAR")])
    await ensureActiveJurisdiction()
    await ensureActiveJurisdiction()
    expect(findMany).toHaveBeenCalledTimes(1)
  })

  it("does not hammer the database after a failed read, then tries again", async () => {
    vi.useFakeTimers()
    findMany.mockRejectedValueOnce(new Error("db down")).mockResolvedValue([row("a", "LS", "LSL")])
    await ensureActiveJurisdiction()
    await ensureActiveJurisdiction()
    expect(findMany).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(6_000)
    expect((await ensureActiveJurisdiction()).jurisdiction).toBe("LS")
    expect(findMany).toHaveBeenCalledTimes(2)
  })

  it("rejects, permanently, once the tenants are found to disagree", async () => {
    findMany.mockResolvedValue([row("a", "LS", "LSL"), row("b", "ZA", "ZAR")])
    await expect(ensureActiveJurisdiction()).rejects.toBeInstanceOf(JurisdictionConflictError)
    await expect(ensureActiveJurisdiction()).rejects.toBeInstanceOf(JurisdictionConflictError)
    expect(findMany).toHaveBeenCalledTimes(1)
  })
})

describe("bootActiveJurisdiction", () => {
  const sleep = () => Promise.resolve()

  it("retries a failed read with backoff until the lender is known", async () => {
    findMany.mockRejectedValueOnce(new Error("starting up")).mockRejectedValueOnce(new Error("starting up"))
      .mockResolvedValue([row("a", "LS", "LSL")])
    const state = await bootActiveJurisdiction({ sleep })
    expect(state).toEqual({ jurisdiction: "LS", currency: "LSL" })
    expect(findMany).toHaveBeenCalledTimes(3)
    expect(console.error).toHaveBeenCalled()
  })

  it("throws, so the process does not start, when the tenants disagree", async () => {
    findMany.mockResolvedValue([row("a", "LS", "LSL"), row("b", "ZA", "ZAR")])
    await expect(bootActiveJurisdiction({ sleep })).rejects.toBeInstanceOf(JurisdictionConflictError)
  })

  it("does not wait for ever on a hung database: boots as ZA after the timeout", async () => {
    vi.useFakeTimers()
    findMany.mockReturnValue(new Promise(() => {}))
    const booting = bootActiveJurisdiction({ timeoutMs: 1_000, sleep })
    await vi.advanceTimersByTimeAsync(1_001)
    await expect(booting).resolves.toEqual({ jurisdiction: "ZA", currency: "ZAR" })
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("not loaded after 1000 ms"), "")
  })
})
