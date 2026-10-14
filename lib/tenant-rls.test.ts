/**
 * The RLS hook's coupling to Prisma, pinned without a database.
 *
 * rlsQueryHook tells a query inside a transaction from one outside by
 * `params.__internalParams.transaction`, which Prisma 5.x passes to query
 * extensions but does not type or document (runtime/library.js,
 * _executeRequest). A Prisma upgrade that renames or drops it would make the
 * hook wrap transaction queries in a second, nested batch — the integration
 * suite (lib/tenant-isolation.integration.test.ts) would then fail, and this
 * file says why.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { rlsQueryHook, withRlsTransactions } from "./tenant-rls"
import { runWithTenant, withoutTenantScope } from "./tenant-scope"

type Call = { kind: "raw"; values: unknown[] } | { kind: "query"; args: unknown }

function fakeClient() {
  const calls: Call[] = []
  const transactions: unknown[] = []
  const client = {
    $executeRaw: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
      const call: Call = { kind: "raw", values }
      calls.push(call)
      return Promise.resolve(call)
    }),
    $transaction: vi.fn(async (arg: unknown) => {
      transactions.push(arg)
      if (typeof arg === "function") return arg(client)
      return Promise.all(arg as Promise<unknown>[])
    }),
  }
  // Only $executeRaw and $transaction are used; the full Prisma types are not needed.
  return { client: client as unknown as Parameters<typeof rlsQueryHook>[0], calls, transactions }
}

const queryParams = (internal?: { transaction?: unknown }) => {
  const query = vi.fn(async (args: unknown) => ({ result: args }))
  return { params: { args: { where: { id: "x" } }, query, ...(internal ? { __internalParams: internal } : {}) }, query }
}

beforeEach(() => vi.stubEnv("TENANT_RLS", "on"))
afterEach(() => vi.unstubAllEnvs())

describe("rlsQueryHook", () => {
  it("is a pass-through while TENANT_RLS is not on, frame or no frame", async () => {
    vi.stubEnv("TENANT_RLS", "")
    const { client, transactions } = fakeClient()
    const { params, query } = queryParams()
    await runWithTenant("t1", () => rlsQueryHook(client)(params))
    expect(query).toHaveBeenCalledOnce()
    expect(transactions).toEqual([])
  })

  it("runs a frame query outside a transaction as [set tenant, query]", async () => {
    const { client, calls, transactions } = fakeClient()
    const { params } = queryParams()
    const result = await runWithTenant("t1", () => rlsQueryHook(client)(params))
    expect(result).toEqual({ result: { where: { id: "x" } } })
    expect(transactions).toHaveLength(1)
    expect(calls[0]).toEqual({ kind: "raw", values: ["t1"] })
  })

  it("sets the bypass in a withoutTenantScope frame", async () => {
    const { client, calls } = fakeClient()
    await withoutTenantScope(() => rlsQueryHook(client)(queryParams().params))
    expect(calls).toEqual([{ kind: "raw", values: [] }])
  })

  it("leaves a query that Prisma marks as part of a transaction alone (the __internalParams coupling)", async () => {
    const { client, transactions } = fakeClient()
    const { params, query } = queryParams({ transaction: { kind: "itx", id: "tx1" } })
    await runWithTenant("t1", () => rlsQueryHook(client)(params))
    expect(query).toHaveBeenCalledOnce()
    expect(transactions).toEqual([])
  })

  it("sets nothing without a frame", async () => {
    const { client, transactions } = fakeClient()
    await rlsQueryHook(client)(queryParams().params)
    expect(transactions).toEqual([])
  })
})

describe("withRlsTransactions", () => {
  it("opens an interactive transaction in a frame with the frame's setting first", async () => {
    const { client, calls } = fakeClient()
    const wrapped = withRlsTransactions(client)
    const seen: Call[][] = []
    await runWithTenant("t2", () => wrapped.$transaction(async () => { seen.push([...calls]) }))
    expect(seen[0]).toEqual([{ kind: "raw", values: ["t2"] }])
  })

  it("prepends the setting to a batch and returns only the caller's results", async () => {
    const { client } = fakeClient()
    const wrapped = withRlsTransactions(client)
    const results = await runWithTenant("t2", () => wrapped.$transaction([Promise.resolve("a"), Promise.resolve("b")]))
    expect(results).toEqual(["a", "b"])
  })

  // A frame entered inside an open interactive transaction must reach that
  // transaction's connection: otherwise its queries run under the setting
  // the transaction opened with (another tenant's, or none).
  const itx = { transaction: { kind: "itx", id: "tx1" } }

  it("applies a tenant frame entered inside an open transaction to that transaction, then restores the outer one", async () => {
    const { client, calls } = fakeClient()
    const wrapped = withRlsTransactions(client)
    const hook = rlsQueryHook(client)
    await runWithTenant("t1", () => wrapped.$transaction(async () => {
      await hook(queryParams(itx).params)
      await runWithTenant("t9", () => hook(queryParams(itx).params))
      await hook(queryParams(itx).params)
    }))
    expect(calls.map((c) => c.values)).toEqual([["t1"], ["t9"], ["t1"]])
  })

  it("applies a frame entered inside a transaction that opened with no frame", async () => {
    const { client, calls } = fakeClient()
    const wrapped = withRlsTransactions(client)
    const hook = rlsQueryHook(client)
    await wrapped.$transaction(async () => {
      await runWithTenant("t9", () => hook(queryParams(itx).params))
    })
    expect(calls.map((c) => c.values)).toEqual([["t9"]])
  })

  it("passes through while TENANT_RLS is not on", async () => {
    vi.stubEnv("TENANT_RLS", "off")
    const { client, calls } = fakeClient()
    const results = await runWithTenant("t2", () => withRlsTransactions(client).$transaction([Promise.resolve("a")]))
    expect(results).toEqual(["a"])
    expect(calls).toEqual([])
  })
})
