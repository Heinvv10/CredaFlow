import type { BureauDisplay } from "@/lib/compliance/bureau-display"

/**
 * Where the bureau enquiry button sits on an UNDER_REVIEW application's rail.
 * Only a missing, pending or skipped enquiry needs retrying, so only then is
 * it a primary action. Once a result is on file the next step (approve or
 * decline) leads, and re-running the enquiry is a secondary action.
 */
export function bureauRailAction(display: BureauDisplay): "retry" | "rerun" {
  return display.kind === "CHECK" || display.kind === "OVERRIDE" ? "rerun" : "retry"
}
