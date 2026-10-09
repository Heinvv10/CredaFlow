/**
 * Read-time merge of a lead's manual CrmActivity rows with the comms-hub
 * messages threaded on the lead's Contact (via getContactComms). The lead
 * Activity Timeline renders this union so sent/received messages appear
 * alongside hand-logged activities without dual-writing CrmActivity rows
 * that could drift from the real Conversation thread.
 */

export type TimelineActivityInput = {
  id: string
  type: string
  subject: string
  notes: string | null
  createdAt: Date
}

// Subset of lib/inbox/contact-comms TimelineMessage the merge needs.
export type TimelineMessageInput = {
  id: string
  conversationId: string
  channel: string
  direction: string
  isInternal: boolean
  bodyText: string | null
  status: string
  hasMedia: boolean
  createdByName: string | null
  createdAt: string
}

export type LeadTimelineEntry =
  | (TimelineActivityInput & { kind: "activity" })
  | {
      kind: "message"
      id: string
      conversationId: string
      channel: string
      direction: string
      bodyText: string | null
      status: string
      hasMedia: boolean
      createdByName: string | null
      createdAt: Date
    }

export function mergeLeadTimeline(
  activities: TimelineActivityInput[],
  messages: TimelineMessageInput[],
): LeadTimelineEntry[] {
  const activityEntries: LeadTimelineEntry[] = activities.map((a) => ({
    kind: "activity",
    id: a.id,
    type: a.type,
    subject: a.subject,
    notes: a.notes,
    createdAt: a.createdAt,
  }))

  // Internal inbox notes are thread-scoped agent annotations, not
  // communications with the lead — keep them out of the lead timeline.
  const messageEntries: LeadTimelineEntry[] = messages
    .filter((m) => !m.isInternal)
    .map((m) => ({
      kind: "message",
      id: m.id,
      conversationId: m.conversationId,
      channel: m.channel,
      direction: m.direction,
      bodyText: m.bodyText,
      status: m.status,
      hasMedia: m.hasMedia,
      createdByName: m.createdByName,
      createdAt: new Date(m.createdAt),
    }))

  return [...activityEntries, ...messageEntries].sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
  )
}
