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
}

export interface StagingResult {
  stage: Stage
  /** The stage the triggers alone give; below `stage` while the loan is in probation. */
  triggerStage: Stage
  reasons: string[]
  stageSince: string
  cureStartedOn: string | null
  inProbation: boolean
}

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
  if (input.dpd >= settings.defaultDpd) stage3.push("DPD_AT_DEFAULT_THRESHOLD")
  if (input.status === "DEFAULTED") stage3.push("STATUS_DEFAULTED")
  if (input.status === "PENDING_WRITE_OFF" || input.status === "WRITTEN_OFF") stage3.push("PENDING_WRITE_OFF")
  if (input.collectionsStage === "ATTORNEY_REFERRED") stage3.push("LEGAL_ACTION")
  if (stage3.length > 0) return { stage: 3, reasons: stage3 }

  const stage2: string[] = []
  if (input.dpd > settings.sicrDpdOver) stage2.push("DPD_OVER_SICR_THRESHOLD")
  if (settings.restructuredIsSicr && input.status === "RESTRUCTURED") stage2.push("RESTRUCTURED")
  if (settings.debtReviewIsSicr && input.debtReview) stage2.push("DEBT_REVIEW")
  for (const kind of input.flags) stage2.push(`FLAG_${kind}`)
  return stage2.length > 0 ? { stage: 2, reasons: stage2 } : { stage: 1, reasons: [] }
}

export function classifyStage(input: StagingInput, settings: Ifrs9Settings, prior: PriorStaging | null, runDate: string): StagingResult {
  const { stage: triggerStage, reasons } = stageTriggers(input, settings)
  if (!prior) return { stage: triggerStage, triggerStage, reasons, stageSince: runDate, cureStartedOn: null, inProbation: false }

  if (triggerStage >= prior.stage) {
    return {
      stage: triggerStage, triggerStage, reasons, cureStartedOn: null, inProbation: false,
      stageSince: triggerStage === prior.stage ? prior.stageSince : runDate,
    }
  }

  let stage = prior.stage
  let stageSince = prior.stageSince
  let cureStartedOn = prior.cureStartedOn ?? runDate
  while (stage > triggerStage) {
    const months = stage === 3 ? settings.stage3ProbationMonths : settings.stage2ProbationMonths
    if (addMonthsIso(cureStartedOn, months) > runDate) break
    stage = (stage - 1) as Stage
    stageSince = runDate
    cureStartedOn = runDate
  }
  if (stage === triggerStage) return { stage, triggerStage, reasons, stageSince, cureStartedOn: null, inProbation: false }
  return { stage, triggerStage, reasons: [`PROBATION_FROM_STAGE_${stage}`], stageSince, cureStartedOn, inProbation: true }
}
