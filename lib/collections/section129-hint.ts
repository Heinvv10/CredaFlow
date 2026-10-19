export interface Section129Block {
  /** Why the S.129 action is disabled; the same text as the button tooltip. */
  reason: string
  /** True when time alone lifts the block (DPD threshold, cooldown). */
  temporary: boolean
}

/** The stage-panel hint for a disabled S.129 action. "yet" only when time will lift the block. */
export function section129HintText({ reason, temporary }: Section129Block): string {
  const clause = reason.trim().replace(/\.$/, "")
  const sentence = clause.charAt(0).toUpperCase() + clause.slice(1)
  // Some reasons already open with "Section 129"; don't say it twice.
  if (/^section 129\b/i.test(clause)) return `${sentence}.`
  return `Section 129 cannot be issued${temporary ? " yet" : ""}: ${clause}.`
}
