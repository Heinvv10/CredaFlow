import type { prisma as ScopedPrismaClient } from "@/lib/prisma"

/**
 * The transaction client of the app's tenant-scoped Prisma client. The VAT
 * functions take a Pick of it: they always run inside the caller's
 * transaction, never on their own.
 */
export type VatTransaction = Parameters<Parameters<typeof ScopedPrismaClient.$transaction>[0]>[0]
