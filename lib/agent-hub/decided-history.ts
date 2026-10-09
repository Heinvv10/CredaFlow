export type DecidedAuditRow = {
  id: string
  entityId: string | null
  userEmail: string | null
  createdAt: Date
  newValue: unknown
}

export type DecidedHistoryEvent = {
  id: string
  eventType: string
  commissionCents: number | null
  code: { code: string; label: string | null; agent: { displayName: string } } | null
  lead: { id: string; firstName: string; lastName: string } | null
}

export type DecidedHistoryRow = {
  auditId: string
  decidedByEmail: string | null
  decidedAt: string
  commissionStatus: string | null
  qualityFlag: string | null
  decisionNote: string | null
  event: DecidedHistoryEvent | null
}

function decisionFieldsOf(newValue: unknown): { commissionStatus: string | null; qualityFlag: string | null; decisionNote: string | null } {
  if (!newValue || typeof newValue !== "object" || Array.isArray(newValue)) {
    return { commissionStatus: null, qualityFlag: null, decisionNote: null }
  }
  const v = newValue as Record<string, unknown>
  return {
    commissionStatus: typeof v.commissionStatus === "string" ? v.commissionStatus : null,
    qualityFlag: typeof v.qualityFlag === "string" ? v.qualityFlag : null,
    decisionNote: typeof v.decisionNote === "string" ? v.decisionNote : null,
  }
}

/**
 * Joins REFERRAL_EVENT_DECIDED audit rows to the referral events
 * they decided. The event row carries no decidedBy/decidedAt — the audit log
 * is the legal record of who decided what, and when — so this is the only
 * place that reconstructs "decided by X at T" for display.
 *
 * An audit row whose event can't be found (hard-deleted, or entityId null)
 * degrades to `event: null` rather than being dropped: the decision itself
 * happened and is the legal record: it must stay visible even without the
 * event to show alongside it.
 */
export function matchDecidedHistory(
  audits: DecidedAuditRow[],
  eventsById: Map<string, DecidedHistoryEvent>,
): DecidedHistoryRow[] {
  return audits.map((audit) => ({
    auditId: audit.id,
    decidedByEmail: audit.userEmail,
    decidedAt: audit.createdAt.toISOString(),
    ...decisionFieldsOf(audit.newValue),
    event: audit.entityId ? (eventsById.get(audit.entityId) ?? null) : null,
  }))
}
