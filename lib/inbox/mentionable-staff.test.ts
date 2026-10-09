import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { loadMentionableStaff, resetMentionableStaffCache } from "./mentionable-staff"

const staff = [{ id: "u2", name: "Bo Nkosi", email: "bo@x.co" }]

beforeEach(() => {
  resetMentionableStaffCache()
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => staff }))
})
afterEach(() => { vi.unstubAllGlobals() })

it("issues one request for two callers and gives both the roster", async () => {
  const [a, b] = await Promise.all([loadMentionableStaff(), loadMentionableStaff()])

  expect(fetch).toHaveBeenCalledTimes(1)
  expect(a).toEqual(staff)
  expect(b).toEqual(staff)
})

// The reset is LOAD-BEARING for every request-counting assertion in the suite:
// module state outlives a test (vitest isolates per file), so a reset that
// silently did nothing would leave those tests measuring a warm cache and
// passing for the wrong reason — while still looking like proof of the
// module-level cache. This is the test that fails if the reset is a no-op.
it("actually clears the cache, so a later caller fetches again", async () => {
  await loadMentionableStaff()
  expect(fetch).toHaveBeenCalledTimes(1)

  resetMentionableStaffCache()
  await loadMentionableStaff()

  expect(fetch).toHaveBeenCalledTimes(2)
})

it("drops the cache on a failed fetch so a later caller retries", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")))

  expect(await loadMentionableStaff()).toEqual([])

  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => staff }))
  expect(await loadMentionableStaff()).toEqual(staff)
})

it("returns an empty roster rather than throwing on a non-ok response", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }))

  expect(await loadMentionableStaff()).toEqual([])
})

// The stub shape at ClientCommsTab.test.tsx — a bare vi.fn() returns undefined,
// so `res.ok` throws inside the same try.
it("returns an empty roster when fetch returns undefined", async () => {
  vi.stubGlobal("fetch", vi.fn())

  expect(await loadMentionableStaff()).toEqual([])
})

// A JSON body that isn't an array would otherwise reach filterMentionable and
// throw inside a render.
it("returns an empty roster when the body is not an array", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ error: "nope" }) }))

  expect(await loadMentionableStaff()).toEqual([])
})
