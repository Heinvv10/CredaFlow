// Pure and client-safe: no imports that reach @/lib/prisma.
import { formatBusinessHours } from "./hours"
import type { HandoffReason } from "./model"

/**
 * The line the website adds to every hand-off reply. It is chosen from the mode the hand-off
 * leaves the chat in, so it can never disagree with what the widget shows: "waiting" while
 * consultants are expected, "fallback" when nobody is. A fallback says why: after hours
 * (`inHours` false) it names the hours; within them (an earlier wait timed out) nobody can join.
 */
export function handoffLine(reason: HandoffReason | null, mode: "waiting" | "fallback", inHours: boolean, businessHours: unknown): string {
  if (mode === "fallback") {
    if (inHours) return "Our consultants can't join the chat right now."
    const hours = formatBusinessHours(businessHours)
    const away = "Our consultants aren't available right now."
    return hours ? `${away} They're available ${hours}.` : away
  }
  return reason === "asked_for_person"
    ? "Sure, I'll connect you to one of our consultants."
    : "I can't help with that here, so I'll connect you to a consultant."
}

/** The model's own text (anything else the visitor must hear), then the line. */
export function withHandoffLine(modelText: string, line: string): string {
  const text = modelText.trim()
  return text ? `${text}\n\n${line}` : line
}
