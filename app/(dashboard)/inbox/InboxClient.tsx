"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { QueuePanel } from "./QueuePanel"
import { ThreadView } from "./ThreadView"
import { ContactPanel } from "./ContactPanel"
import { inboxApi, newestThreadReads } from "./api-client"
import { matchesQueue } from "@/lib/inbox/queue-membership"
import type { ConversationSummary, ThreadDTO, InboxQueue, CannedReplyDTO, RosterMember } from "./types"
import { compareConversations } from "@/lib/inbox/ordering"
import { nextSelection } from "./queue-selection"
import { mayReleaseMessageOperationId } from "@/lib/messaging/delivery-outcome"

const POLL_MS = 4000

type Props = {
  currentUserId: string
  canReconcile: boolean
  /** An admin may release a website chat a colleague holds (the server checks the role again). */
  canReleaseChats?: boolean
  initialQueue: InboxQueue
  initialSelectedId?: string | null
  initialConversations: ConversationSummary[]
  cannedReplies: CannedReplyDTO[]
  roster: RosterMember[]
}

export function InboxClient(props: Props) {
  const [queue, setQueue] = useState<InboxQueue>(props.initialQueue)
  const [conversations, setConversations] = useState<ConversationSummary[]>(props.initialConversations)
  // A deep link (?conversationId=), resolved server-side into initialSelectedId,
  // starts selected; its thread is fetched by the mount effect below.
  const [selectedId, setSelectedIdState] = useState<string | null>(props.initialSelectedId ?? null)
  // Mirror of selectedId, so reloadList can read the current selection without
  // taking it as a dependency (which would re-create the callback on every
  // click and re-fire the queue effect). Written together with the state, not
  // in an effect: the list load runs from an effect itself, and a ref updated
  // in a later effect would still hold the previous selection when it reads it.
  const selectedIdRef = useRef<string | null>(props.initialSelectedId ?? null)
  const setSelectedId = useCallback((id: string | null) => {
    selectedIdRef.current = id
    setSelectedIdState(id)
  }, [])
  const [thread, setThread] = useState<ThreadDTO | null>(null)
  const [search, setSearch] = useState("")
  // True from the start: the mount effect loads the list.
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [fallback, setFallback] = useState<{ reason: string; detail?: string } | null>(null)
  const cursorRef = useRef<string | null>(null)
  const activeThreadId = useRef<string | null>(null)
  const [readThread] = useState(() => newestThreadReads(inboxApi.thread))

  // SSR-resolved deep-link conversation (see page.tsx — pinned when it ranks
  // beyond the queue's first page). reloadList hard-replaces `conversations`
  // on every mount/queue-switch, which would otherwise drop it; re-prepend it
  // there when it's missing and we're still on the queue it was resolved
  // into. Cleared once matchesQueue(initialQueue, ...) flips for it (e.g.
  // reopened out of the Closed queue, reassigned out of Mine) — not on any
  // status/assignee change, since e.g. OPEN→PENDING_CUSTOMER or a
  // reassignment within the Closed queue don't change queue membership.
  const pinnedRef = useRef<ConversationSummary | null>(
    props.initialSelectedId ? (props.initialConversations.find((c) => c.id === props.initialSelectedId) ?? null) : null,
  )

  // Applies a loaded list. Called from promise callbacks and handlers, never
  // from an effect body.
  // keepSelection: the reload follows an action on the open thread (join, leave, status).
  // That action is often what moved the thread out of this queue; the agent is still
  // working in it, so the pane keeps it (it loads by id) until they pick something else.
  const applyList = useCallback((q: InboxQueue, res: { conversations: ConversationSummary[] }, keepSelection: boolean) => {
    const pinned = pinnedRef.current
    const needsPin = pinned && q === props.initialQueue && !res.conversations.some((c) => c.id === pinned.id)
    const next = needsPin ? [pinned, ...res.conversations] : res.conversations
    setConversations(next)
    cursorRef.current = null
    // A tab switch used to leave the previously selected thread rendered even
    // when it wasn't in the new tab's list (switch to Mine while viewing
    // someone else's thread). Drop a selection the new list doesn't hold.
    //
    // Resolved OUTSIDE the setSelectedId updater deliberately: a state
    // updater must be pure, and React invokes it twice under StrictMode —
    // clearing the thread from in there fired the other setState calls twice
    // per switch. selectedIdRef mirrors selectedId so the current value is
    // readable here without making applyList depend on it.
    const current = selectedIdRef.current
    const resolved = keepSelection ? current : nextSelection(next, current)
    if (resolved !== current) {
      activeThreadId.current = null
      setThread(null)
      setFallback(null)
      setSelectedId(resolved)
    }
  }, [props.initialQueue, setSelectedId])

  // Reload after an action on the open thread (a handler, so it may set state).
  const reloadList = useCallback(async (q: InboxQueue, keepSelection = false) => {
    setLoading(true)
    try {
      applyList(q, await inboxApi.list(q), keepSelection)
    } finally {
      setLoading(false)
    }
  }, [applyList])

  // First load and every queue switch. `ignore` drops a list that lands after
  // the agent has already moved to another queue.
  useEffect(() => {
    let ignore = false
    inboxApi.list(queue)
      .then((res) => { if (!ignore) applyList(queue, res, false) })
      .finally(() => { if (!ignore) setLoading(false) })
    return () => { ignore = true }
  }, [queue, applyList])

  function changeQueue(q: InboxQueue) {
    if (q === queue) return
    setLoading(true)
    setQueue(q)
  }

  // Shows a loaded thread, unless the agent has moved to another one meanwhile.
  const applyThread = useCallback((id: string, t: ThreadDTO | null) => {
    if (t && activeThreadId.current === id) {
      setThread(t)
      setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, unreadCount: 0 } : c)))
      const pinned = pinnedRef.current
      if (
        pinned?.id === id &&
        matchesQueue(props.initialQueue, pinned, props.currentUserId) !== matchesQueue(props.initialQueue, t.conversation, props.currentUserId)
      ) {
        pinnedRef.current = null
      }
    }
  }, [props.initialQueue, props.currentUserId])

  const loadThread = useCallback(async (id: string) => {
    activeThreadId.current = id
    applyThread(id, await readThread(id))
  }, [applyThread, readThread])

  function select(id: string) {
    setFallback(null)
    setSelectedId(id)
    loadThread(id)
  }

  // Deep link: load the thread of the conversation selected at mount. Safe under
  // StrictMode's dev double-invoke — the activeThreadId ref and the
  // newest-read-wins reader make a repeat call for the same id harmless.
  useEffect(() => {
    const id = props.initialSelectedId
    if (!id) return
    activeThreadId.current = id
    readThread(id).then((t) => applyThread(id, t))
    // Mount only: a later change of the prop must not hijack the agent's selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const timer = setInterval(async () => {
      try {
        const d = await inboxApi.deltas(queue, cursorRef.current)
        cursorRef.current = d.cursor
        if (d.conversations.length > 0) {
          setConversations((prev) => {
            const byId = new Map(prev.map((c) => [c.id, c]))
            for (const c of d.conversations) byId.set(c.id, c)
            // Same comparator the server orders by — sorting on a different
            // key here re-shuffled the queue on every poll tick.
            return [...byId.values()].sort(compareConversations)
          })
        }
        if (selectedId) {
          const t = await readThread(selectedId)
          if (t && activeThreadId.current === selectedId) setThread(t)
        }
      } catch { /* transient poll error — next tick retries */ }
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [queue, selectedId, readThread])

  async function act(fn: () => Promise<void>) {
    setBusy(true)
    try { await fn() }
    catch { /* swallow — per-action handlers set fallback; the poll refresh reconciles state */ }
    finally { setBusy(false) }
  }

  const onSend = async (conversationId: string, text: string, operationId: string, channel: string): Promise<boolean> => {
    setBusy(true)
    try {
      const res = await inboxApi.reply(conversationId, text, operationId, channel)
      if (!res.ok) {
        if (activeThreadId.current === conversationId) {
          setFallback({ reason: res.reason ?? "SEND_BLOCKED", detail: res.detail })
        }
        return false
      }
      if (activeThreadId.current === conversationId) {
        setFallback(res.reconciliationRequired
          ? { reason: "RECONCILIATION_REQUIRED" }
          : res.outcome === "simulated"
            ? { reason: "SIMULATED" }
            : res.outcome === "pending"
              ? { reason: "PENDING" }
              : null)
        await loadThread(conversationId)
      }
      return mayReleaseMessageOperationId(res.outcome, res.reconciliationRequired === true)
    } catch {
      if (activeThreadId.current === conversationId) setFallback({ reason: "SEND_FAILED" })
      return false
    } finally {
      setBusy(false)
    }
  }
  const onNote = async (conversationId: string, text: string, mentionUserIds: string[]): Promise<boolean> => {
    setBusy(true)
    try {
      await inboxApi.note(conversationId, text, mentionUserIds)
      if (activeThreadId.current === conversationId) {
        setFallback(null) // clear a stale failure banner left by a prior failed send/note
        await loadThread(conversationId)
      }
      return true
    } catch {
      if (activeThreadId.current === conversationId) setFallback({ reason: "NOTE_FAILED" })
      return false
    } finally {
      setBusy(false)
    }
  }
  const onEditNote = async (noteId: string, text: string, mentionUserIds: string[]): Promise<boolean> => {
    if (!selectedId) return false
    const conversationId = selectedId
    setBusy(true)
    try {
      await inboxApi.editNote(conversationId, noteId, text, mentionUserIds)
      if (activeThreadId.current === conversationId) {
        setFallback(null) // matches onNote: don't leave a stale failure banner over a fresh attempt
        await loadThread(conversationId)
      }
      return true
    } catch {
      if (activeThreadId.current === conversationId) setFallback({ reason: "NOTE_EDIT_FAILED" })
      return false
    } finally {
      setBusy(false)
    }
  }
  const onDeleteNote = async (noteId: string): Promise<boolean> => {
    if (!selectedId) return false
    const conversationId = selectedId
    setBusy(true)
    try {
      await inboxApi.deleteNote(conversationId, noteId)
      if (activeThreadId.current === conversationId) {
        setFallback(null)
        await loadThread(conversationId)
      }
      return true
    } catch {
      if (activeThreadId.current === conversationId) setFallback({ reason: "NOTE_DELETE_FAILED" })
      return false
    } finally {
      setBusy(false)
    }
  }
  /** The thread as it now is, and the queue without dropping it from the pane. */
  const refresh = async (id: string) => { await loadThread(id); await reloadList(queue, true) }
  const onClaim = () => act(async () => {
    if (!selectedId) return
    const res = await inboxApi.assignment(selectedId, "claim")
    // A website-chat join someone else won is a 409, not a throw: say so, then show who holds the chat.
    if (thread?.conversation.channel === "CHATBOT" && activeThreadId.current === selectedId) {
      setFallback(res.ok ? null : { reason: "CLAIM_REFUSED", detail: res.reason === "ALREADY_CLAIMED" ? "Someone else has already joined this chat." : "This chat can no longer be joined." })
    }
    await refresh(selectedId)
  })
  const onRelease = () => act(async () => { if (selectedId) { await inboxApi.assignment(selectedId, "release"); await refresh(selectedId) } })
  const onReassign = (assigneeId: string) => act(async () => { if (selectedId) { await inboxApi.assignment(selectedId, "reassign", assigneeId); await refresh(selectedId) } })
  const onStatus = (status: string) => act(async () => { if (selectedId) { await inboxApi.patch(selectedId, { status }); await refresh(selectedId) } })
  const onPriority = (priority: string) => act(async () => { if (selectedId) { await inboxApi.patch(selectedId, { priority }); await loadThread(selectedId) } })

  return (
    // grid-rows-[minmax(0,1fr)] is load-bearing, not cosmetic. Without an
    // explicit row track the single implicit row is `auto`, so it grows to fit
    // the tallest column instead of the grid's own bounded height -- the thread
    // column measured 2639px inside a 968px grid, which pushed the composer to
    // y=2786 in a document that does not scroll. ConversationView's internal
    // `flex-1 overflow-y-auto` cannot help while its parent row is unbounded.
    <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)] grid-cols-[320px_1fr_300px]">
      <QueuePanel
        queue={queue}
        onQueueChange={changeQueue}
        conversations={conversations}
        selectedId={selectedId}
        onSelect={select}
        search={search}
        onSearchChange={setSearch}
        loading={loading}
      />
      {thread ? (
        <ThreadView
          thread={thread}
          cannedReplies={props.cannedReplies}
          roster={props.roster}
          currentUserId={props.currentUserId}
          canReconcile={props.canReconcile}
          canReleaseChats={props.canReleaseChats}
          busy={busy}
          fallback={fallback}
          onSend={onSend}
          onNote={onNote}
          onEditNote={onEditNote}
          onDeleteNote={onDeleteNote}
          onClaim={onClaim}
          onRelease={onRelease}
          onReassign={onReassign}
          onStatus={onStatus}
          onPriority={onPriority}
        />
      ) : (
        <div className="flex items-center justify-center text-sm text-gray-400">Select a conversation</div>
      )}
      {thread ? <ContactPanel thread={thread} /> : <div className="border-l border-gray-200 bg-gray-50" />}
    </div>
  )
}
