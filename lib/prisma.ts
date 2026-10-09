import { PrismaClient } from "@prisma/client"
import { applyTenantScopeExtension } from "./tenant-scope"

const globalForPrisma = globalThis as unknown as {
  prisma: ReturnType<typeof buildClient> | undefined
}

function buildClient() {
  const rewrite = applyTenantScopeExtension()
  return new PrismaClient().$extends({
    name: "tenant-scope",
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          return rewrite({ model, operation, args, query })
        },
      },
    },
  })
}

export const prisma = globalForPrisma.prisma ?? buildClient()

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma

import { startKeepAlive } from "./db-keepalive"
startKeepAlive()
