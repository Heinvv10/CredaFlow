import { describe, expect, it, vi } from "vitest"
import { ensureSystemUser, findSystemUser, SYSTEM_USER_PASSWORD } from "./system-user"

describe("the lender's automated decisioning account", () => {
  it("reports the role the row has, not an assumed one (breaker B)", async () => {
    const db = { user: { findFirst: vi.fn(async () => ({ id: "sys", email: "s@system.invalid", role: "READONLY" })) } }
    expect((await findSystemUser(db as never, "t"))?.role).toBe("READONLY")
  })

  it("provisions one inactive account with no usable password the first time, and reuses it after", async () => {
    const create = vi.fn(async () => ({ id: "sys", email: "s@system.invalid", role: "LOAN_ADMIN" }))
    const none = { user: { findFirst: vi.fn(async () => null), create } }
    await ensureSystemUser(none as never, "t1")
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ tenantId: "t1", isSystem: true, active: false, password: SYSTEM_USER_PASSWORD, role: "LOAN_ADMIN" }) }))
    const have = { user: { findFirst: vi.fn(async () => ({ id: "sys", email: "s@system.invalid", role: "LOAN_ADMIN" })), create: vi.fn() } }
    expect((await ensureSystemUser(have as never, "t1")).id).toBe("sys")
    expect(have.user.create).not.toHaveBeenCalled()
  })

  it("the password is not a hash anything can match", () => {
    expect(SYSTEM_USER_PASSWORD).toBe("!")
  })
})
