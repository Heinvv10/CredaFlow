// Pure and client-safe: no imports that reach @/lib/prisma.
export const HANDOFF_WAIT_MS = 120_000

export type ChatMode = "bot" | "waiting" | "staff" | "fallback" | "ended"

/** One line of the transcript as the visitor's window gets it. `name` is on staff lines only: the first name of whoever wrote that line. */
export type ChatLine = { id: string; from: "visitor" | "assistant" | "staff"; text: string; name?: string }

export function chatMode(
  c: { closedAt: Date | null; status: string; assigneeId: string | null },
  handoff: { timedOutAt: Date | null } | null,
): ChatMode {
  if (c.closedAt) return "ended"
  if (c.assigneeId) return "staff"
  if (c.status === "PENDING_INTERNAL") {
    // The bot's hand-off writes the row with the status. A pending chat without one was set
    // pending by staff, or predates hand-offs: nobody is being waited for.
    return handoff && !handoff.timedOutAt ? "waiting" : "fallback"
  }
  return "bot"
}
