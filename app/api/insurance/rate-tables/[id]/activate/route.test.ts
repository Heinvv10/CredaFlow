// app/api/insurance/rate-tables/[id]/activate/route.test.ts
//
// Activation is the moment a rate card starts pricing real policies. Two
// invariants matter more than anything else on this route:
//
//   1. a product NEVER has two ACTIVE tables — the retire and the activate
//      happen inside ONE transaction, so there is no window in which a quote
//      could resolve two rate cards (or none);
//   2. an EMPTY table can never go ACTIVE — it would price nothing while
//      satisfying every readiness check that only asks "is there an ACTIVE
//      table?".
import { afterEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const {
  findFirstTable,
  txFindFirstTable,
  txUpdateMany,
  txUpdate,
  txCount,
  txQueryRaw,
  prismaTransaction,
  callOrder,
  logAudit,
} = vi.hoisted(() => {
  const callOrder: string[] = []
  return {
    callOrder,
    findFirstTable: vi.fn(),
    txFindFirstTable: vi.fn(),
    txUpdateMany: vi.fn(),
    txUpdate: vi.fn(),
    txCount: vi.fn(),
    txQueryRaw: vi.fn(),
    prismaTransaction: vi.fn(),
    logAudit: vi.fn().mockResolvedValue(undefined),
  }
})

vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantConfig: { findUnique: async () => ({ featureCrm: false, featureIms: true }) },
    insuranceRateTable: { findFirst: findFirstTable },
    $transaction: prismaTransaction,
  },
}))

vi.mock("@/lib/tenant", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant")>()),
  withTenantContext: (_req: unknown, fn: (t: { id: string; name: string }) => unknown) =>
    fn({ id: "tenant-1", name: "Test Tenant" }),
}))

vi.mock("@/lib/auth-guards", () => ({
  requireApiRole: vi.fn().mockResolvedValue({
    user: { id: "user-1", email: "officer@acme-lending.example" },
  }),
}))

vi.mock("@/lib/audit", () => ({
  logAudit,
  AuditAction: new Proxy({}, { get: (_t, k) => String(k) }),
}))

import { POST } from "./route"

const ctx = { params: Promise.resolve({ id: "table-1" }) }
const url = "http://localhost/api/insurance/rate-tables/table-1/activate"
const req = () => new NextRequest(url, { method: "POST" })

/** A transaction client whose calls are recorded in order. */
const tx = {
  $queryRaw: (...args: unknown[]) => {
    callOrder.push("$queryRaw")
    return txQueryRaw(...args)
  },
  insuranceRateTable: {
    findFirst: (...args: unknown[]) => {
      callOrder.push("findFirst")
      return txFindFirstTable(...args)
    },
    updateMany: (...args: unknown[]) => {
      callOrder.push("updateMany")
      return txUpdateMany(...args)
    },
    update: (...args: unknown[]) => {
      callOrder.push("update")
      return txUpdate(...args)
    },
    count: (...args: unknown[]) => {
      callOrder.push("count")
      return txCount(...args)
    },
  },
}

afterEach(() => {
  vi.clearAllMocks()
  callOrder.length = 0
})

function arrangeHappyPath() {
  findFirstTable.mockResolvedValue({
    id: "table-1",
    status: "DRAFT",
    productId: "product-1",
    version: 3,
    _count: { bands: 4 },
  })
  // Two locks, in order: the PRODUCT row, then the rate-table row being
  // activated. See the ordering note in rate-table-lock.ts.
  txQueryRaw
    .mockResolvedValueOnce([{ id: "product-1" }])
    .mockResolvedValueOnce([{ id: "table-1", status: "DRAFT", productId: "product-1", basis: "AGE_BANDED" }])
  // A draft the operator dated in the future — the D5 case. Nothing in the
  // create route stops them entering it.
  txFindFirstTable.mockResolvedValue({
    id: "table-1",
    effectiveFrom: new Date("2027-01-01T00:00:00Z"),
    _count: { bands: 4 },
  })
  txUpdateMany.mockResolvedValue({ count: 1 })
  txUpdate.mockResolvedValue({ id: "table-1", status: "ACTIVE", version: 3 })
  txCount.mockResolvedValue(1)
  prismaTransaction.mockImplementation(async (fn: (c: typeof tx) => unknown) => fn(tx))
}

describe("POST /api/insurance/rate-tables/[id]/activate", () => {
  it("404s a table belonging to another tenant", async () => {
    arrangeHappyPath()
    findFirstTable.mockResolvedValue(null)

    const res = await POST(req(), ctx)

    expect(res.status).toBe(404)
    expect(prismaTransaction).not.toHaveBeenCalled()
    expect(findFirstTable.mock.calls[0][0].where).toEqual({ id: "table-1", tenantId: "tenant-1" })
  })

  it("refuses to activate a table with zero bands", async () => {
    arrangeHappyPath()
    findFirstTable.mockResolvedValue({
      id: "table-1",
      status: "DRAFT",
      productId: "product-1",
      version: 1,
      _count: { bands: 0 },
    })

    const res = await POST(req(), ctx)

    expect(res.status).toBe(422)
    expect(prismaTransaction).not.toHaveBeenCalled()
  })

  it("refuses to re-activate an already ACTIVE table with 409", async () => {
    arrangeHappyPath()
    findFirstTable.mockResolvedValue({
      id: "table-1",
      status: "ACTIVE",
      productId: "product-1",
      version: 1,
      _count: { bands: 4 },
    })

    const res = await POST(req(), ctx)

    expect(res.status).toBe(409)
    expect(prismaTransaction).not.toHaveBeenCalled()
  })

  it("refuses to activate a RETIRED table with 409", async () => {
    arrangeHappyPath()
    findFirstTable.mockResolvedValue({
      id: "table-1",
      status: "RETIRED",
      productId: "product-1",
      version: 1,
      _count: { bands: 4 },
    })

    const res = await POST(req(), ctx)

    expect(res.status).toBe(409)
    expect(prismaTransaction).not.toHaveBeenCalled()
  })

  it("retires the prior ACTIVE table and activates this one in ONE transaction", async () => {
    arrangeHappyPath()

    const res = await POST(req(), ctx)

    expect(res.status).toBe(200)
    expect(prismaTransaction).toHaveBeenCalledTimes(1)

    // Every write happened on the transaction client, in order, behind the
    // product row lock and followed by the single-ACTIVE assertion.
    // Two $queryRaw calls: the product lock, then the rate-table lock.
    expect(callOrder).toEqual(["$queryRaw", "$queryRaw", "findFirst", "updateMany", "update", "count"])

    // The retirement targets the OTHER currently-ACTIVE tables for this
    // product in this tenant, and stamps effectiveTo.
    const retire = txUpdateMany.mock.calls[0][0]
    expect(retire.where).toMatchObject({
      tenantId: "tenant-1",
      productId: "product-1",
      status: "ACTIVE",
    })
    expect(retire.data.status).toBe("RETIRED")
    expect(retire.data.effectiveTo).toBeInstanceOf(Date)

    // ...and this table becomes the single ACTIVE one.
    const activate = txUpdate.mock.calls[0][0]
    expect(activate.where).toEqual({ id: "table-1" })
    expect(activate.data).toMatchObject({ status: "ACTIVE", effectiveTo: null })
  })

  it("loses the race safely: a table already flipped out of DRAFT inside the transaction is 409, not a second ACTIVE", async () => {
    arrangeHappyPath()
    // The pre-check saw DRAFT; by the time the transaction re-read it under
    // the row lock, a concurrent activation had already taken it.
    txFindFirstTable.mockResolvedValue(null)

    const res = await POST(req(), ctx)

    expect(res.status).toBe(409)
    expect(txUpdateMany).not.toHaveBeenCalled()
    expect(txUpdate).not.toHaveBeenCalled()
  })

  it("re-reads the row inside the transaction with the DRAFT status in the WHERE clause", async () => {
    arrangeHappyPath()

    await POST(req(), ctx)

    expect(txFindFirstTable.mock.calls[0][0].where).toEqual({
      id: "table-1",
      tenantId: "tenant-1",
      status: "DRAFT",
    })
  })

  it("audits the activation", async () => {
    arrangeHappyPath()

    await POST(req(), ctx)

    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-1",
        action: "INSURANCE_RATE_TABLE_ACTIVATED",
        entity: "InsuranceRateTable",
        entityId: "table-1",
      })
    )
  })
})

// D4 — the `fresh` re-read only guards the SAME table being activated twice.
// With drafts A and B on one product and C live, under READ COMMITTED: T1
// retires C and sets A ACTIVE uncommitted; T2 reads B as DRAFT (T1 never
// touched it) and its own updateMany cannot see A, so it blocks on C alone;
// when T1 commits, T2 re-evaluates C, finds it RETIRED, matches nothing, and
// sets B ACTIVE. A and B are then both ACTIVE and every quote for the product
// fails. There is no DB constraint against it — the only unique index is
// (tenantId, productId, version).
describe("POST /api/insurance/rate-tables/[id]/activate — two concurrent activations", () => {
  it("locks the PRODUCT row as the first statement in the transaction", async () => {
    arrangeHappyPath()

    await POST(req(), ctx)

    expect(callOrder[0]).toBe("$queryRaw")
    const sql = txQueryRaw.mock.calls[0][0]
    expect(String(sql.sql ?? sql)).toMatch(/FROM "InsuranceProduct"[\s\S]*FOR UPDATE/)
    // Serialisation is per PRODUCT, not per table: the two racing requests
    // activate DIFFERENT tables, so a lock on the table proves nothing.
    expect(sql.values).toEqual(["product-1", "tenant-1"])
  })

  it("rolls back with 409 when the transaction would leave more than one ACTIVE table", async () => {
    arrangeHappyPath()
    txCount.mockResolvedValue(2)

    const res = await POST(req(), ctx)

    expect(res.status).toBe(409)
    // The audit row must not claim an activation the transaction rolled back.
    expect(logAudit).not.toHaveBeenCalled()
  })

  it("rolls back with 409 when the transaction would leave NO active table", async () => {
    arrangeHappyPath()
    txCount.mockResolvedValue(0)

    const res = await POST(req(), ctx)

    expect(res.status).toBe(409)
    expect(logAudit).not.toHaveBeenCalled()
  })

  it("counts ACTIVE tables for the product inside the transaction", async () => {
    arrangeHappyPath()

    await POST(req(), ctx)

    expect(txCount.mock.calls[0][0].where).toEqual({
      tenantId: "tenant-1",
      productId: "product-1",
      status: "ACTIVE",
    })
  })
})

// D5 — `effectiveFrom` is caller-supplied at create and validated only for NaN.
// Activating a table dated 2027 used to set status ACTIVE and leave
// effectiveFrom untouched; `resolveActiveRateTable` filters effectiveFrom <= at,
// so the successor was excluded and the product reported NOT_CONFIGURED — while
// a 200 and an audit row said it had been activated. The product silently
// stopped being sellable.
describe("POST /api/insurance/rate-tables/[id]/activate — when cover actually starts", () => {
  it("stamps effectiveFrom at the activation instant, overriding a future date on the draft", async () => {
    arrangeHappyPath()

    await POST(req(), ctx)

    const activate = txUpdate.mock.calls[0][0]
    expect(activate.data.effectiveFrom).toBeInstanceOf(Date)
    // Not the 2027 date the operator typed into the draft.
    expect(activate.data.effectiveFrom.getTime()).not.toBe(
      new Date("2027-01-01T00:00:00Z").getTime()
    )
    expect(activate.data.effectiveFrom.getTime()).toBeLessThanOrEqual(Date.now())
  })

  it("retires the predecessor at the EXACT instant the successor starts, leaving no gap and no overlap", async () => {
    arrangeHappyPath()

    await POST(req(), ctx)

    // effectiveTo is exclusive (gt) and effectiveFrom inclusive (lte) in
    // activeRateTableFindManyArgs, so one shared instant resolves to exactly
    // one table at every point in time. Two separate `new Date()` calls would
    // leave a microsecond in which neither table is in force.
    const retiredAt = txUpdateMany.mock.calls[0][0].data.effectiveTo
    const startedAt = txUpdate.mock.calls[0][0].data.effectiveFrom
    expect(startedAt.getTime()).toBe(retiredAt.getTime())
  })

  it("records the overridden date in the audit trail, so the override is not silent", async () => {
    arrangeHappyPath()

    await POST(req(), ctx)

    const audited = logAudit.mock.calls[0][0]
    expect(audited.oldValue.effectiveFrom).toEqual(new Date("2027-01-01T00:00:00Z"))
    expect(audited.newValue.effectiveFrom).toBeInstanceOf(Date)
  })
})

// The zero-band refusal was read OUTSIDE the transaction and never re-asserted
// inside it, and the two locks in play did not exclude each other: activation
// locked the PRODUCT row while band writes locked the RATE TABLE row —
// different rows. So `DELETE /rate-tables/X/bands/<last band>` could commit
// between activation's `_count` read and its update. Activation then committed
// X as ACTIVE with zero bands, having already RETIRED the card that was live,
// and the product dropped to NO_BANDS with nothing to fall back to.
describe("POST /api/insurance/rate-tables/[id]/activate — the empty-card race", () => {
  it("locks the PRODUCT row and then the RATE TABLE row, in that order", async () => {
    arrangeHappyPath()

    await POST(req(), ctx)

    expect(txQueryRaw).toHaveBeenCalledTimes(2)
    const product = txQueryRaw.mock.calls[0][0]
    const table = txQueryRaw.mock.calls[1][0]

    expect(String(product.sql ?? product)).toMatch(/FROM "InsuranceProduct"[\s\S]*FOR UPDATE/)
    expect(product.values).toEqual(["product-1", "tenant-1"])

    // The SAME row every band write serialises on, so a band delete can no
    // longer commit inside this transaction's window.
    expect(String(table.sql ?? table)).toMatch(/FROM "InsuranceRateTable"[\s\S]*FOR UPDATE/)
    expect(table.values).toEqual(["table-1", "tenant-1"])
  })

  it("re-counts the bands INSIDE the transaction and refuses an emptied card with 422", async () => {
    arrangeHappyPath()
    // The pre-transaction read saw 4 bands; by the time the lock was held the
    // last one had been deleted.
    txFindFirstTable.mockResolvedValue({
      id: "table-1",
      effectiveFrom: new Date("2027-01-01T00:00:00Z"),
      _count: { bands: 0 },
    })

    const res = await POST(req(), ctx)

    expect(res.status).toBe(422)
    // Nothing was retired: the live card must survive a refused activation.
    expect(txUpdateMany).not.toHaveBeenCalled()
    expect(txUpdate).not.toHaveBeenCalled()
    expect(logAudit).not.toHaveBeenCalled()
  })

  it("audits the band count the transaction actually saw, not the stale pre-read", async () => {
    arrangeHappyPath()
    txFindFirstTable.mockResolvedValue({
      id: "table-1",
      effectiveFrom: new Date("2027-01-01T00:00:00Z"),
      _count: { bands: 2 },
    })

    await POST(req(), ctx)

    expect(logAudit.mock.calls[0][0].newValue.bands).toBe(2)
  })

  it("409s when the rate-table lock finds the row no longer DRAFT", async () => {
    arrangeHappyPath()
    txQueryRaw
      .mockReset()
      .mockResolvedValueOnce([{ id: "product-1" }])
      .mockResolvedValueOnce([{ id: "table-1", status: "ACTIVE", productId: "product-1", basis: "AGE_BANDED" }])

    const res = await POST(req(), ctx)

    expect(res.status).toBe(409)
    expect(txUpdateMany).not.toHaveBeenCalled()
    expect(logAudit).not.toHaveBeenCalled()
  })

  it("404s rather than proceeding unlocked when the product row does not exist", async () => {
    // `SELECT … FOR UPDATE` matching zero rows takes NO lock and raises
    // nothing. Discarding that answer would run the whole activation with its
    // sole serialisation guard silently absent.
    arrangeHappyPath()
    txQueryRaw.mockReset().mockResolvedValueOnce([])

    const res = await POST(req(), ctx)

    expect(res.status).toBe(404)
    expect(txUpdateMany).not.toHaveBeenCalled()
    expect(txUpdate).not.toHaveBeenCalled()
    expect(logAudit).not.toHaveBeenCalled()
  })
})
