/**
 * The database client the SIEM delivery uses. With AUDIT_DELIVERY_DATABASE_URL set it is a
 * separate login (audit_grant_delivery): the delivery worker holds the outbox functions
 * and the web processes, which have only audit_grant_runtime(role, false), do not. Unset,
 * delivery shares the application's client (one login holding both kinds).
 */
import { PrismaClient } from "@prisma/client"
import { prisma } from "@/lib/prisma"

let dedicated: PrismaClient | null = null

export function deliveryClient(): PrismaClient {
  const url = process.env.AUDIT_DELIVERY_DATABASE_URL
  if (!url) return prisma as unknown as PrismaClient
  dedicated ??= new PrismaClient({ datasourceUrl: url })
  return dedicated
}
