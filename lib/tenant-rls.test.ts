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
import { RlsTransactionTenantError, rlsQueryHook, withRlsTransactions } from "./tenant-rls"
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

  // One interactive transaction is one connection with one setting: it is
  // bound to one tenant, and a query from another tenant's frame is refused.
  const itx = { transaction: { kind: "itx", id: "tx1" } }
  const tick = () => new Promise((r) => setTimeout(r, 0))

  /** A client whose every interactive transaction records its own set_configs. */
  function perTransactionClient(route?: (params: Parameters<ReturnType<typeof rlsQueryHook>>[0]) => Promise<unknown>) {
    const log: Array<[number, unknown]> = []
    let n = 0
    const client = {
      $executeRaw: vi.fn(() => Promise.resolve(0)),
      $transaction: vi.fn(async (arg: unknown) => {
        if (typeof arg !== "function") return Promise.all(arg as Promise<unknown>[])
        const id = ++n
        const tx = {
          // With `route`, the set_config passes the hook as a transaction
          // query, as Prisma's own $executeRaw on a transaction client does.
          // Lazy like a PrismaPromise: nothing runs until it is awaited.
          $executeRaw: (_s: TemplateStringsArray, ...values: unknown[]) => {
            const run = async () => { log.push([id, values[0] ?? "bypass"]); return 0 }
            return {
              then: (ok: (v: unknown) => unknown, fail: (e: unknown) => unknown) =>
                (route ? route({ args: null, query: run, __internalParams: itx }) : run()).then(ok, fail),
            }
          },
        }
        return arg(tx)
      }),
    }
    return { client: client as unknown as Parameters<typeof rlsQueryHook>[0], log }
  }

  it("refuses a different tenant's frame inside a transaction opened as a tenant, and applies nothing", async () => {
    const { client, log } = perTransactionClient()
    const wrapped = withRlsTransactions(client)
    const hook = rlsQueryHook(client)
    const { params, query } = queryParams(itx)
    await expect(runWithTenant("t1", () => wrapped.$transaction(async () => {
      await hook(queryParams(itx).params)
      await runWithTenant("t9", () => hook(params))
    }))).rejects.toBeInstanceOf(RlsTransactionTenantError)
    expect(query).not.toHaveBeenCalled()
    expect(log).toEqual([[1, "t1"]])
  })

  it("lets the same tenant's frame nest without touching the connection", async () => {
    const { client, log } = perTransactionClient()
    const hook = rlsQueryHook(client)
    await runWithTenant("t1", () => withRlsTransactions(client).$transaction(async () => {
      await runWithTenant("t1", () => hook(queryParams(itx).params))
      await hook(queryParams(itx).params)
    }))
    expect(log).toEqual([[1, "t1"]])
  })

  it("binds a frameless transaction to the first tenant frame inside it, once; a second tenant is refused even concurrently", async () => {
    const ref: { hook?: ReturnType<typeof rlsQueryHook> } = {}
    const { client, log } = perTransactionClient((params) => ref.hook!(params))
    const hook = (ref.hook = rlsQueryHook(client))
    const results = await withRlsTransactions(client).$transaction(async () => Promise.allSettled([
      runWithTenant("t2", async () => { await tick(); return hook(queryParams(itx).params) }),
      runWithTenant("t3", async () => { await tick(); await tick(); return hook(queryParams(itx).params) }),
      runWithTenant("t2", async () => { await tick(); await tick(); return hook(queryParams(itx).params) }),
    ]))
    expect(results.map((r: PromiseSettledResult<unknown>) => r.status)).toEqual(["fulfilled", "rejected", "fulfilled"])
    expect(log).toEqual([[1, "t2"]])
  })

  it("keeps two concurrent requests' transactions apart, through interleaved awaits", async () => {
    const { client, log } = perTransactionClient()
    const wrapped = withRlsTransactions(client)
    const hook = rlsQueryHook(client)
    const request = (tenantId: string, delays: number[]) => runWithTenant(tenantId, () => wrapped.$transaction(async () => {
      for (const d of delays) {
        for (let i = 0; i < d; i++) await tick()
        await hook(queryParams(itx).params)
      }
    }))
    await Promise.all([request("tA", [1, 3, 1]), request("tB", [2, 1, 2])])
    const byTx = (id: number) => log.filter(([t]) => t === id).map(([, v]) => v)
    expect([byTx(1), byTx(2)]).toEqual([["tA"], ["tB"]])
  })

  it("passes through while TENANT_RLS is not on", async () => {
    vi.stubEnv("TENANT_RLS", "off")
    const { client, calls } = fakeClient()
    const results = await runWithTenant("t2", () => withRlsTransactions(client).$transaction([Promise.resolve("a")]))
    expect(results).toEqual(["a"])
    expect(calls).toEqual([])
  })
})
