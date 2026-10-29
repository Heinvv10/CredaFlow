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
