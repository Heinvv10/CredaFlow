/**
 * Postgres row-level security as a backstop to lib/tenant-scope.ts.
 * Off unless TENANT_RLS=on (tenantRlsEnabled below); the policies stay in the
 * database either way.
 *
 * The tenant-scope extension rewrites Prisma model queries; it cannot see raw
 * SQL, nested relation reads or trigger bodies. The RLS policies (migration
 * 20261014130000_tenant_rls) filter every row of the tables they cover by the
 * transaction-local settings this module writes:
 *
 *   app.tenant_id   the tenant the query runs as (a runWithTenant frame)
 *   app.rls_bypass  'on' for an explicit system context (withoutTenantScope)
 *
 * Prisma pools connections, so a setting must never outlive its query: it is
 * written with set_config(…, true) (= SET LOCAL) inside the same transaction
 * as the statement it guards.
 *
 *   - A query outside a transaction, in a frame, runs as a two-statement batch
 *     transaction: [set_config, query].
 *   - An interactive or batch $transaction opened in a frame starts with the
 *     set_config; its queries then run unwrapped (Prisma reports them as part
 *     of a transaction).
 *   - A query with no frame runs as before and sets nothing. The policies let
 *     an unset context through unless the database sets app.rls_strict = 'on'
 *     (ALTER DATABASE … SET), so code that has no frame yet keeps working; see
 *     the migration for what strict mode requires first.
 *
 * Inside a transaction the setting is the one in force when the transaction
 * opened: a frame entered later inside the callback does not change it.
 *
 * RLS binds only a role that is neither a superuser nor BYPASSRLS. The
 * migration FORCEs it, so the table owner is bound too.
 */
import type { PrismaClient } from "@prisma/client"
import { AsyncLocalStorage } from "node:async_hooks"
import { tenantContext } from "./tenant-scope"

export type RlsSetting = { kind: "tenant"; tenantId: string } | { kind: "bypass" }

/**
 * TENANT_RLS=on turns the hook on. Off (the default) it costs nothing: while
 * the application connects as a superuser — every stack today — Postgres
 * skips the policies anyway, and the hook's batch transactions would add
 * round trips for no protection. Read per call so a test can switch it.
 */
export function tenantRlsEnabled(): boolean {
  return process.env.TENANT_RLS === "on"
}

/**
 * The RLS setting the current ALS frame asks for, or null when there is no
 * frame or the hook is off.
 */
export function currentRlsSetting(): RlsSetting | null {
  if (!tenantRlsEnabled()) return null
  const frame = tenantContext.getStore()
  if (!frame) return null
  return frame.kind === "admin" ? { kind: "bypass" } : { kind: "tenant", tenantId: frame.tenantId }
}

type RawCapable = Pick<PrismaClient, "$executeRaw">

/** The statement that applies `setting` (null: no context) to the current transaction only. */
export function applyRlsSetting(db: RawCapable, setting: RlsSetting | null) {
  if (setting?.kind === "tenant") {
    return db.$executeRaw`SELECT set_config('app.tenant_id', ${setting.tenantId}, true), set_config('app.rls_bypass', 'off', true)`
  }
  return setting?.kind === "bypass"
    ? db.$executeRaw`SELECT set_config('app.tenant_id', '', true), set_config('app.rls_bypass', 'on', true)`
    : db.$executeRaw`SELECT set_config('app.tenant_id', '', true), set_config('app.rls_bypass', 'off', true)`
}

const settingKey = (s: RlsSetting | null) => (s === null ? "none" : s.kind === "bypass" ? "bypass" : `tenant:${s.tenantId}`)

/**
 * The open interactive transaction this code runs inside, and the setting
 * last applied to it. A frame entered inside the transaction's callback
 * (runWithTenant / withoutTenantScope) differs from it; the hook then applies
 * the new frame to the transaction before the query, and the outer frame
 * again when the code returns to it.
 */
type OpenTransaction = { tx: RawCapable; applied: string }
const globalForRls = globalThis as unknown as { rlsTransaction?: AsyncLocalStorage<OpenTransaction> }
const openTransaction = (globalForRls.rlsTransaction ??= new AsyncLocalStorage<OpenTransaction>())

// Prisma's query-extension and $transaction signatures are generic per model
// and per overload; this seam forwards them unchanged, so `any` is confined
// here as in lib/tenant-scope.ts.
/* eslint-disable @typescript-eslint/no-explicit-any */
type QueryParams = {
  args: any
  query: (args: any) => Promise<any>
  /** Prisma passes the transaction a query belongs to; not part of its public type. */
  __internalParams?: { transaction?: unknown }
}

type BaseClient = RawCapable & { $transaction: (...a: any[]) => Promise<any> }

/**
 * The innermost query hook: wraps a query that runs in a frame but outside any
 * transaction in [set_config, query]. `base` must be the client being extended
 * (not the result), so the set_config statement does not re-enter this hook.
 *
 * "Inside a transaction" is read from `__internalParams.transaction`, which
 * Prisma 5.x passes to query extensions without typing it. Pinned by
 * lib/tenant-rls.test.ts; re-check it on every Prisma major upgrade.
 */
export function rlsQueryHook(base: BaseClient) {
  return async function rlsQuery(params: QueryParams) {
    const setting = currentRlsSetting()
    if (params.__internalParams?.transaction) {
      const open = tenantRlsEnabled() ? openTransaction.getStore() : undefined
      if (open && open.applied !== settingKey(setting)) {
        open.applied = settingKey(setting) // before the await: the set_config passes this hook too
        await applyRlsSetting(open.tx, setting)
      }
      return params.query(params.args)
    }
    if (!setting) return params.query(params.args)
    const [, result] = await base.$transaction([applyRlsSetting(base, setting), params.query(params.args)])
    return result
  }
}

/**
 * Returns `client` with $transaction opening every transaction started in a
 * frame with that frame's RLS setting, and tracking interactive ones so a
 * frame entered inside them is applied too. Off (TENANT_RLS) it passes through.
 */
export function withRlsTransactions<C extends BaseClient>(client: C): C {
  const transaction = (arg: any, options?: any) => {
    if (!tenantRlsEnabled()) return client.$transaction(arg, options)
    const setting = currentRlsSetting()
    if (typeof arg === "function") {
      return client.$transaction(async (tx: RawCapable) => {
        if (setting) await applyRlsSetting(tx, setting)
        return openTransaction.run({ tx, applied: settingKey(setting) }, () => arg(tx))
      }, options)
    }
    if (!setting) return client.$transaction(arg, options)
    return client.$transaction([applyRlsSetting(client, setting), ...arg], options)
      .then((results: unknown[]) => results.slice(1))
  }
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === "$transaction") return transaction
      return Reflect.get(target, prop, receiver)
    },
  })
}
/* eslint-enable @typescript-eslint/no-explicit-any */
