import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  formatIdentityDate,
  parseLenderIdentity,
  validateLenderIdentityColumns,
} from "./identity-schema"
import { updateLenderIdentity, type IdentityWriteDb } from "./identity-write"
import { VALID_LENDER_COLUMNS } from "./__fixtures__/lender-identity"

// Decision: four optional regulatory details for the public
// regulatory-information page. Real calendar dates, never in the future; a
// closed status list; a printable city. Not typed twice, but audited.

const REGULATORY = {
  ncrRegistrationDate: "2025-10-07",
  fscaAuthorisationDate: "2026-02-27",
  ncrStatus: "Registered",
  headOfficeCity: "Sandton",
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(new Date("2026-10-09T08:00:00Z"))
})
afterEach(() => {
  vi.useRealTimers()
})

describe("regulatory identity columns", () => {
  it("are optional: an identity without them is valid and reads them as null", () => {
    const parsed = validateLenderIdentityColumns({ ...VALID_LENDER_COLUMNS, ncrRegistrationDate: undefined, ncrStatus: undefined })
    expect(parsed).toMatchObject({
      ok: true,
      columns: { ncrRegistrationDate: null, fscaAuthorisationDate: null, ncrStatus: null, headOfficeCity: null },
    })
    expect(parseLenderIdentity(VALID_LENDER_COLUMNS)).toMatchObject({
      ncrRegistrationDate: null, fscaAuthorisationDate: null, ncrStatus: null, headOfficeCity: null,
    })
  })

  it("accept valid values and read them through to the identity", () => {
    const parsed = validateLenderIdentityColumns({ ...VALID_LENDER_COLUMNS, ...REGULATORY })
    expect(parsed).toEqual({ ok: true, columns: { ...VALID_LENDER_COLUMNS, ...REGULATORY } })
    expect(parseLenderIdentity({ ...VALID_LENDER_COLUMNS, ...REGULATORY })).toMatchObject(REGULATORY)
  })

  it("read a stored DATE (Prisma returns a Date at UTC midnight) as the same calendar day", () => {
    const identity = parseLenderIdentity({
      ...VALID_LENDER_COLUMNS,
      ncrRegistrationDate: new Date("2025-10-07T00:00:00.000Z") as unknown as string,
    })
    expect(identity.ncrRegistrationDate).toBe("2025-10-07")
  })

  it("accept today, in South African time", () => {
    vi.setSystemTime(new Date("2026-10-08T23:30:00Z")) // 01:30 on 9 Oct in Johannesburg
    expect(validateLenderIdentityColumns({ ...VALID_LENDER_COLUMNS, ncrRegistrationDate: "2026-10-09" }).ok).toBe(true)
  })

  it.each([
    ["ncrRegistrationDate", "2025-02-30"],
    ["ncrRegistrationDate", "2025-13-01"],
    ["ncrRegistrationDate", "07/10/2025"],
    ["ncrRegistrationDate", "2026-10-10"], // tomorrow
    ["fscaAuthorisationDate", "2026-02-29"], // 2026 is not a leap year
    ["fscaAuthorisationDate", "2030-01-01"],
    ["ncrStatus", "Active"],
    ["ncrStatus", "registered"],
    ["headOfficeCity", "S"],
    ["headOfficeCity", "x".repeat(61)],
    ["headOfficeCity", "Sandton\u{1F600}"],
  ] as const)("reject an invalid %s (%j) with an error on that field only", (field, value) => {
    const parsed = validateLenderIdentityColumns({ ...VALID_LENDER_COLUMNS, ...REGULATORY, [field]: value })
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(Object.keys(parsed.errors)).toEqual([field])
  })

  it("format a stored date the way the regulatory page prints it", () => {
    expect(formatIdentityDate("2025-10-07")).toBe("7 October 2025")
    expect(formatIdentityDate("2026-02-27")).toBe("27 February 2026")
  })
})

type AuditRow = { action: string; oldValue: unknown; newValue: unknown }

function memoryDb(initial: Record<string, unknown> | null) {
  const state = { config: initial, audit: [] as AuditRow[], upserts: [] as Record<string, unknown>[] }
  const db = {
    async $transaction<T>(fn: (tx: never) => Promise<T>): Promise<T> {
      const tx = {
        $executeRaw: async () => 0,
        tenantConfig: {
          findUnique: async () => state.config,
          upsert: async ({ update, create }: { update: Record<string, unknown>; create: Record<string, unknown> }) => {
            state.upserts.push(state.config ? update : create)
            state.config = state.config ? { ...state.config, ...update } : { ...create }
            return state.config
          },
        },
        auditLog: { create: async ({ data }: { data: AuditRow }) => (state.audit.push(data), data) },
      }
      return fn(tx as never)
    },
  }
  return { db: db as unknown as IdentityWriteDb, state }
}

const ACTOR = { id: "admin-1", email: "admin@acme-lending.example" }
// The statutory numbers are unchanged below, so no confirmation is needed:
// the regulatory details are not typed twice.
const STORED = { ...VALID_LENDER_COLUMNS, ncrRegistrationDate: null, fscaAuthorisationDate: null, ncrStatus: null, headOfficeCity: null }

describe("updateLenderIdentity with regulatory details", () => {
  it("stores dates as DATE values, without a confirmation, and audits old and new", async () => {
    const { db, state } = memoryDb(STORED)
    const result = await updateLenderIdentity(db, { tenantId: "t1", actor: ACTOR, input: { ...VALID_LENDER_COLUMNS, ...REGULATORY } })
    expect(result).toMatchObject({ ok: true, changed: true })
    expect(state.upserts[0]).toEqual({
      ncrRegistrationDate: new Date("2025-10-07T00:00:00.000Z"),
      fscaAuthorisationDate: new Date("2026-02-27T00:00:00.000Z"),
      ncrStatus: "Registered",
      headOfficeCity: "Sandton",
    })
    expect(state.audit).toHaveLength(1)
    expect(state.audit[0]).toMatchObject({
      action: "LENDER_IDENTITY_UPDATED",
      oldValue: { ncrRegistrationDate: null, fscaAuthorisationDate: null, ncrStatus: null, headOfficeCity: null },
      newValue: { ...REGULATORY, ncrRegistrationDate: "2025-10-07", fscaAuthorisationDate: "2026-02-27" },
    })
  })

  it("treats a stored DATE equal to the submitted day as unchanged", async () => {
    const { db, state } = memoryDb({
      ...STORED, ...REGULATORY,
      ncrRegistrationDate: new Date("2025-10-07T00:00:00.000Z"),
      fscaAuthorisationDate: new Date("2026-02-27T00:00:00.000Z"),
    })
    const result = await updateLenderIdentity(db, { tenantId: "t1", actor: ACTOR, input: { ...VALID_LENDER_COLUMNS, ...REGULATORY } })
    expect(result).toMatchObject({ ok: true, changed: false })
    expect(state.upserts).toHaveLength(0)
    expect(state.audit).toHaveLength(0)
  })

  it("returns per-field errors and writes nothing for an invalid date, a future date and a bad status", async () => {
    const { db, state } = memoryDb(STORED)
    const result = await updateLenderIdentity(db, {
      tenantId: "t1", actor: ACTOR,
      input: { ...VALID_LENDER_COLUMNS, ncrRegistrationDate: "2025-02-30", fscaAuthorisationDate: "2027-01-01", ncrStatus: "Active" },
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(Object.keys(result.errors).sort()).toEqual(["fscaAuthorisationDate", "ncrRegistrationDate", "ncrStatus"])
    expect(state.upserts).toHaveLength(0)
    expect(state.audit).toHaveLength(0)
  })
})
