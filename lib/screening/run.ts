import { randomUUID } from "node:crypto"
import { Prisma, type ScreeningTrigger } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { isSimulationPermitted } from "@/lib/integrations/simulation-guard"
import { getScreeningConfig } from "./policy"
import { getScreeningProvider } from "./registry"
import { loadLatestRun, lockClientScreening } from "./store"
import { amlStatusFor, carriedDecision, deriveScreeningState, matchFingerprint, type ScreeningState } from "./state"
import {
  SCREENING_TYPES,
  ScreeningProviderError,
  type ScreeningProvider,
  type ScreeningProviderResult,
  type ScreeningSubject,
} from "./types"

export type RunScreeningArgs = {
  tenantId: string
  clientId: string
  trigger: ScreeningTrigger
  applicationId?: string | null
  /** null for the cron and other system callers. */
  actor: { id: string; email: string } | null
}

export type RunScreeningResult =
  | { configured: false }
  | { configured: true; runId: string; state: ScreeningState; providerError: string | null }

type Outcome =
  | { ok: true; value: ScreeningProviderResult }
  | { ok: false; code: string; message: string }

async function callProvider(key: string, subject: ScreeningSubject): Promise<{ provider: ScreeningProvider | null; outcome: Outcome }> {
  let provider: ScreeningProvider | null = null
  try {
    provider = getScreeningProvider(key)
    return { provider, outcome: { ok: true, value: await provider.screen(subject, SCREENING_TYPES) } }
  } catch (error) {
    // Recorded as ERROR rows (state INCOMPLETE), which block approval: a
    // provider that could not answer is never read as "clear".
    const code = error instanceof ScreeningProviderError ? error.code : "PROVIDER_ERROR"
    const message = error instanceof Error ? error.message : String(error)
    return { provider, outcome: { ok: false, code, message } }
  }
}

/**
 * Screens one client for every type with the lender's provider and records the
 * run: one ScreeningCheck per type, a decision carried forward where the same
 * list entries were decided before, Client.amlScreeningStatus, and an audit
 * row, all in one transaction. Throws only for a missing client or a database
 * failure; a provider failure is a recorded, blocking result.
 */
export async function runScreening(args: RunScreeningArgs): Promise<RunScreeningResult> {
  const { tenantId, clientId, trigger, actor } = args
  const config = await getScreeningConfig(tenantId)
  if (!config.provider) return { configured: false }

  const client = await prisma.client.findFirst({
    where: { id: clientId, tenantId },
    select: { id: true, firstName: true, lastName: true, idNumber: true, dateOfBirth: true },
  })
  if (!client) throw new Error("Client not found for screening")

  const subject: ScreeningSubject = {
    clientId: client.id,
    firstName: client.firstName,
    lastName: client.lastName,
    idNumber: client.idNumber,
    dateOfBirth: client.dateOfBirth ? client.dateOfBirth.toISOString().slice(0, 10) : null,
  }
  const { provider, outcome } = await callProvider(config.provider, subject)
  const simulated = provider?.simulated === true || (outcome.ok && outcome.value.simulated === true)
  const runId = randomUUID()
  const createdAt = new Date()

  const state = await prisma.$transaction(async (tx) => {
    await lockClientScreening(tx, tenantId, clientId)
    const priors = await tx.screeningCheck.findMany({
      where: { tenantId, clientId, decision: { not: null } },
      select: { id: true, type: true, matchFingerprint: true, decision: true, decisionReason: true, createdAt: true },
    })
    const rows: Prisma.ScreeningCheckCreateManyInput[] = SCREENING_TYPES.map((type) => {
      const base = {
        tenantId, clientId, runId, trigger, createdAt, type, simulated,
        applicationId: args.applicationId ?? null,
        provider: config.provider as string,
        providerReference: outcome.ok ? outcome.value.providerReference : null,
      }
      const found = outcome.ok ? outcome.value.results.find((r) => r.type === type) : undefined
      if (!outcome.ok || !found) {
        return { ...base, result: "ERROR" as const, errorCode: outcome.ok ? "TYPE_NOT_RETURNED" : outcome.code }
      }
      if (found.result === "CLEAR") return { ...base, result: "CLEAR" as const }
      const fingerprint = matchFingerprint(type, found.matches)
      const carried = found.result === "CONFIRMED_MATCH" && type === "SANCTIONS"
        ? null
        : carriedDecision({ type, fingerprint }, priors)
      return {
        ...base,
        result: found.result,
        matches: found.matches as unknown as Prisma.InputJsonValue,
        matchFingerprint: fingerprint,
        ...(carried
          ? {
              decision: carried.decision,
              decisionReason: carried.decisionReason,
              reviewedAt: createdAt,
              carriedFromCheckId: carried.id,
            }
          : {}),
      }
    })
    await tx.screeningCheck.createMany({ data: rows })

    const latest = await loadLatestRun(tx, tenantId, clientId)
    const derived = deriveScreeningState({
      configured: true,
      latestRun: latest?.checks ?? [],
      simulationPermitted: isSimulationPermitted("screening"),
    })
    const aml = amlStatusFor(derived)
    if (aml) {
      await tx.client.updateMany({
        where: { id: clientId, tenantId },
        data: { amlScreeningStatus: aml, amlScreeningAt: createdAt },
      })
    }
    await logAuditStrict({
      tenantId,
      userId: actor?.id,
      userEmail: actor?.email,
      action: outcome.ok ? AuditAction.SCREENING_RUN : AuditAction.SCREENING_RUN_FAILED,
      entity: "Client",
      entityId: clientId,
      newValue: {
        runId,
        trigger,
        provider: config.provider,
        simulated,
        applicationId: args.applicationId ?? null,
        results: rows.map((r) => ({ type: r.type, result: r.result, carried: r.carriedFromCheckId != null })),
        state: derived.state,
        amlScreeningStatus: aml,
        ...(outcome.ok ? {} : { errorCode: outcome.code }),
      },
    }, tx)
    return derived
  })

  return { configured: true, runId, state, providerError: outcome.ok ? null : outcome.message }
}
