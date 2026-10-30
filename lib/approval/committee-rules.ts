import { sastCalendarDate } from "@/lib/date/sast"

export interface CommitteeDecisionInput {
  decision: "APPROVED" | "DECLINED" | "DEFERRED"
  /** The day the committee met, YYYY-MM-DD. */
  meetingDate: string
  attendees: string[]
  /** Conditions of an approval. A decline or a deferral carries none. */
  conditions: string[]
  rationale: string
}

/** Why a committee decision cannot be recorded, or none. Pure. */
export function committeeProblems(input: CommitteeDecisionInput, now: Date): string[] {
  const problems: string[] = []
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.meetingDate) || Number.isNaN(Date.parse(`${input.meetingDate}T00:00:00Z`))) problems.push("Give the meeting date as a day, YYYY-MM-DD.")
  else if (input.meetingDate > sastCalendarDate(now)) problems.push("The meeting date cannot be in the future.")
  const names = input.attendees.map((a) => a.trim())
  if (names.length < 1 || names.length > 30 || names.some((n) => n.length < 2 || n.length > 80) || new Set(names.map((n) => n.toLowerCase())).size !== names.length) {
    problems.push("List the members who attended: 1 to 30 distinct names of 2 to 80 characters.")
  }
  if (input.conditions.length > 20) problems.push("A decision carries at most 20 conditions.")
  if (input.conditions.some((c) => c.trim().length < 5 || c.trim().length > 300)) problems.push("Each condition is 5 to 300 characters.")
  if (input.decision !== "APPROVED" && input.conditions.length > 0) problems.push("Only an approval carries conditions.")
  if (input.rationale.trim().length < 10) problems.push("Give the committee's rationale, in at least 10 characters.")
  return problems
}
