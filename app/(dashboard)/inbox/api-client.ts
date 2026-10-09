import type { ConversationSummary, ThreadDTO, InboxQueue, CannedReplyDTO, RosterMember } from "./types"

async function j<T>(res: Response): Promise<T> {
  if (!res.ok && res.status !== 409) throw new Error(`request failed: ${res.status}`)
  return res.json() as Promise<T>
}

export const inboxApi = {
  list: (queue: InboxQueue, cursor?: string) =>
    fetch(`/api/inbox/conversations?queue=${queue}${cursor ? `&cursor=${cursor}` : ""}`).then((r) => j<{ conversations: ConversationSummary[]; nextCursor: string | null }>(r)),
  deltas: (queue: InboxQueue, since: string | null) =>
    fetch(`/api/inbox/deltas?queue=${queue}${since ? `&since=${encodeURIComponent(since)}` : ""}`).then((r) => j<{ conversations: ConversationSummary[]; cursor: string }>(r)),
  thread: (id: string) => fetch(`/api/inbox/conversations/${id}`).then((r) => j<ThreadDTO>(r)),
  // A website chat has one way to answer, and the route's channel schema knows
  // only WHATSAPP and EMAIL: naming CHATBOT there is a 400, so it is left out.
  reply: (id: string, text: string, operationId: string, channel: string) =>
    fetch(`/api/inbox/conversations/${id}/reply`, { method: "POST", body: JSON.stringify({ text, operationId, ...(channel === "CHATBOT" ? {} : { channel }) }) }).then((r) => j<{ ok: boolean; message?: unknown; outcome?: "sent" | "simulated" | "pending"; reason?: string; detail?: string; reconciliationRequired?: boolean }>(r)),
  note: (id: string, text: string, mentionUserIds: string[]) =>
    fetch(`/api/inbox/conversations/${id}/note`, { method: "POST", body: JSON.stringify({ text, mentionUserIds }) }).then((r) => j<{ id: string }>(r)),
  editNote: (id: string, noteId: string, text: string, mentionUserIds: string[]) =>
    fetch(`/api/inbox/conversations/${id}/note/${noteId}`, { method: "PATCH", body: JSON.stringify({ text, mentionUserIds }) }).then((r) => j<{ ok: boolean; id: string }>(r)),
  deleteNote: (id: string, noteId: string) =>
    fetch(`/api/inbox/conversations/${id}/note/${noteId}`, { method: "DELETE" }).then((r) => j<{ ok: boolean; id: string }>(r)),
  assignment: (id: string, action: "claim" | "release" | "reassign", assigneeId?: string) =>
    fetch(`/api/inbox/conversations/${id}/assignment`, { method: "POST", body: JSON.stringify({ action, assigneeId }) }).then((r) => j<{ ok: boolean; reason?: string }>(r)),
  patch: (id: string, body: { status?: string; priority?: string }) =>
    fetch(`/api/inbox/conversations/${id}`, { method: "PATCH", body: JSON.stringify(body) }).then((r) => j<{ ok: boolean }>(r)),
}

/**
 * Thread reads overlap (the 4s poll's, and the one after a send, note or action) and can land out
 * of order: a poll read sent before a reply was stored could land after the read that followed the
 * send and put the thread back without it. `read` wrapped in this resolves to null when a read
 * sent after it has already landed, so only the newest data is ever applied.
 */
export function newestThreadReads(read: (id: string) => Promise<ThreadDTO>): (id: string) => Promise<ThreadDTO | null> {
  let sent = 0
  let landed = 0
  return async (id) => {
    const ticket = ++sent
    const t = await read(id)
    if (ticket < landed) return null
    landed = ticket
    return t
  }
}

export type { ConversationSummary, ThreadDTO, InboxQueue, CannedReplyDTO, RosterMember }
