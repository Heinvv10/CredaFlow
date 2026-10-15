import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { isSimulationPermitted } from "@/lib/integrations/simulation-guard"
import { getScreeningConfig, screeningCutoff } from "./policy"
import { expectedTypesFor } from "./registry"
import { runScreening } from "./run"
import { loadActiveBlocks, loadEntityContextBlocks, loadLatestRun, lockSubjectScreening } from "./store"
import { deriveScreeningState, needsRerun, screeningAllowsApproval, screeningStateMessage, type ScreeningState } from "./state"
import { borrowerSubjects, currentFingerprint, subjectKey } from "./subject"
import type { SubjectRef } from "./types"

type ReadDb = Pick<typeof prisma, "screeningCheck" | "screeningBlock" | "tenantConfig" | "$queryRaw">
export type Borrower = { clientId: string | null; entityId: string | null }

export type SubjectScreening = { state: ScreeningState; runAt: Date | null; runId: string | null }

/** A database refusal raised by guardLoanApplicationScreening. */
export function isScreeningRefusal(error: unknown): boolean {
  const text = String(error)
  return text.includes("LoanApplication_screening_required") || text.includes("LoanApplication_screening_blocks_approval")
    || text.includes("has not been screened") || text.includes("screening blocks approval")
    || text.includes("LoanApplication_screening_self_decided") || text.includes("decided a screening match")
}

/** One subject's current screening state, read-only (no provider call). */
export async function readSubjectScreening(tenantId: string, ref: SubjectRef, db: ReadDb = prisma): Promise<SubjectScreening> {
  const config = await getScreeningConfig(tenantId, db)
  if (!config.provider) return { state: { state: "NOT_CONFIGURED" }, runAt: null, runId: null }
  const [latest, blocks, fingerprint] = await Promise.all([
    loadLatestRun(db, tenantId, ref),
    loadActiveBlocks(db, tenantId, ref),
    currentFingerprint(db, tenantId, ref),
  ])
  return {
    state: deriveScreeningState({
      configured: true,
      latestRun: latest?.checks ?? [],
      simulationPermitted: isSimulationPermitted("screening"),
      expectedTypes: expectedTypesFor(latest?.provider ?? config.provider),
      currentFingerprint: fingerprint,
      activeBlockCheckIds: blocks,
    }),
    runAt: latest?.runAt ?? null,
    runId: latest?.runId ?? null,
  }
}

export type BorrowerScreening = {
  allowed: boolean
  /** The first subject that refuses approval, or CLEAR / NOT_CONFIGURED. */
  state: ScreeningState
  message: string
  subjects: Array<{ ref: SubjectRef; state: ScreeningState }>
  providerError: string | null
  /** Refused because the approver decided a match the screening relies on (segregation of duties). */
  selfDecided?: true
}

const SELF_DECIDED_MESSAGE =
  "You decided a screening match this approval relies on. Another user must approve it."

/**
 * Segregation of duties (requireSecondReviewer on): did `userId` decide any
 * match the borrower's current screening relies on, including carried
 * decisions traced to their original decider? The same SQL function the
 * approval trigger uses, so the two never disagree.
 */
export async function approverDecidedRelied(
  db: Pick<typeof prisma, "$queryRaw">,
  tenantId: string,
  borrower: Borrower,
  userId: string,
): Promise<boolean> {
  const rows = await db.$queryRaw<Array<{ decided: boolean }>>(
    Prisma.sql`SELECT "screeningApproverDecided"(${tenantId}, ${borrower.clientId}, ${borrower.entityId}, ${userId}) AS decided`,
  )
  return rows[0]?.decided === true
}

const label = (ref: SubjectRef, borrower: Borrower) =>
  "clientId" in ref ? (borrower.entityId ? "A related party (director, member, trustee, signatory, surety or owner)" : "The client") : "The entity"

const CONTEXT_BLOCK_MESSAGE =
  "A person related to the entity, now or before, has a sanctions or rejected-match block. A super admin must lift it."

function combine(
  borrower: Borrower,
  subjects: Array<{ ref: SubjectRef; state: ScreeningState }>,
  providerError: string | null,
  configured: boolean,
  contextBlocks: string[] = [],
): BorrowerScreening {
  if (!configured) return { allowed: true, state: { state: "NOT_CONFIGURED" }, message: screeningStateMessage({ state: "NOT_CONFIGURED" }), subjects, providerError }
  if (contextBlocks.length > 0) {
    return { allowed: false, state: { state: "BLOCKED", reason: "STICKY_BLOCK", checkIds: contextBlocks }, message: CONTEXT_BLOCK_MESSAGE, subjects, providerError }
  }
  if (subjects.length === 0) {
    return { allowed: false, state: { state: "NOT_SCREENED" }, message: "The application has no borrower to screen.", subjects, providerError }
  }
  const refusing = subjects.find((s) => !screeningAllowsApproval(s.state))
  if (!refusing) return { allowed: true, state: { state: "CLEAR" }, message: screeningStateMessage({ state: "CLEAR" }), subjects, providerError }
  return { allowed: false, state: refusing.state, message: `${label(refusing.ref, borrower)}: ${screeningStateMessage(refusing.state)}`, subjects, providerError }
}

/** Every party of a borrower, read-only. Disbursement uses this: it never calls the provider. */
export async function readBorrowerScreening(tenantId: string, borrower: Borrower): Promise<BorrowerScreening> {
  const config = await getScreeningConfig(tenantId)
  if (!config.provider) return combine(borrower, [], null, false)
  const refs = await borrowerSubjects(prisma, tenantId, borrower)
  const subjects = []
  for (const ref of refs) subjects.push({ ref, state: (await readSubjectScreening(tenantId, ref)).state })
  const contextBlocks = borrower.entityId ? await loadEntityContextBlocks(prisma, tenantId, borrower.entityId) : []
  return combine(borrower, subjects, null, true, contextBlocks)
}

/**
 * The pre-approval gate for a client or an entity borrower (the entity and
 * every actively related person). Re-screens a party first when it was never
 * screened, its identity changed, its latest run errored or is older than
 * SCREENING_MAX_AGE_DAYS. Approval is allowed only when every party is CLEAR.
 */
export async function borrowerScreeningGate(args: {
  tenantId: string
  borrower: Borrower
  applicationId: string
  actor: { id: string; email: string }
  now?: Date
}): Promise<BorrowerScreening> {
  const { tenantId, borrower, applicationId, actor } = args
  const config = await getScreeningConfig(tenantId)
  if (!config.provider) return combine(borrower, [], null, false)
  const refs = await borrowerSubjects(prisma, tenantId, borrower)
  const subjects: Array<{ ref: SubjectRef; state: ScreeningState }> = []
  let providerError: string | null = null
  for (const ref of refs) {
    const current = await readSubjectScreening(tenantId, ref)
    let state = current.state
    const stale = !current.runAt || current.runAt < screeningCutoff(args.now)
    if (state.state !== "NOT_CONFIGURED" && state.state !== "BLOCKED" && (needsRerun(state) || stale)) {
      // Maker-checker on: the approver is the run's maker, so they cannot clear
      // its matches and then approve (segregation of duties). Off: a system
      // run, so a lone reviewer is not locked out of what it surfaced.
      const ran = await runScreening({
        tenantId, subject: ref, trigger: "PRE_APPROVAL", applicationId, actor, asSystem: !config.requireSecondReviewer,
        contextEntityId: "clientId" in ref ? borrower.entityId : null,
      })
      if (ran.configured) {
        state = ran.state
        providerError = providerError ?? ran.providerError
      }
    }
    subjects.push({ ref, state })
  }
  const contextBlocks = borrower.entityId ? await loadEntityContextBlocks(prisma, tenantId, borrower.entityId) : []
  const result = combine(borrower, subjects, providerError, true, contextBlocks)
  if (result.allowed && config.requireSecondReviewer && (await approverDecidedRelied(prisma, tenantId, borrower, actor.id))) {
    return { ...result, allowed: false, selfDecided: true, message: SELF_DECIDED_MESSAGE }
  }
  return result
}

/**
 * The same rule re-read inside the approval transaction, under every party's
 * screening lock (taken in a fixed order), so a run, review or lift committing
 * in between is seen. The SQL trigger guardLoanApplicationScreening is the
 * backstop for other writers.
 */
export async function lockedBorrowerScreeningAllows(
  tx: ReadDb & Pick<typeof prisma, "$executeRaw" | "entityRelationship">,
  tenantId: string,
  borrower: Borrower,
  /** The approving user: refused if they decided a match relied on (requireSecondReviewer on). */
  approverId: string,
): Promise<boolean> {
  const config = await getScreeningConfig(tenantId, tx)
  if (!config.provider) return true
  const refs = [...(await borrowerSubjects(tx, tenantId, borrower))].sort((a, b) => subjectKey(a).localeCompare(subjectKey(b)))
  if (refs.length === 0) return false
  for (const ref of refs) await lockSubjectScreening(tx, tenantId, ref)
  if (borrower.entityId && (await loadEntityContextBlocks(tx, tenantId, borrower.entityId)).length > 0) return false
  for (const ref of refs) {
    if (!screeningAllowsApproval((await readSubjectScreening(tenantId, ref, tx)).state)) return false
  }
  if (config.requireSecondReviewer && (await approverDecidedRelied(tx, tenantId, borrower, approverId))) return false
  return true
}
