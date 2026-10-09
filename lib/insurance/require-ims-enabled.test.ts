// lib/insurance/require-ims-enabled.test.ts
import { afterEach, describe, expect, it, vi } from "vitest"

const { findUnique, getTenantConfig } = vi.hoisted(() => ({
  findUnique: vi.fn(),
  getTenantConfig: vi.fn(),
}))

vi.mock("@/lib/prisma", () => ({ prisma: { tenantConfig: { findUnique } } }))

// getTenantConfig is stubbed only so the suite can prove the guard does NOT use
// it. resolveFeatureFlags stays REAL so this suite proves the guard reads the
// flag the same way every other gate in the app does — a hand-written copy of
// the resolver in the mock could not fail.
vi.mock("@/lib/tenant", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant")>()),
  getTenantConfig,
}))

afterEach(() => {
  vi.clearAllMocks()
})

describe("requireImsEnabled", () => {
  it("returns null (no-op) when featureIms is on", async () => {
    findUnique.mockResolvedValue({ featureCrm: false, featureIms: true })

    const { requireImsEnabled } = await import("./require-ims-enabled")
    expect(await requireImsEnabled("tenant-1")).toBeNull()
  })

  it("returns 404 — not 403 — when featureIms is off", async () => {
    findUnique.mockResolvedValue({ featureCrm: true, featureIms: false })

    const { requireImsEnabled } = await import("./require-ims-enabled")
    const res = await requireImsEnabled("tenant-1")

    expect(res).not.toBeNull()
    expect(res!.status).toBe(404)
    // A disabled module must not advertise its own existence.
    expect(res!.status).not.toBe(403)
    expect(await res!.json()).toEqual({ error: "Not found" })
  })

  it("blocks when the tenant has no config row at all", async () => {
    // resolveFeatureFlags treats a missing row as OFF; the guard must inherit
    // that, not read the absent flag as permission.
    findUnique.mockResolvedValue(null)

    const { requireImsEnabled } = await import("./require-ims-enabled")
    expect((await requireImsEnabled("tenant-1"))?.status).toBe(404)
  })

  it("fails CLOSED when the lookup rejects", async () => {
    findUnique.mockRejectedValue(new Error("db unreachable"))

    const { requireImsEnabled } = await import("./require-ims-enabled")
    const res = await requireImsEnabled("tenant-1")

    expect(res).not.toBeNull()
    expect(res!.status).toBe(404)
  })

  it("fails CLOSED when the lookup throws synchronously", async () => {
    findUnique.mockImplementation(() => {
      throw new Error("boom")
    })

    const { requireImsEnabled } = await import("./require-ims-enabled")
    expect((await requireImsEnabled("tenant-1"))?.status).toBe(404)
  })
})

describe("requireImsEnabled — the kill switch has no fuse", () => {
  // The defect: the guard read the flag through getTenantConfig, which wraps
  // its query in unstable_cache with `revalidate: 300`. No revalidateTag call
  // exists anywhere in this repo, so flipping featureIms off left every gated
  // route under app/api/insurance/** serving for up to five minutes per running
  // instance. A kill switch that cannot be pulled now is not a kill switch.
  it("does not read the flag through the 300-second cached resolver", async () => {
    findUnique.mockResolvedValue({ featureCrm: false, featureIms: true })

    const { requireImsEnabled } = await import("./require-ims-enabled")
    await requireImsEnabled("tenant-1")

    expect(getTenantConfig).not.toHaveBeenCalled()
    expect(findUnique).toHaveBeenCalledTimes(1)
  })

  it("blocks on a freshly-flipped flag even while the cached resolver still says ON", async () => {
    // The live row is the authority. This is the exact state during the first
    // five minutes after an operator disables the module.
    getTenantConfig.mockResolvedValue({ featureCrm: false, featureIms: true })
    findUnique.mockResolvedValue({ featureCrm: false, featureIms: false })

    const { requireImsEnabled } = await import("./require-ims-enabled")
    expect((await requireImsEnabled("tenant-1"))?.status).toBe(404)
  })

  it("costs one indexed lookup, selecting only the flags", async () => {
    // tenantId is @unique, so this is an index hit. Selecting the whole config
    // row on every gated request would make the gate the expensive part.
    findUnique.mockResolvedValue({ featureCrm: false, featureIms: true })

    const { requireImsEnabled } = await import("./require-ims-enabled")
    await requireImsEnabled("tenant-1")

    expect(findUnique).toHaveBeenCalledWith({
      where: { tenantId: "tenant-1" },
      select: { featureCrm: true, featureIms: true },
    })
  })
})
