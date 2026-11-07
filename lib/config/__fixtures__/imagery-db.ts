import { Prisma } from "@prisma/client"
import type { ImageryWriteDb } from "../website-imagery"

export type AuditRow = { tenantId: string; action: string; entity: string; entityId: string | null; oldValue: unknown; newValue: unknown; userId: string | null; userEmail: string | null }

/**
 * In-memory TenantConfig (one row per tenant, holding websiteImagery) whose
 * transaction only commits when the callback returns. `initial` is the raw
 * column per tenant, so a test can start from a document that is not in shape.
 */
export function memoryDb(initial: Record<string, unknown> = {}, opts: { failAudit?: boolean } = {}) {
  const state = { docs: { ...initial } as Record<string, unknown>, audit: [] as AuditRow[], locked: 0 }
  const db = {
    tenantConfig: { findUnique: async ({ where }: { where: { tenantId: string } }) => ({ websiteImagery: state.docs[where.tenantId] ?? null }) },
    async $transaction<T>(fn: (tx: never) => Promise<T>): Promise<T> {
      const staged = { docs: { ...state.docs }, audit: [...state.audit] }
      const tx = {
        $executeRaw: async () => {
          state.locked++
          return 0
        },
        tenantConfig: {
          findUnique: async ({ where }: { where: { tenantId: string } }) => ({ websiteImagery: staged.docs[where.tenantId] ?? null }),
          upsert: async ({ where, update }: { where: { tenantId: string }; update: { websiteImagery: unknown } }) => {
            staged.docs[where.tenantId] = update.websiteImagery === Prisma.DbNull ? null : update.websiteImagery
            return {}
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
      state.docs = staged.docs
      state.audit = staged.audit
      return result
    },
  }
  return { db: db as unknown as ImageryWriteDb, state }
}
