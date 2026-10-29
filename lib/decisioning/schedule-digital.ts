import { deferAfterResponse } from "@/lib/http/after-response"

/**
 * The entry point for a submission route: records that the application is due its
 * automatic review (lib/decisioning/digital-due.ts) BEFORE scheduling the work with
 * next/server `after`, so the client's request is answered first and a task lost to a
 * restart is still found by the sweep (/api/cron/digital-decisions). The engine is
 * loaded only when the task runs, so a submission route pays for one lookup and, for a
 * lender whose engine is on, one insert. Never throws: a failure is logged and the
 * application stays SUBMITTED for staff.
 */
export async function scheduleDigitalDecision(
  input: { tenantId: string; applicationId: string; clientId?: string; ip: string | null },
  schedule: (task: () => Promise<void>) => void = deferAfterResponse,
): Promise<void> {
  let due = true
  let recorded = false
  try {
    const { markDigitalDecisionDue } = await import("./digital-due")
    due = await markDigitalDecisionDue(input)
    recorded = due
  } catch (error) {
    // TODO: use the structured logger once lib/observability/logger.ts lands (PR #252).
    console.error("[auto-decision] could not record the due review; running it without the safety net:", input.applicationId, error)
  }
  if (!due) return
  schedule(async () => {
    try {
      if (recorded) {
        const { runDigitalDue } = await import("./digital-due")
        await runDigitalDue({ tenantId: input.tenantId, applicationId: input.applicationId })
      } else {
        // No row could be written: review directly (no sweep to fall back on, no daily limit).
        const { reviewDigitalSubmission } = await import("./digital-submission")
        await reviewDigitalSubmission({ tenantId: input.tenantId, applicationId: input.applicationId })
      }
    } catch (error) {
      // TODO: use the structured logger once lib/observability/logger.ts lands (PR #252).
      console.error("[auto-decision] digital submission review failed; the application stays with staff:", input.applicationId, error)
    }
  })
}
