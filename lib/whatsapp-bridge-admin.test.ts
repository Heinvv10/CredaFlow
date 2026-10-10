import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { listWaBridgeNumbers, addWaBridgeNumber, promoteWaBridgeNumber, setWaBridgeNumberPriority, retireWaBridgeNumber } from "./whatsapp-bridge-admin"

describe("whatsapp-bridge-admin", () => {
  const originalFetch = global.fetch
  beforeEach(() => {
    process.env.WA_BRIDGE_ADMIN_SECRET = "test-secret-value-16-chars-plus"
    process.env.WA_SENDER_URL = "http://bridge.test"
  })
  afterEach(() => {
    global.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it("listWaBridgeNumbers sends the admin secret header", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ numbers: [{ slotId: "a", status: "CONNECTED" }] }) })
    global.fetch = fetchMock as unknown as typeof fetch

    const result = await listWaBridgeNumbers()

    expect(result).toHaveLength(1)
    const [, init] = fetchMock.mock.calls[0]
    expect((init.headers as Record<string, string>)["x-bridge-admin-secret"]).toBe("test-secret-value-16-chars-plus")
  })

  it("addWaBridgeNumber throws the bridge's error message on failure", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: "number is required" }) }) as unknown as typeof fetch
    await expect(addWaBridgeNumber("")).rejects.toThrow("number is required")
  })

  it("promoteWaBridgeNumber throws without WA_BRIDGE_ADMIN_SECRET configured", async () => {
    delete process.env.WA_BRIDGE_ADMIN_SECRET
    await expect(promoteWaBridgeNumber("slot-a")).rejects.toThrow("WA_BRIDGE_ADMIN_SECRET")
  })

  it("addWaBridgeNumber returns the pairing result on success", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ slotId: "slot-1", pairingCode: "ABC123", expiresAt: "2026-08-03T22:00:00Z" }),
    })
    global.fetch = fetchMock as unknown as typeof fetch

    const result = await addWaBridgeNumber("+27123456789")

    expect(result).toEqual({ slotId: "slot-1", pairingCode: "ABC123", expiresAt: "2026-08-03T22:00:00Z" })
  })

  it("promoteWaBridgeNumber succeeds and returns void", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true }) })
    global.fetch = fetchMock as unknown as typeof fetch

    const result = await promoteWaBridgeNumber("slot-1")

    expect(result).toBeUndefined()
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toContain("/numbers/slot-1/promote")
    expect(init.method).toBe("POST")
  })

  it("setWaBridgeNumberPriority issues PATCH with correct priority", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) })
    global.fetch = fetchMock as unknown as typeof fetch

    await setWaBridgeNumberPriority("slot-2", 5)

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toContain("/numbers/slot-2")
    expect(init.method).toBe("PATCH")
    expect(init.body).toBe(JSON.stringify({ priority: 5 }))
  })

  it("retireWaBridgeNumber issues DELETE to the correct slot", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) })
    global.fetch = fetchMock as unknown as typeof fetch

    await retireWaBridgeNumber("slot-3")

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toContain("/numbers/slot-3")
    expect(init.method).toBe("DELETE")
  })

  // The bridge's own ADD_SLOT_PAIRING_TIMEOUT_MS
  // (set in the separate bridge service) is 30s. If every bridgeFetch call
  // shared one 15s AbortSignal.timeout, then between 15s and 30s the
  // app would return 502 "add failed" while the bridge was still pairing --
  // and the abort doesn't cancel bridge-side work, so a pairing that then
  // succeeded would leave a live slot nobody saw the code for, and a retry could
  // create a second one. addWaBridgeNumber needs its own bound comfortably
  // above 30s; every other call keeps the shorter 15s bound.
  it("addWaBridgeNumber uses a timeout above the bridge's 30s pairing window", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout")
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ slotId: "slot-1", pairingCode: "ABC123", expiresAt: "2026-08-03T22:00:00Z" }),
    })
    global.fetch = fetchMock as unknown as typeof fetch

    await addWaBridgeNumber("27821234567")

    expect(timeoutSpy).toHaveBeenCalledTimes(1)
    const usedMs = timeoutSpy.mock.calls[0][0]
    expect(usedMs).toBeGreaterThan(30_000)
  })

  it("listWaBridgeNumbers keeps the shorter 15s timeout by default", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout")
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ numbers: [] }) })
    global.fetch = fetchMock as unknown as typeof fetch

    await listWaBridgeNumbers()

    expect(timeoutSpy).toHaveBeenCalledWith(15_000)
  })

  it("promoteWaBridgeNumber keeps the shorter 15s timeout (interactive call, not the add-slot path)", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout")
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true }) })
    global.fetch = fetchMock as unknown as typeof fetch

    await promoteWaBridgeNumber("slot-1")

    expect(timeoutSpy).toHaveBeenCalledWith(15_000)
  })

  // page.tsx loads listWaBridgeNumbers() inside a
  // server-rendered Promise.all on every Comms Settings page view. With the
  // default 15s bound, a bridge that's up-but-unresponsive stalls the whole
  // settings page for 15s -- the very screen an operator needs when something is
  // wrong. An explicit timeoutMs override lets the page-load call use a
  // short bound while every other (interactive, user-initiated) call stays
  // at 15s.
  it("listWaBridgeNumbers accepts a shorter timeoutMs override for the page-load path", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout")
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ numbers: [] }) })
    global.fetch = fetchMock as unknown as typeof fetch

    await listWaBridgeNumbers({ timeoutMs: 5_000 })

    expect(timeoutSpy).toHaveBeenCalledWith(5_000)
  })

  // lib/whatsapp.ts (the long-standing /send-message
  // path) and this admin client both read WA_SENDER_URL, but they must not
  // fall back to DIFFERENT default hosts when it is unset. Wherever the env
  // var isn't set (a non-production environment is the likely case), the cron
  // would poll a different endpoint than sends actually use, silently inverting the
  // alert's meaning. This client must fail loud instead of guessing, the
  // same way getAdminSecret() already does for the missing-secret case.
  it("throws when WA_SENDER_URL is unset instead of guessing a default host", async () => {
    delete process.env.WA_SENDER_URL
    const fetchMock = vi.fn()
    global.fetch = fetchMock as unknown as typeof fetch

    await expect(listWaBridgeNumbers()).rejects.toThrow("WA_SENDER_URL is not configured")
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
