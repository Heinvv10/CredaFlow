/**
 * Stage of one loan on a run date, from its triggers and its previous stage.
 * Pure: the loader (loan-input.ts) gathers the inputs, the run (run.ts) stores the result.
 *
 * Deterioration is immediate. Improvement is not: when the triggers clear, the
 * loan stays in its stage for the lender's probation (months, per stage), then
 * steps down one stage at a time; a trigger firing again restarts the clock.
 */
import type { Ifrs9Settings, SicrFlagKind, Stage } from "./types"

export interface StagingInput {
  /** Days past due on the run date (the DPD cron's definition, lib/loan/balances.ts). */
  dpd: number
  status: string
  collectionsStage: string
  /** NCA s86 debt-review notice recorded on the loan. */
  debtReview: boolean
  /** Kinds of the loan's active SICR flags. */
  flags: readonly SicrFlagKind[]
}

export interface PriorStaging {
  stage: Stage
  stageSince: string
  cureStartedOn: string | null
  /** The loan was RESTRUCTURED (or still in the probation that follows) at the prior run: see restructuredProbationMonths. */
  restructured: boolean
}

export interface StagingResult {
  stage: Stage
  /** The stage the triggers alone give; below `stage` while the loan is in probation. */
  triggerStage: Stage
  reasons: string[]
  stageSince: string
  cureStartedOn: string | null
  inProbation: boolean
  /** RESTRUCTURED now, or still serving the longer probation after it: stored on the snapshot and read back as `PriorStaging.restructured`. */
  restructured: boolean
}

/** Shown in a snapshot's reasons while a formerly restructured loan serves its longer probation. */
export const RESTRUCTURE_PROBATION = "RESTRUCTURE_PROBATION"

export function addMonthsIso(iso: string, months: number): string {
  const [y, m, d] = iso.split("-").map(Number)
  const index = y * 12 + (m - 1) + months
  const year = Math.floor(index / 12)
  const month = (index % 12) + 1
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(Math.min(d, lastDay)).padStart(2, "0")}`
}

/** The stage the triggers give on their own, with a reason code for each that fired. */
export function stageTriggers(input: StagingInput, settings: Ifrs9Settings): { stage: Stage; reasons: string[] } {
  const stage3: string[] = []
  const stage2: string[] = []
  const place = (stage: Stage, reason: string) => { if (stage === 3) stage3.push(reason); else if (stage === 2) stage2.push(reason) }
  if (input.dpd >= settings.defaultDpd) stage3.push("DPD_AT_DEFAULT_THRESHOLD")
  if (input.status === "DEFAULTED") stage3.push("STATUS_DEFAULTED")
  if (input.status === "PENDING_WRITE_OFF") stage3.push("PENDING_WRITE_OFF")
  if (input.collectionsStage === "ATTORNEY_REFERRED") stage3.push("LEGAL_ACTION")
  if (input.status === "RESTRUCTURED") place(settings.restructuredStage, "RESTRUCTURED")
  if (input.debtReview) place(settings.debtReviewStage, "DEBT_REVIEW")
  if (stage3.length > 0) return { stage: 3, reasons: stage3 }
  if (input.dpd > settings.sicrDpdOver) stage2.unshift("DPD_OVER_SICR_THRESHOLD")
  for (const kind of input.flags) stage2.push(`FLAG_${kind}`)
  return stage2.length > 0 ? { stage: 2, reasons: stage2 } : { stage: 1, reasons: [] }
}

/**
 * The cure clock concerns the trigger stage being left: a Stage 3 loan whose default triggers have cleared steps
 * down after stage3ProbationMonths even if a Stage 2 trigger (say 40 days past due again) is still firing, and lands
 * in Stage 2. A trigger at or above the loan's own stage restarts the clock.
 */
export function classifyStage(input: StagingInput, settings: Ifrs9Settings, prior: PriorStaging | null, runDate: string): StagingResult {
  const { stage: triggerStage, reasons } = stageTriggers(input, settings)
  const restructuredNow = input.status === "RESTRUCTURED"
  if (!prior) return { stage: triggerStage, triggerStage, reasons, stageSince: runDate, cureStartedOn: null, inProbation: false, restructured: restructuredNow }

  if (triggerStage >= prior.stage) {
    // A trigger that wins the stage does not serve the restructure probation: the marker is kept while the loan is
    // still in a stage it has to cure from, and only a loan back at Stage 1 sheds it.
    return {
      stage: triggerStage, triggerStage, reasons, cureStartedOn: null, inProbation: false,
      restructured: restructuredNow || (prior.restructured && triggerStage >= 2),
      stageSince: triggerStage === prior.stage ? prior.stageSince : runDate,
    }
  }

  // The longer restructure probation applies to a loan that is RESTRUCTURED now (whatever stage it was put in) or was
  // and has not yet served it.
  const restructured = restructuredNow || prior.restructured
  let stage = prior.stage
  let stageSince = prior.stageSince
  let cureStartedOn = prior.cureStartedOn ?? runDate
  while (stage > triggerStage) {
    const base = stage === 3 ? settings.stage3ProbationMonths : settings.stage2ProbationMonths
    const months = restructured ? Math.max(base, settings.restructuredProbationMonths) : base
    if (addMonthsIso(cureStartedOn, months) > runDate) break
    stage = (stage - 1) as Stage
    stageSince = runDate
    cureStartedOn = runDate
  }
  // Landing on a trigger stage that is still firing leaves a Stage 2 or 3 loan with its cure ahead of it: the marker stays.
  if (stage === triggerStage) return { stage, triggerStage, reasons, stageSince, cureStartedOn: null, inProbation: false, restructured: restructuredNow || (restructured && stage >= 2) }
  const reasonsInProbation = [`PROBATION_FROM_STAGE_${stage}`, ...(restructured ? [RESTRUCTURE_PROBATION] : [])]
  return { stage, triggerStage, reasons: reasonsInProbation, stageSince, cureStartedOn, inProbation: true, restructured }
}
