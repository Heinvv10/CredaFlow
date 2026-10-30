/** The RLS-bound client the approval integration suites swap in for `@/lib/prisma` (created in each suite's beforeAll). */
export const holder = { app: null as object | null }

export function mockPrisma<T extends object>(actual: T): T & { prisma: object } {
  const prisma = new Proxy({}, {
    get(_target, key) {
      if (!holder.app) throw new Error("the RLS-bound app client is created in beforeAll")
      const value: unknown = Reflect.get(holder.app, key)
      return typeof value === "function" ? value.bind(holder.app) : value
    },
  })
  return { ...actual, prisma }
}
