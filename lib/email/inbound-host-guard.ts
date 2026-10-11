// Inbound counterpart to lib/email/recipient-guard.ts. That guard stops a
// non-production box SENDING to a member of the public; this one stops it
// CONNECTING to the production mailbox — where it would read, thread and
// (via record-inbound) mutate real customer conversations, and where a
// non-production poll racing production's poll silently competes for the same messages.
//
// Same delivery-mode detector as recipient-guard.ts:56-60: only the exact
// string "unrestricted" opts out, so a typo leaves the box restricted.

export class InboundHostBlockedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "InboundHostBlockedError"
  }
}

export function isUnrestricted(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.EMAIL_DELIVERY_MODE === "unrestricted"
}

export function inboundAllowedHosts(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.EMAIL_INBOUND_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean)
}

export interface InboundHostDecision {
  allowed: boolean
  /** Operator-facing reason. Never contains a credential. */
  reason?: string
}

export function inboundHostAllowed(
  host: string | null,
  env: NodeJS.ProcessEnv = process.env,
): InboundHostDecision {
  if (isUnrestricted(env)) return { allowed: true }

  const allowed = inboundAllowedHosts(env)
  // FAIL CLOSED. An unset allowlist in a restricted environment is a
  // misconfiguration, not permission — the safe reading of "I did not say
  // which mailboxes this box may read" is "none".
  if (allowed.length === 0) {
    return {
      allowed: false,
      reason:
        "Inbound email is restricted in this environment and EMAIL_INBOUND_ALLOWED_HOSTS is not set. Set it to the IMAP hosts this environment may poll.",
    }
  }

  const normalised = (host ?? "").trim().toLowerCase()
  if (!normalised) {
    return { allowed: false, reason: "No IMAP host configured." }
  }
  if (allowed.includes(normalised)) return { allowed: true }

  return {
    allowed: false,
    reason: `IMAP host "${normalised}" is not in EMAIL_INBOUND_ALLOWED_HOSTS (${allowed.join(", ")}). This environment may not poll it.`,
  }
}

export function assertInboundHostAllowed(
  host: string | null,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const decision = inboundHostAllowed(host, env)
  if (!decision.allowed) throw new InboundHostBlockedError(decision.reason ?? "IMAP host not allowed")
}
