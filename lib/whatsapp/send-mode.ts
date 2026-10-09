export type WaSendMode =
  | { mode: "text" }
  | { mode: "template" }
  | { mode: "error"; error: string; providerOutcome: "DEFINITELY_REJECTED" }

/** Stable code the inbox composer keys off to prompt "pick a template". */
export const WA_OUTSIDE_WINDOW_NEEDS_TEMPLATE = "WA_OUTSIDE_WINDOW_NEEDS_TEMPLATE"

const WINDOW_MS = 24 * 60 * 60 * 1000

export function isWithinServiceWindow(lastInboundAt: Date | null, now: Date): boolean {
  if (!lastInboundAt) return false
  return now.getTime() - lastInboundAt.getTime() < WINDOW_MS
}

/**
 * Meta enforces the 24h customer-service window: free-form text is allowed only
 * within 24h of the customer's last inbound. Outside it, only an approved
 * template may be sent. This is a pure decision — the sender reads the window
 * timestamp and calls this.
 */
export function resolveWaSendMode(opts: {
  lastInboundAt: Date | null
  hasApprovedTemplate: boolean
  now: Date
}): WaSendMode {
  if (isWithinServiceWindow(opts.lastInboundAt, opts.now)) return { mode: "text" }
  if (opts.hasApprovedTemplate) return { mode: "template" }
  return { mode: "error", error: WA_OUTSIDE_WINDOW_NEEDS_TEMPLATE, providerOutcome: "DEFINITELY_REJECTED" }
}
