"use client"

import { useEffect, useRef, useState } from "react"
import type { ChatLine, ChatMode } from "@/lib/website-chat/mode"
import { forgetChatToken, storeChatToken, storedChatToken } from "@/components/support/chat-session"

export type ChatPhase = "form" | "chat" | "ended"
export type ChatForm = { name: string; phone: string; email: string; consent: boolean }
/** "invalid" never reached the server; "failed" did, and spent the single-use challenge token. */
export type StartOutcome = "started" | "invalid" | "failed"

type PollBody = { mode?: ChatMode; staffName?: string | null; ref?: string; lines?: ChatLine[]; error?: string }
type MessageBody = { reply?: string; handedOff?: boolean; mode?: ChatMode; staffName?: string | null; error?: string }

const FAST_POLL_MS = 3_000
const SLOW_POLL_MS = 15_000
const WHATSAPP_QUESTION_CHARS = 300
const ENDED = "This chat has ended."

const visitorCount = (lines: ChatLine[]) => lines.filter((l) => l.from === "visitor").length

/** Local lines the transcript has not caught up with: everything from the visitor message after the `matched` it now holds. */
function unmatched(local: ChatLine[], matched: number): ChatLine[] {
  let visitors = 0
  const from = local.findIndex((l) => l.from === "visitor" && (visitors += 1) > matched)
  return from === -1 ? [] : local.slice(from)
}

/** Whole characters only: encodeURIComponent throws on half a surrogate pair, whether pasted or cut by a slice. */
const wholeChars = (text: string) => Array.from(text).filter((ch) => ch.length > 1 || ch < "\uD800" || ch > "\uDFFF")

function post(route: "start" | "message" | "poll", body: unknown) {
  return fetch(`/api/website/chat/${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

/** The prefilled WhatsApp message for a visitor nobody could join: the chat reference and their last question. */
export function whatsAppFallbackText(ref: string | null, lines: ChatLine[]): string {
  const opening = ref ? `Hi, I was chatting on your website (ref ${ref}).` : "Hi, I was chatting on your website."
  const last = wholeChars(lines.filter((l) => l.from === "visitor").pop()?.text ?? "").slice(0, WHATSAPP_QUESTION_CHARS).join("")
  return last ? `${opening} ${last}` : opening
}

export function useWebsiteChat() {
  const [phase, setPhase] = useState<ChatPhase>("form")
  const [mode, setModeState] = useState<ChatMode>("bot")
  const [staffName, setStaffName] = useState<string | null>(null)
  const [ref, setRef] = useState<string | null>(null)
  // What the server last said the transcript is, and what was typed or answered since.
  const [server, setServer] = useState<ChatLine[]>([])
  const [local, setLocal] = useState<ChatLine[]>([])
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})

  // The poll loop outlives any one render, so what it reads lives in refs.
  const token = useRef<string | null>(null)
  const modeRef = useRef<ChatMode>("bot")
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const polling = useRef(false)
  const pollAgain = useRef(false)
  const unmounted = useRef(false)
  // Visitor lines in the transcript at the last poll: local messages beyond these are still optimistic.
  const seen = useRef(0)
  const sends = useRef(0)
  // A message the server refused stays on screen under its notice, until the next one is sent.
  const refused = useRef<string | null>(null)
  // A token from storage, until a poll proves the server still knows it.
  const restoring = useRef(false)

  useEffect(() => {
    unmounted.current = false
    // A hidden tab drops the poll it had booked and books no other (see schedule); shown again, it asks at once.
    const onVisibility = () => {
      if (document.hidden) {
        if (timer.current) clearTimeout(timer.current)
      } else if (token.current) void poll()
    }
    document.addEventListener("visibilitychange", onVisibility)
    // A chat under way before a refresh or a page change: back to it, transcript and mode from one poll now.
    const stored = storedChatToken()
    if (stored && !token.current) {
      token.current = stored
      restoring.current = true
      setPhase("chat")
      void poll()
    }
    return () => {
      unmounted.current = true
      document.removeEventListener("visibilitychange", onVisibility)
      if (timer.current) clearTimeout(timer.current)
    }
    // poll reads refs and state setters only, so the first render's is as good as any.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function setMode(next: ChatMode) {
    modeRef.current = next
    setModeState(next)
  }

  function end(text?: string) {
    forgetChatToken()
    setMode("ended")
    setPhase("ended")
    setNotice(text ?? ENDED)
    if (timer.current) clearTimeout(timer.current)
  }

  /** A stored chat the server no longer knows: back to the form, as if it had never been. */
  function forget() {
    forgetChatToken()
    token.current = null
    restoring.current = false
    setServer([])
    setPhase("form")
  }

  /** The visitor ends the chat on this device: token gone, transcript cleared, back to the form. The server's idle close ends the conversation. */
  function endChat() {
    forget()
    setLocal([])
    setRef(null)
    setStaffName(null)
    setNotice(null)
    setBusy(false)
    setMode("bot")
    seen.current = 0
    refused.current = null
    if (timer.current) clearTimeout(timer.current)
  }

  // Nothing polls without a token: one from start(), or one restored from storage on mount.
  const live = () => !unmounted.current && modeRef.current !== "ended" && token.current !== null

  /** One timer, rescheduled: a poll is only ever booked after the previous one has finished. */
  function schedule(waitMs = 0) {
    if (timer.current) clearTimeout(timer.current)
    // Nobody is looking at a hidden tab: it stops asking until it is shown again.
    if (!live() || document.hidden) return
    const every = modeRef.current === "waiting" || modeRef.current === "staff" ? FAST_POLL_MS : SLOW_POLL_MS
    timer.current = setTimeout(() => void poll(), Math.max(every, waitMs))
  }

  async function poll() {
    if (!live()) return
    if (polling.current) {
      pollAgain.current = true
      return
    }
    polling.current = true
    // This poll replaces the booked one, which would otherwise fire mid-flight and queue another.
    if (timer.current) clearTimeout(timer.current)
    let waitMs = 0
    try {
      const sent = token.current
      const res = await post("poll", { token: sent })
      const data = (await res.json()) as PollBody
      if (token.current !== sent) return // the visitor ended the chat while this was in flight
      if (res.status === 401 || res.status === 404) return restoring.current ? forget() : end(data.error)
      if (res.status === 429) waitMs = Number(res.headers.get("Retry-After") ?? 0) * 1000 || 0
      const lines = data.lines
      if (res.ok && data.mode && Array.isArray(lines)) {
        restoring.current = false
        setServer(lines)
        // Optimistic messages and their replies go as the transcript catches up with them, oldest first.
        const matched = Math.max(0, visitorCount(lines) - seen.current)
        seen.current += matched
        setLocal((l) => unmatched(l, matched))
        setStaffName(data.staffName ?? null)
        if (data.ref) setRef(data.ref)
        if (data.mode === "ended") return end()
        setMode(data.mode)
      }
    } catch {
      // A dropped poll is not worth a notice: the next tick asks again.
    } finally {
      polling.current = false
      if (pollAgain.current) {
        pollAgain.current = false
        void poll()
      } else schedule(waitMs)
    }
  }

  async function start(form: ChatForm, turnstileToken: string | null): Promise<StartOutcome> {
    if (!form.consent) {
      setErrors({ consent: "Please tick the box to continue." })
      return "invalid"
    }
    if (!turnstileToken) {
      setErrors({ submit: "Please complete the verification challenge." })
      return "invalid"
    }
    setBusy(true)
    setErrors({})
    try {
      const res = await post("start", { ...form, turnstileToken })
      const data = (await res.json()) as { token?: string; greeting?: string; ref?: string; error?: string; errors?: Record<string, string> }
      if (!res.ok || !data.token) {
        setErrors({ ...(data.errors ?? {}), submit: data.error ?? "Something went wrong." })
        return "failed"
      }
      token.current = data.token
      storeChatToken(data.token)
      setRef(data.ref ?? null)
      setServer([{ id: "greeting", from: "assistant", text: data.greeting ?? "" }])
      setPhase("chat")
      schedule()
      return "started"
    } catch {
      setErrors({ submit: "Could not reach the server. Please try again." })
      return "failed"
    } finally {
      setBusy(false)
    }
  }

  async function send(draft: string): Promise<void> {
    const text = draft.trim()
    if (!text || !token.current || busy || phase !== "chat") return
    setBusy(true)
    setNotice(null)
    sends.current += 1
    const id = `local-${sends.current}`
    const dropped = refused.current
    refused.current = null
    setLocal((l) => [...l.filter((line) => line.id !== dropped), { id, from: "visitor", text }])
    const sent = token.current
    try {
      const res = await post("message", { token: sent, text })
      const data = (await res.json()) as MessageBody
      if (token.current !== sent) return // the visitor ended the chat while this was out: nothing of it belongs to what is shown now
      const reply = data.reply
      if (reply) setLocal((l) => [...l, { id: `${id}-reply`, from: "assistant", text: reply }])
      if (data.staffName !== undefined) setStaffName(data.staffName)
      // Only the server ends a chat. A 429 carrying handedOff is the per-chat cap handing the
      // visitor to staff: they may join, so the input stays and polling goes on.
      if (res.status === 409 || res.status === 401 || res.status === 404 || data.mode === "ended") return end(data.error)
      if (data.mode) setMode(data.mode)
      if (!res.ok && !reply) {
        refused.current = id
        setNotice(data.error ?? "Something went wrong.")
      }
      // A stored message can change the mode (a hand-off, a staffer joining): show it now, not on the timer.
      if (res.ok) void poll()
      else schedule()
    } catch {
      if (token.current !== sent) return
      refused.current = id
      setNotice("Could not reach the server. Please try again.")
    } finally {
      // After End chat the stale send must not touch busy: endChat released it, and the next chat may be mid-send.
      if (token.current === sent) setBusy(false)
    }
  }

  return { phase, mode, staffName, ref, lines: [...server, ...local], busy, notice, errors, start, send, endChat }
}
