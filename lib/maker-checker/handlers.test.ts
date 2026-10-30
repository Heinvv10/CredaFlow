import { describe, expect, it, vi } from "vitest"
import { PERMISSIONS } from "@/lib/registry/generated/permissions"

vi.mock("@/lib/prisma", () => ({ prisma: {} }))

import { handlerFor, registeredKinds } from "./handlers"

// A contract every change handler must meet before anyone can approve through it.
describe("the registered change handlers", () => {
  const kinds = registeredKinds()

  it("registers at least the decisioning kinds", () => {
    expect(kinds).toEqual(expect.arrayContaining(["DECISION_RULE_SET", "DECISION_ENGINE_CONFIG"]))
  })

  it.each(kinds)("%s: its own kind equals its registry key, and it declares what the service needs", (kind) => {
    const handler = handlerFor(kind)!
    expect(handler.kind).toBe(kind)
    expect(handler.label.trim().length).toBeGreaterThan(0)
    expect(Number.isInteger(handler.payloadVersion) && handler.payloadVersion >= 1).toBe(true)
    expect(typeof handler.parse).toBe("function")
    expect(typeof handler.apply).toBe("function")
  })

  it.each(kinds)("%s: its permissions exist in the permission registry", (kind) => {
    const handler = handlerFor(kind)!
    expect(Object.keys(PERMISSIONS)).toContain(handler.makePermission)
    if (typeof handler.approvePermission === "string") expect(Object.keys(PERMISSIONS)).toContain(handler.approvePermission)
  })

  it("makes and approves are different permissions, so approval can be given to different people", () => {
    for (const kind of kinds) {
      const handler = handlerFor(kind)!
      expect(handler.approvePermission).not.toBe(handler.makePermission)
    }
  })

  it("answers null for a kind nobody registered", () => {
    expect(handlerFor("NOT_A_KIND")).toBeNull()
  })
})
