import { describe, expect, it } from "vitest"
import { canDo } from "@/lib/permissions"
import { approvePermissionFor } from "@/lib/maker-checker/types"
import { decisionEngineConfigHandler } from "./change-handlers"
import type { EngineConfigPayload } from "./change-payloads"

const payload = (over: Partial<EngineConfigPayload>): EngineConfigPayload => ({ mode: "SHADOW", s71SignOff: false, ...over }) as EngineConfigPayload
const permissionFor = (over: Partial<EngineConfigPayload>) => approvePermissionFor(decisionEngineConfigHandler, payload(over))

describe("who may approve engine settings", () => {
  it.each([
    ["going LIVE", { mode: "LIVE" as const }],
    ["recording the s71 sign-off", { s71SignOff: true }],
  ])("%s needs a SUPER_ADMIN, not just any ADMIN", (_label, over) => {
    expect(permissionFor(over)).toBe("approve_decision_engine_live")
    expect(canDo("ADMIN", permissionFor(over))).toBe(false)
    expect(canDo("SUPER_ADMIN", permissionFor(over))).toBe(true)
  })

  it("a change that leaves the engine OFF or SHADOW and unsigned stays with an ADMIN", () => {
    for (const mode of ["OFF", "SHADOW"] as const) {
      expect(permissionFor({ mode })).toBe("approve_decision_rules")
      expect(canDo("ADMIN", permissionFor({ mode }))).toBe(true)
    }
  })
})

describe("the engine settings refuse asset-finance products", () => {
  const tx = (products: Array<{ id: string; productType: string }>) => ({
    loanProduct: { findMany: async () => products },
    decisionRuleSetVersion: { findMany: async () => [{ scopeKey: "ALL" }], findFirst: async () => null },
  }) as never

  it("names the asset-finance product and refuses the change", async () => {
    await expect(decisionEngineConfigHandler.verify!(tx([{ id: "p-micro", productType: "MICRO" }, { id: "p-af", productType: "ASSET_FINANCE" }]), "t", payload({ productIds: ["p-micro", "p-af"], channels: ["STAFF"] })))
      .rejects.toMatchObject({ problems: [expect.stringContaining("p-af is an asset-finance product")] })
  })

  it("lets consumer products through", async () => {
    await expect(decisionEngineConfigHandler.verify!(tx([{ id: "p-micro", productType: "MICRO" }]), "t", payload({ productIds: ["p-micro"], channels: ["STAFF"] }))).resolves.toBeUndefined()
  })
})
