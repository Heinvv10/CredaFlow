/**
 * An in-memory stand-in for the slice of Prisma the lender bootstrap scripts
 * use, for unit tests. It is NOT evidence that the database accepts a write:
 * the unique keys and transaction rollback are mimicked, triggers and CHECKs
 * are not (bootstrap.integration.test.ts runs against real Postgres).
 */
import type { Prisma, PrismaClient } from "@prisma/client"

type Row = Record<string, unknown>

export type FakeTables = {
  tenants: Row[]
  tenantConfigs: Row[]
  users: Row[]
  auditLogs: Row[]
}

let seq = 0
const nextId = () => `c${String(++seq).padStart(24, "0")}`

export function createFakeDb(seed: Partial<FakeTables> = {}) {
  const tables: FakeTables = {
    tenants: seed.tenants ?? [],
    tenantConfigs: seed.tenantConfigs ?? [],
    users: seed.users ?? [],
    auditLogs: seed.auditLogs ?? [],
  }
  const calls: string[] = []

  const tx = {
    $executeRaw: async () => {
      calls.push("lock")
      return 1
    },
    tenant: {
      findUnique: async ({ where }: { where: { slug?: string; id?: string; domain?: string } }) => {
        const t = tables.tenants.find((r) => (where.slug ? r.slug === where.slug : where.domain ? r.domain === where.domain : r.id === where.id))
        if (!t) return null
        const config = tables.tenantConfigs.find((c) => c.tenantId === t.id) ?? null
        return { ...t, config }
      },
      // The host-rule lookups (lib/config/tenant-domain.ts): slug, domain or domain prefix, optionally excluding an id.
      findFirst: async ({ where }: { where: { slug?: string; domain?: string | { startsWith: string }; NOT?: { id: string } } }) =>
        tables.tenants.find((r) =>
          (where.NOT ? r.id !== where.NOT.id : true) &&
          (where.slug !== undefined ? r.slug === where.slug : true) &&
          (typeof where.domain === "string" ? r.domain === where.domain : true) &&
          (where.domain && typeof where.domain === "object" ? typeof r.domain === "string" && r.domain.startsWith(where.domain.startsWith) : true),
        ) ?? null,
      findMany: async ({ where }: { where: { domain: { startsWith: string } } }) =>
        tables.tenants.filter((r) => typeof r.domain === "string" && r.domain.startsWith(where.domain.startsWith)),
      create: async ({ data }: { data: Row }) => {
        const { config, ...rest } = data
        const row = { id: nextId(), ...rest }
        tables.tenants.push(row)
        if (config) tables.tenantConfigs.push({ id: nextId(), tenantId: row.id, ...(config as { create: Row }).create })
        return row
      },
    },
    tenantConfig: {
      // The instance-jurisdiction check (lib/jurisdiction/instance.server.ts): configs of ACTIVE tenants.
      findMany: async ({ where }: { where: { tenant: { status: string }; tenantId?: { not: string } } }) =>
        tables.tenantConfigs
          .filter((c) => c.tenantId !== where.tenantId?.not)
          .map((c) => ({ c, t: tables.tenants.find((t) => t.id === c.tenantId) }))
          .filter(({ t }) => t?.status === where.tenant.status)
          .map(({ c, t }) => ({ jurisdiction: c.jurisdiction ?? "ZA", currency: c.currency ?? "ZAR", tenant: { slug: t?.slug } })),
      create: async ({ data }: { data: Row }) => {
        const row = { id: nextId(), ...data }
        tables.tenantConfigs.push(row)
        return row
      },
    },
    user: {
      count: async ({ where }: { where: Row }) =>
        tables.users.filter((u) => Object.entries(where).every(([k, v]) => u[k] === v)).length,
      findUnique: async ({ where }: { where: { email?: string; id?: string } }) =>
        tables.users.find((u) => (where.email ? u.email === where.email : u.id === where.id)) ?? null,
      create: async ({ data }: { data: Row }) => {
        if (tables.users.some((u) => u.email === data.email)) throw new Error("Unique constraint failed on email")
        const row = { id: nextId(), tokenVersion: 0, ...data }
        tables.users.push(row)
        return row
      },
      update: async ({ where, data }: { where: { id: string }; data: Row }) => {
        const row = tables.users.find((u) => u.id === where.id)
        if (!row) throw new Error("Record not found")
        for (const [k, v] of Object.entries(data)) {
          const inc = v && typeof v === "object" && "increment" in v ? (v as { increment: number }).increment : null
          row[k] = inc !== null ? (row[k] as number) + inc : v
        }
        return row
      },
    },
    auditLog: {
      create: async ({ data }: { data: Row }) => {
        tables.auditLogs.push({ id: nextId(), ...data })
        return data
      },
    },
  }

  const db = {
    // Like Postgres, a throwing transaction leaves no trace.
    $transaction: async <T>(fn: (t: typeof tx) => Promise<T>): Promise<T> => {
      const snapshot = structuredClone(tables)
      try {
        return await fn(tx)
      } catch (e) {
        Object.assign(tables, snapshot)
        throw e
      }
    },
  }

  return { db: db as unknown as PrismaClient, tables, calls, tx: tx as unknown as Prisma.TransactionClient }
}
