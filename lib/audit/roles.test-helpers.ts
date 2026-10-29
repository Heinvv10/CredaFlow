import type { PrismaClient } from "@prisma/client"

/**
 * Runs a catalog statement (GRANT, DROP OWNED...) on the owner connection, retrying the transient
 * "tuple concurrently updated" Postgres raises when two sessions change the same catalog row (the schema's
 * ACL, a role) at the same moment, as the audit suites' role set-up and tear-down can.
 */
export async function ddl(owner: Pick<PrismaClient, "$executeRawUnsafe">, sql: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await owner.$executeRawUnsafe(sql)
      return
    } catch (error) {
      if (attempt >= 5 || !/concurrently updated/.test(String(error))) throw error
      await new Promise((resolve) => setTimeout(resolve, 50 * attempt))
    }
  }
}
