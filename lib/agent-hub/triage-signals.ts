import { REASONS } from "./decision-reasons"

export type TriageSignal = {
  kind: "AGENT_SHARES_PHONE" | "REPEAT_BORROWER_SAME_AGENT"
  severity: "high" | "medium"
  message: string
  /** Preset to pre-select if the reviewer blocks from this signal. */
  blockReason: string
  /** Preset to pre-select if the reviewer waves it through. */
  dismissReason: string
}

export type SignalInput = {
  borrowerClientId: string | null
  borrowerPhone: string | null
  referringAgentId: string | null
  agents: { id: string; displayName: string; phone: string | null }[]
  repeatPairs: { agentId: string; clientId: string; count: number }[]
}

// SA numbers reach us as 0820000727, +27820000727 and "082 000 0727". The last
// 9 digits are identical across all three, so they are the comparison key.
// Anything shorter is not a usable number and must never match.
const PHONE_KEY_LENGTH = 9

export function normalisePhone(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null
  const digits = raw.replace(/\D/g, "")
  if (digits.length < PHONE_KEY_LENGTH) return null
  return digits.slice(-PHONE_KEY_LENGTH)
}

export function detectSignals(input: SignalInput): TriageSignal[] {
  // No resolved borrower means nothing to reason about — a funnel event, not a loan.
  if (!input.borrowerClientId) return []

  const signals: TriageSignal[] = []

  const borrowerKey = normalisePhone(input.borrowerPhone)
  if (borrowerKey) {
    const match = input.agents.find((agent) => normalisePhone(agent.phone) === borrowerKey)
    if (match) {
      signals.push({
        kind: "AGENT_SHARES_PHONE",
        severity: "high",
        // Deliberately factual. There is no FK between an agent and a client, so
        // this is a heuristic — state what matched, never assert identity or fraud.
        message: `Shares a phone number with agent ${match.displayName}`,
        blockReason: REASONS.BLOCKED[1], // Agent not eligible
        dismissReason: REASONS.PAYABLE[1], // Checked — agent relationship is legitimate
      })
    }
  }

  const repeat = input.repeatPairs.find(
    (pair) => pair.agentId === input.referringAgentId && pair.clientId === input.borrowerClientId && pair.count > 1,
  )
  if (repeat) {
    signals.push({
      kind: "REPEAT_BORROWER_SAME_AGENT",
      severity: "medium",
      message: `Referred ${repeat.count}× by this agent`,
      blockReason: REASONS.BLOCKED[0], // Duplicate referral
      dismissReason: REASONS.PAYABLE[0], // Checked — not a duplicate
    })
  }

  return signals
}
