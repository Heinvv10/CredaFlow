/**
 * Interest suspension is an accounting classification only. The borrower still
 * owes every cent and no NCA document changes: the interest keeps accruing in
 * the loan's schedule and charges, and is carried in a suspense account instead
 * of income until it is collected (lib/accounting/sources-ifrs9.ts).
 */
import type { Ifrs9Settings, Stage } from "./types"

export function suspensionApplies(dpd: number, stage: Stage, settings: Ifrs9Settings): boolean {
  if (!settings.suspensionEnabled) return false
  return dpd >= settings.suspensionDpd || (settings.suspendOnStage3 && stage === 3)
}
