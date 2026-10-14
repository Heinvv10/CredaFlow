import { randomUUID } from "node:crypto"
import { Prisma, type ScreeningTrigger } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { isSimulationPermitted } from "@/lib/integrations/simulation-guard"
import { hasMinRole } from "@/lib/permissions"
import { carriedDecision, matchFingerprint } from "./carry"
import { getScreeningConfig } from "./policy"
import { callProvider } from "./provider-call"
import { loadActiveBlocks, loadLatestRun, lockSubjectScreening } from "./store"
import { amlStatusFor, deriveScreeningState, type ScreeningState } from "./state"
import { currentFingerprint, loadSubject, subjectWhere } from "./subject"
import { SCREENING_TYPES, type SubjectRef } from "./types"

export type RunScreeningArgs = {
  tenantId: string
  subject: SubjectRef
  trigger: ScreeningTrigger
  applicationId?: string | null
  /** The audited actor; null for the cron and other system callers. */
  actor: { id: string; email: string } | null
  /**
   * Record the run as system-started (triggeredById null) even though an
   * actor is audited: the approval gate's runs, so maker-checker does not lock
   * the approver out of reviewing what their approval attempt surfaced.
   */
  asSystem?: boolean
  /** The entity this person is screened for, as a related party (N7). */
  contextEntityId?: string | null
  /** Override of SCREENING_TIMEOUT_MS (tests). */
  timeoutMs?: number
}

export type RunScreeningResult =
  | { configured: false }
  | { configured: true; runId: string; state: ScreeningState; providerError: string | null }

/**
 * Screens one subject (client or entity) with the lender's provider and
 * records the run: one ScreeningCheck per supported type, stamped with the
 * identity screened (subjectFingerprint) and who started it; carried
 * decisions (lib/screening/carry.ts); Client.amlScreeningStatus for a client;
 * an audit row. All in one transaction under the subject's screening lock.
 * The database writes sticky blocks itself (recordScreeningBlock). Throws
 * only for a missing subject or a database failure; a provider failure or
 * timeout is a recorded, blocking result.
 */
export async function runScreening(args: RunScreeningArgs): Promise<RunScreeningResult> {
  const { tenantId, subject: ref, trigger, actor } = args
  const config = await getScreeningConfig(tenantId)
  if (!config.provider) return { configured: false }
  const providerKey = config.provider

  const loaded = await loadSubject(prisma, tenantId, ref)
  if (!loaded) throw new Error("Screening subject not found")
  const { provider, outcome } = await callProvider(providerKey, loaded.subject, args.timeoutMs)
  const types = provider?.supportedTypes ?? SCREENING_TYPES
  const simulated = provider?.simulated === true || (outcome.ok && outcome.value.simulated === true)
  const runId = randomUUID()
  const createdAt = new Date()

  const state = await prisma.$transaction(async (tx) => {
    await lockSubjectScreening(tx, tenantId, ref)
    const priors = await tx.screeningCheck.findMany({
      // Only decisions about THIS identity can carry (N2).
      where: { tenantId, ...subjectWhere(ref), decision: { not: null }, subjectFingerprint: loaded.fingerprint },
      select: {
        id: true, type: true, result: true, matchFingerprint: true, subjectFingerprint: true, decision: true, decisionReason: true,
        reviewedById: true, reviewedAt: true, carriedFromCheckId: true, createdAt: true,
      },
    })
    const reviewerIds = [...new Set(priors.map((p) => p.reviewedById).filter((id): id is string => id !== null))]
    const reviewers = reviewerIds.length === 0 ? [] : await tx.user.findMany({
      where: { tenantId, id: { in: reviewerIds }, active: true },
      select: { id: true, role: true },
    })
    const eligible = new Set(reviewers.filter((u) => hasMinRole(u.role, config.reviewMinRole)).map((u) => u.id))

    const rows: Prisma.ScreeningCheckCreateManyInput[] = types.map((type) => {
      const base = {
        tenantId, ...subjectWhere(ref), runId, trigger, createdAt, type, simulated,
        subjectFingerprint: loaded.fingerprint,
        triggeredById: args.asSystem ? null : actor?.id ?? null,
        contextEntityId: "clientId" in ref ? args.contextEntityId ?? null : null,
        applicationId: args.applicationId ?? null,
        provider: providerKey,
        providerReference: outcome.ok ? outcome.value.providerReference : null,
      }
      const found = outcome.ok ? outcome.value.results.find((r) => r.type === type) : undefined
      if (!outcome.ok || !found) {
        return { ...base, result: "ERROR" as const, errorCode: outcome.ok ? "TYPE_NOT_RETURNED" : outcome.code }
      }
      if (found.result === "CLEAR") return { ...base, result: "CLEAR" as const }
      const fingerprint = matchFingerprint(type, found.result, found.matches)
      const carried = carriedDecision(
        { type, result: found.result, fingerprint, matches: found.matches, subjectFingerprint: loaded.fingerprint },
        priors,
        { now: createdAt, reviewerEligible: (id) => eligible.has(id) },
      )
      return {
        ...base,
        result: found.result,
        matches: found.matches as unknown as Prisma.InputJsonValue,
        matchFingerprint: fingerprint,
        ...(carried
          ? { decision: carried.prior.decision, decisionReason: carried.prior.decisionReason, reviewedAt: createdAt, carriedFromCheckId: carried.prior.id }
          : {}),
      }
    })
    await tx.screeningCheck.createMany({ data: rows })

    const [latest, blocks, fingerprintNow] = await Promise.all([
      loadLatestRun(tx, tenantId, ref),
      loadActiveBlocks(tx, tenantId, ref),
      currentFingerprint(tx, tenantId, ref),
    ])
    const derived = deriveScreeningState({
      configured: true,
      latestRun: latest?.checks ?? [],
      simulationPermitted: isSimulationPermitted("screening"),
      expectedTypes: types,
      currentFingerprint: fingerprintNow,
      activeBlockCheckIds: blocks,
    })
    const aml = amlStatusFor(derived)
    if (aml && "clientId" in ref) {
      await tx.client.updateMany({ where: { id: ref.clientId, tenantId }, data: { amlScreeningStatus: aml, amlScreeningAt: createdAt } })
    }
    await logAuditStrict({
      tenantId,
      userId: actor?.id,
      userEmail: actor?.email,
      action: outcome.ok ? AuditAction.SCREENING_RUN : AuditAction.SCREENING_RUN_FAILED,
      entity: "clientId" in ref ? "Client" : "BusinessEntity",
      entityId: "clientId" in ref ? ref.clientId : ref.entityId,
      newValue: {
        runId, trigger, provider: providerKey, simulated,
        applicationId: args.applicationId ?? null,
        results: rows.map((r) => ({ type: r.type, result: r.result, carried: r.carriedFromCheckId != null })),
        state: derived.state,
        amlScreeningStatus: "clientId" in ref ? aml : null,
        ...(outcome.ok ? {} : { errorCode: outcome.code }),
      },
    }, tx)
    return derived
  })

  return { configured: true, runId, state, providerError: outcome.ok ? null : outcome.message }
}
