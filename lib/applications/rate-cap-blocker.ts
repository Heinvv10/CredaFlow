import { approvalInterestCapCheck } from "@/lib/loan/nca-interest-cap.server"
import type { RailBlocker } from "@/lib/applications/rail-blockers"

type CapDb = Parameters<typeof approvalInterestCapCheck>[0]
type CapApplication = Parameters<typeof approvalInterestCapCheck>[2]

const REFUSAL_LABELS = {
  ABOVE_CAP: "Rate exceeds NCA cap",
  NO_REPO_RATE: "Repo rate not recorded",
  REPO_IMPLAUSIBLE: "Repo rate implausible",
  REPEAT_SHORT_TERM: "Repeat short-term rate exceeds NCA cap",
} as const

/**
 * The NCA Regulation 42 rate-cap gate as a decision-rail blocker: the same
 * verdict /decide answers with a 422 (approvalInterestCapCheck), computed
 * server-side while the application is under review. null when approval is
 * not held on the rate. A failed check never takes the page down; it is
 * listed as unchecked, and /decide re-checks at approval.
 */
export async function rateCapBlocker(
  db: CapDb,
  tenantId: string,
  application: CapApplication & { status: string },
): Promise<RailBlocker | null> {
  if (application.status !== "UNDER_REVIEW") return null
  try {
    const result = await approvalInterestCapCheck(db, tenantId, application)
    if (result.ok) return null
    return { label: REFUSAL_LABELS[result.reason], detail: result.message, tone: "danger" }
  } catch (error) {
    console.error("[application-page] NCA rate cap check failed:", error)
    return {
      label: "NCA rate cap could not be checked",
      detail: "Approval will re-check the product rate against the NCA maximum.",
      tone: "warning",
    }
  }
}
