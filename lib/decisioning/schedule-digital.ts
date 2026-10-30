import { deferAfterResponse } from "@/lib/http/after-response"
import { logger } from "@/lib/observability/logger"

/**
 * The entry point for a submission route: records that the application is due its
 * automatic review (lib/decisioning/digital-due.ts) BEFORE scheduling the work with
 * next/server `after`, so the client's request is answered first and a task lost to a
 * restart is still found by the sweep (/api/cron/digital-decisions). The engine is
 * loaded only when the task runs, so a submission route pays for one lookup and, for a
 * lender whose engine is on, one insert. Never throws. If the due row cannot be recorded
 * the application stays SUBMITTED for staff: a review that runs without its row would run
 * without the daily limits on paid bureau pulls, so none is attempted.
 */
export async function scheduleDigitalDecision(
  input: { tenantId: string; applicationId: string; clientId?: string; ip: string | null },
  schedule: (task: () => Promise<void>) => void = deferAfterResponse,
): Promise<void> {
  try {
    const { markDigitalDecisionDue } = await import("./digital-due")
    if (!(await markDigitalDecisionDue(input))) return
  } catch (error) {
    logger.error("auto-decision: could not record the due review; the application stays with staff", { applicationId: input.applicationId, error: error instanceof Error ? error.message : String(error) })
    return
  }
  schedule(async () => {
    try {
      const { runDigitalDue } = await import("./digital-due")
      await runDigitalDue({ tenantId: input.tenantId, applicationId: input.applicationId })
    } catch (error) {
      logger.error("auto-decision: digital submission review failed; the sweep will retry", { applicationId: input.applicationId, error: error instanceof Error ? error.message : String(error) })
    }
  })
}
