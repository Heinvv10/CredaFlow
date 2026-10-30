import { describe, expect, it } from "vitest"
import { inChallengerGroup, pickChampion, type VersionRef } from "./select-version"

const v = (over: Partial<VersionRef> & Pick<VersionRef, "id">): VersionRef => ({
  scopeKey: "ALL", version: 1, effectiveFrom: "2026-01-01", challengerOnly: false, ...over,
})

describe("pickChampion", () => {
  const all1 = v({ id: "all1" })
  const all2 = v({ id: "all2", version: 2, effectiveFrom: "2026-06-01" })

  it("takes the highest version that is already effective", () => {
    expect(pickChampion([all1, all2], "p1", "2026-06-01")?.id).toBe("all2")
    expect(pickChampion([all1, all2], "p1", "2026-05-31")?.id).toBe("all1")
  })

  it("runs nothing before the first version's effective date", () => {
    expect(pickChampion([all1], "p1", "2025-12-31")).toBeNull()
  })

  it("a product's own set outranks the lender-wide set once it is effective", () => {
    const own = v({ id: "own", scopeKey: "p1", effectiveFrom: "2026-03-01" })
    expect(pickChampion([all2, own], "p1", "2026-07-01")?.id).toBe("own")
    expect(pickChampion([all1, all2, own], "p1", "2026-02-01")?.id).toBe("all1")
    expect(pickChampion([all2, own], "p2", "2026-07-01")?.id).toBe("all2")
  })

  it("never picks a challenger-only version as champion", () => {
    const chal = v({ id: "chal", version: 3, effectiveFrom: "2026-01-01", challengerOnly: true })
    expect(pickChampion([all1, chal], "p1", "2026-07-01")?.id).toBe("all1")
    expect(pickChampion([chal], "p1", "2026-07-01")).toBeNull()
  })
})

describe("inChallengerGroup", () => {
  it("is deterministic per application", () => {
    expect(inChallengerGroup("app_1", "ver_9", 30)).toBe(inChallengerGroup("app_1", "ver_9", 30))
  })

  it("0 percent routes nobody, 100 would route everybody, and the share is close to the percent", () => {
    const ids = Array.from({ length: 2000 }, (_, i) => `app_${i}`)
    expect(ids.some((id) => inChallengerGroup(id, "ver_9", 0))).toBe(false)
    expect(ids.every((id) => inChallengerGroup(id, "ver_9", 100))).toBe(true)
    const share = ids.filter((id) => inChallengerGroup(id, "ver_9", 20)).length / ids.length
    expect(share).toBeGreaterThan(0.16)
    expect(share).toBeLessThan(0.24)
  })

  it("a larger percent only adds applications to the group", () => {
    const ids = Array.from({ length: 500 }, (_, i) => `app_${i}`)
    const at10 = ids.filter((id) => inChallengerGroup(id, "ver_9", 10))
    expect(at10.every((id) => inChallengerGroup(id, "ver_9", 25))).toBe(true)
  })
})

describe("inChallengerGroup: boundaries and salt", () => {
  const ids = Array.from({ length: 1000 }, (_, i) => `app_${i}`)

  it("1 percent routes about one in a hundred, 50 about half, and never more than the percent plus noise", () => {
    expect(ids.filter((id) => inChallengerGroup(id, "ver_9", 1)).length).toBeLessThan(30)
    const half = ids.filter((id) => inChallengerGroup(id, "ver_9", 50)).length
    expect(half).toBeGreaterThan(440)
    expect(half).toBeLessThan(560)
  })

  it("the challenger version salts the hash: another version gets a different share of the same applications", () => {
    const a = new Set(ids.filter((id) => inChallengerGroup(id, "ver_A", 50)))
    const b = new Set(ids.filter((id) => inChallengerGroup(id, "ver_B", 50)))
    const overlap = [...a].filter((id) => b.has(id)).length
    // Independent halves overlap by about a quarter of the applications, not all of them.
    expect(overlap).toBeGreaterThan(180)
    expect(overlap).toBeLessThan(320)
  })

  it("a negative percent routes nobody", () => {
    expect(ids.some((id) => inChallengerGroup(id, "ver_9", -5))).toBe(false)
  })
})
