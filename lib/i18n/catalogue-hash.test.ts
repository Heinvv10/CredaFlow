import { afterEach, describe, expect, it, vi } from "vitest"

// The review record pins this hash: it must move on any text edit and stay
// put when only the key order changes. The catalogue is swapped per case, so
// the module (and its cache) is loaded fresh each time; the graph is tiny.
async function hashOf(af: unknown): Promise<string> {
  vi.resetModules()
  vi.doMock("./catalog", () => ({ CATALOGS: { af } }))
  const { catalogueHash } = await import("./catalogue-hash")
  return catalogueHash("af")
}

afterEach(() => {
  vi.doUnmock("./catalog")
})

describe("catalogueHash", () => {
  it("changes when any string in any namespace changes", async () => {
    const base = await hashOf({ portal: { title: "My lenings", pay: "Betaal" }, website: { cta: "Doen aansoek" } })
    expect(await hashOf({ portal: { title: "My lenings", pay: "Betaal nou" }, website: { cta: "Doen aansoek" } })).not.toBe(base)
    expect(await hashOf({ portal: { title: "My lenings", pay: "Betaal" }, website: { cta: "Doen aansoek", extra: "Nuut" } })).not.toBe(base)
  })

  it("ignores key order", async () => {
    const a = await hashOf({ portal: { title: "My lenings", pay: "Betaal" }, website: { cta: "Doen aansoek" } })
    const b = await hashOf({ website: { cta: "Doen aansoek" }, portal: { pay: "Betaal", title: "My lenings" } })
    expect(b).toBe(a)
  })
})
