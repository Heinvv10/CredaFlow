import { PrismaClient } from "@prisma/client"
import { applyTenantScopeExtension } from "./tenant-scope"
import { rlsQueryHook, withRlsTransactions } from "./tenant-rls"

const globalForPrisma = globalThis as unknown as {
  prisma: ReturnType<typeof buildClient> | undefined
}

function buildClient(datasourceUrl?: string) {
  const rewrite = applyTenantScopeExtension()
  const scoped = new PrismaClient(datasourceUrl ? { datasourceUrl } : undefined).$extends({
    name: "tenant-scope",
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          return rewrite({ model, operation, args, query })
        },
      },
    },
  })
  // Innermost: sets the frame's RLS context for the query (lib/tenant-rls.ts).
  const rlsQuery = rlsQueryHook(scoped)
  return withRlsTransactions(
    scoped.$extends({
      name: "tenant-rls",
      query: {
        async $allOperations(params) {
          return rlsQuery(params)
        },
      },
    }),
  )
}

/**
 * The application client against another connection string — integration
 * suites use it to connect as a role that RLS binds (lib/tenant-rls.ts).
 */
export function createAppPrismaClient(datasourceUrl: string) {
  return buildClient(datasourceUrl)
}

export const prisma = globalForPrisma.prisma ?? buildClient()

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma

import { startKeepAlive } from "./db-keepalive"
startKeepAlive()
