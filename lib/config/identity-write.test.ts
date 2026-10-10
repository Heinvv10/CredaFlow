import { describe, expect, it } from "vitest"
import { updateLenderIdentity, type IdentityWriteDb } from "./identity-write"
import type { LenderIdentityColumns } from "./identity"
import { VALID_LENDER_COLUMNS } from "./__fixtures__/lender-identity"

const ACTOR = { id: "admin-1", email: "admin@acme-lending.example" }

const CONFIRMED = {
  ...VALID_LENDER_COLUMNS,
  ncrNumberConfirm: VALID_LENDER_COLUMNS.ncrNumber,
  fscaNumberConfirm: VALID_LENDER_COLUMNS.fscaNumber,
  companyRegNumberConfirm: VALID_LENDER_COLUMNS.companyRegNumber,
}

type AuditRow = { action: string; entityId: string | null; oldValue: unknown; newValue: unknown; userId: string | null }

/**
 * In-memory stand-in with real transaction semantics: writes made inside
 * `$transaction` are staged and only become visible if the callback returns.
 * That is what lets "not persisted" be asserted rather than assumed.
 */
function memoryDb(initial: Partial<LenderIdentityColumns> | null, opts: { failAudit?: boolean } = {}) {
  const state = { config: initial ? { ...initial } : null as Record<string, unknown> | null, audit: [] as AuditRow[] }
  const locks: string[] = []
  const db = {
    async $transaction<T>(fn: (tx: never) => Promise<T>): Promise<T> {
      const staged = { config: state.config ? { ...state.config } : null, audit: [...state.audit] }
      const tx = {
        $executeRaw: async () => {
          locks.push("TenantConfig")
          return 0
        },
        tenantConfig: {
          findUnique: async () => staged.config,
          upsert: async ({ update, create }: { update: Record<string, unknown>; create: Record<string, unknown> }) => {
            staged.config = staged.config ? { ...staged.config, ...update } : { ...create }
            return staged.config
          },
        },
        auditLog: {
          create: async ({ data }: { data: AuditRow }) => {
            if (opts.failAudit) throw new Error("audit insert failed")
            staged.audit.push(data)
            return data
          },
        },
      }
      const result = await fn(tx as never)
      state.config = staged.config
      state.audit = staged.audit
      return result
    },
  }
  return { db: db as unknown as IdentityWriteDb, state, locks }
}

describe("updateLenderIdentity", () => {
  it("persists a valid identity and writes one audit row with old and new values", async () => {
    const { db, state, locks } = memoryDb(null)
    const result = await updateLenderIdentity(db, { tenantId: "t1", actor: ACTOR, input: CONFIRMED })
    expect(result).toMatchObject({ ok: true, changed: true })
    expect(locks).toEqual(["TenantConfig"])
    expect(state.config).toMatchObject({ ncrNumber: "NCRCP99999", legalName: "Acme Lending (Pty) Ltd" })
    expect(state.audit).toHaveLength(1)
    expect(state.audit[0]).toMatchObject({
      action: "LENDER_IDENTITY_UPDATED",
      entityId: "t1",
      userId: "admin-1",
      newValue: expect.objectContaining({ ncrNumber: "NCRCP99999" }),
      oldValue: expect.objectContaining({ ncrNumber: null }),
    })
  })

  it("rejects an invalid NCR number and persists nothing", async () => {
    const { db, state } = memoryDb(null)
    const result = await updateLenderIdentity(db, {
      tenantId: "t1", actor: ACTOR,
      input: { ...CONFIRMED, ncrNumber: "NCR99999", ncrNumberConfirm: "NCR99999" },
    })
    expect(result).toMatchObject({ ok: false, errors: { ncrNumber: expect.any(String) } })
    expect(state.config).toBeNull()
    expect(state.audit).toHaveLength(0)
  })

  it.each(["legalName", "fscaNumber", "companyRegNumber", "publicEmail"] as const)(
    "rejects a missing %s and persists nothing",
    async (field) => {
      const { db, state } = memoryDb(VALID_LENDER_COLUMNS)
      const result = await updateLenderIdentity(db, { tenantId: "t1", actor: ACTOR, input: { ...CONFIRMED, [field]: "" } })
      expect(result.ok).toBe(false)
      expect(state.config).toEqual(VALID_LENDER_COLUMNS)
      expect(state.audit).toHaveLength(0)
    },
  )

  // The original defect was a transposed digit, which every format check accepts. A change
  // to a statutory number must be typed twice.
  it("rejects a statutory number change whose confirmation differs (transposed digit)", async () => {
    const { db, state } = memoryDb(VALID_LENDER_COLUMNS)
    const result = await updateLenderIdentity(db, {
      tenantId: "t1", actor: ACTOR,
      input: { ...VALID_LENDER_COLUMNS, ncrNumber: "NCRCP99919", ncrNumberConfirm: "NCRCP99199" },
    })
    expect(result).toMatchObject({ ok: false, errors: { ncrNumberConfirm: expect.any(String) } })
    expect(state.config).toEqual(VALID_LENDER_COLUMNS)
    expect(state.audit).toHaveLength(0)
  })

  it.each(["ncrNumber", "fscaNumber", "companyRegNumber"] as const)(
    "rejects a %s change with no confirmation",
    async (field) => {
      const next = { ncrNumber: "NCRCP11111", fscaNumber: "54321", companyRegNumber: "2021/654321/07" }[field]
      const { db, state } = memoryDb(VALID_LENDER_COLUMNS)
      const result = await updateLenderIdentity(db, { tenantId: "t1", actor: ACTOR, input: { ...VALID_LENDER_COLUMNS, [field]: next } })
      expect(result).toMatchObject({ ok: false, errors: { [`${field}Confirm`]: expect.any(String) } })
      expect(state.audit).toHaveLength(0)
    },
  )

  it("does not demand a confirmation when the statutory numbers are unchanged", async () => {
    const { db, state } = memoryDb(VALID_LENDER_COLUMNS)
    const result = await updateLenderIdentity(db, {
      tenantId: "t1", actor: ACTOR,
      input: { ...VALID_LENDER_COLUMNS, publicEmail: "info@acme-lending.example" },
    })
    expect(result).toMatchObject({ ok: true, changed: true })
    expect(state.config).toMatchObject({ publicEmail: "info@acme-lending.example" })
    expect(state.audit).toHaveLength(1)
    expect(state.audit[0].oldValue).toEqual({ publicEmail: "hello@acme-lending.example" })
    expect(state.audit[0].newValue).toEqual({ publicEmail: "info@acme-lending.example" })
  })

  it("writes nothing and audits nothing when the identity is unchanged", async () => {
    const { db, state } = memoryDb(VALID_LENDER_COLUMNS)
    const result = await updateLenderIdentity(db, { tenantId: "t1", actor: ACTOR, input: VALID_LENDER_COLUMNS })
    expect(result).toMatchObject({ ok: true, changed: false })
    expect(state.audit).toHaveLength(0)
  })

  it("does not commit the change when the audit row cannot be written", async () => {
    const { db, state } = memoryDb(null, { failAudit: true })
    await expect(updateLenderIdentity(db, { tenantId: "t1", actor: ACTOR, input: CONFIRMED })).rejects.toThrow("audit insert failed")
    expect(state.config).toBeNull()
  })

  it("rejects a non-object body", async () => {
    const { db, state } = memoryDb(null)
    for (const input of [null, "x", 42, []]) {
      expect((await updateLenderIdentity(db, { tenantId: "t1", actor: ACTOR, input })).ok).toBe(false)
    }
    expect(state.audit).toHaveLength(0)
  })
})
