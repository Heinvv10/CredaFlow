import { deferAfterResponse } from "@/lib/http/after-response"

/**
 * The after-response entry point for a submission route: schedules the review
 * (lib/decisioning/digital-submission.ts) with next/server `after`, so the
 * client's request is answered first. The engine is loaded only when the task
 * runs, so a submission route pays nothing for it. A failure is logged; the
 * application stays SUBMITTED for staff.
 */
export function scheduleDigitalDecision(
  input: { tenantId: string; applicationId: string },
  schedule: (task: () => Promise<void>) => void = deferAfterResponse,
): void {
  schedule(async () => {
    try {
      const { reviewDigitalSubmission } = await import("./digital-submission")
      await reviewDigitalSubmission(input)
    } catch (error) {
      // TODO: use the structured logger once lib/observability/logger.ts lands (PR #252).
      console.error("[auto-decision] digital submission review failed; the application stays with staff:", input.applicationId, error)
    }
  })
}
