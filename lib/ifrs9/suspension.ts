/**
 * Interest suspension is an accounting classification only. The borrower still
 * owes every cent and no NCA document changes: the interest keeps accruing in
 * the loan's schedule and charges, and is carried in a suspense account instead
 * of income until it is collected (lib/accounting/sources-ifrs9.ts).
 *
 * Only a Stage 3 loan is suspended (on either basis), and only a contract type
 * whose suspense is journalled (types.ts journalsSuspense). Stage 3 starts at
 * defaultDpd and suspensionDpd is never below it, so the DPD threshold only
 * narrows which Stage 3 loans are suspended when suspendOnStage3 is off.
 */
import { journalsSuspense, type Ifrs9Settings, type Stage } from "./types"

export function suspensionApplies(dpd: number, stage: Stage, contractType: string, settings: Ifrs9Settings): boolean {
  if (!settings.suspensionEnabled || stage !== 3 || !journalsSuspense(contractType)) return false
  return settings.suspendOnStage3 || dpd >= settings.suspensionDpd
}
