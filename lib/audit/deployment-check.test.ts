import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const query = vi.fn()
vi.mock("@/lib/prisma", () => ({ prisma: { $queryRaw: (...a: unknown[]) => query(...a) } }))

import { auditSetupWarnings } from "./deployment-check"

beforeEach(() => { process.env.AUDIT_CHAIN_KEY = "k".repeat(40) })
afterEach(() => { delete process.env.AUDIT_CHAIN_KEY })

describe("auditSetupWarnings", () => {
  it("is quiet for a non-owner, non-superuser role with a key", async () => {
    query.mockResolvedValue([{ owns: 0, su: false, writes: false }])
    expect(await auditSetupWarnings()).toEqual([])
  })

  it("warns when the runtime role owns the audit tables, is a superuser, or the key is missing", async () => {
    query.mockResolvedValue([{ owns: 2, su: true, writes: true }])
    delete process.env.AUDIT_CHAIN_KEY
    expect(await auditSetupWarnings()).toEqual(["audit_chain_key_missing", "audit_runtime_role_owns_tables", "audit_runtime_role_superuser", "audit_runtime_role_can_write_evidence"])
  })
})
