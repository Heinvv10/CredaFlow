/**
 * Per-tenant engine context and the small shared pieces of the DB layer.
 *
 * The engine is dark unless TenantConfig.collectionsEngineEnabled is true AND
 * a collection provider is configured: loadEngineContext returns null
 * otherwise, and every entry point stops there without reading anything else.
 */
import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { getCollectionProvider } from "@/lib/integrations/collections/registry"
import {
  CollectionProviderError,
  type CollectionProvider,
  type ProviderCredentials,
} from "@/lib/integrations/collections/types"

export interface EngineContext {
  tenantId: string
  provider: CollectionProvider
  creds: ProviderCredentials
  now: Date
}

/** The machine actor on engine-written rows. AuditLog.userId is a User FK, so it stays null. */
export const ENGINE_ACTOR = {
  userId: null,
  userEmail: "system@collections-engine",
  capturedBy: "collections-engine",
} as const

/** The interactive-transaction client of the tenant-scoped prisma singleton. */
export type EngineTx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0]

export async function loadEngineContext(tenantId: string, now: Date): Promise<EngineContext | null> {
  const config = await prisma.tenantConfig.findUnique({
    where: { tenantId },
    select: {
      collectionsEngineEnabled: true,
      collectionProvider: true,
      avsProvider: true,
      netcashDebitOrderKey: true,
      netcashRiskReportsKey: true,
    },
  })
  if (!config?.collectionsEngineEnabled || !config.collectionProvider) return null
  return {
    tenantId,
    provider: getCollectionProvider(config),
    // Each adapter documents the keys it reads (lib/integrations/collections).
    creds: {
      netcashDebitOrderKey: config.netcashDebitOrderKey,
      netcashRiskReportsKey: config.netcashRiskReportsKey,
    },
    now,
  }
}

/**
 * The adapter for a mandate's own provider: the tenant's current one, or the
 * one the mandate was created with if the tenant has since switched. Sweeps
 * and cancellations must reach mandates on a former provider too.
 */
export function providerFor(ctx: EngineContext, providerId: string): CollectionProvider {
  return providerId === ctx.provider.id ? ctx.provider : getCollectionProvider({ collectionProvider: providerId, avsProvider: null })
}

/**
 * A provider error that proves nothing reached the rail: retrying cannot
 * double-debit. Anything else (a timeout, a 5xx) may have been received.
 */
export function definitelyNotSent(error: unknown): boolean {
  return error instanceof CollectionProviderError
    && (error.code === "NOT_CONFIGURED" || error.code === "NOT_IMPLEMENTED" || error.code === "UNKNOWN_PROVIDER")
}

const MAX_STORED_MESSAGE = 300

/**
 * A provider-supplied message made safe to persist and show: digit runs of six
 * or more (account, ID and card numbers) are masked and the text truncated.
 */
export function redact(message: string): string {
  const masked = message.replace(/\d{6,}/g, "[redacted]")
  return masked.length > MAX_STORED_MESSAGE ? `${masked.slice(0, MAX_STORED_MESSAGE - 1)}…` : masked
}

/** A message safe to store and show: provider errors name a rule; others are reduced to their class. */
export function errorSummary(error: unknown): string {
  if (error instanceof CollectionProviderError) return redact(`${error.code}: ${error.message}`)
  const code = typeof (error as { code?: unknown })?.code === "string" ? ` ${(error as { code: string }).code}` : ""
  return `${error instanceof Error ? error.name : "Error"}${code}`
}

export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"
}

/** A unique violation on one particular key: P2002's target names its fields or its index. */
export function isUniqueViolationOn(error: unknown, field: string): boolean {
  if (!isUniqueViolation(error)) return false
  const target = (error as Prisma.PrismaClientKnownRequestError).meta?.target
  return Array.isArray(target) ? target.includes(field) : typeof target === "string" && target.includes(field)
}

/** A SAST calendar date as the @db.Date value Prisma writes. */
export const dateOnly = (day: string): Date => new Date(`${day}T00:00:00.000Z`)

/** A @db.Date value back to its calendar date. */
export const dayOf = (value: Date): string => value.toISOString().slice(0, 10)
