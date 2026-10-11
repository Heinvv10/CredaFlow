"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { AlertTriangle, CheckCircle, Clock, PauseCircle, XCircle } from "lucide-react"
import type { WaBridgeSlot } from "@/lib/whatsapp-bridge-admin"

type PairingResult = { slotId: string; pairingCode: string; expiresAt: string }

// Poll fast while it matters (a slot is mid-pairing/mid-handoff and the
// operator is watching for it to land) and slow otherwise, so an idle tab
// isn't hammering the bridge every 3s all day.
const FAST_POLL_MS = 3_000
const SLOW_POLL_MS = 15_000

// A manual refresh() (after an add/promote/retire/priority action) flips to
// the "unreachable" state on the FIRST failure — that failure is a direct
// result of the action the operator just took, so it must be trusted
// immediately. A background poll is different: it runs unattended every few
// seconds, so one transient blip (bridge mid-restart, a dropped connection)
// would otherwise blank a perfectly good, still-accurate slot list out from
// under an operator who is watching it. Require two consecutive poll
// failures before making the same call — still fast (≤~6s during pairing,
// ≤~30s at idle) but not trigger-happy on a single hiccup.
const POLL_FAILURES_BEFORE_UNREACHABLE = 2

const STATUS_STYLES: Record<WaBridgeSlot["status"], string> = {
  CONNECTED: "bg-green-100 text-green-700",
  CONNECTING: "bg-blue-100 text-blue-700",
  DISCONNECTED: "bg-amber-100 text-amber-700",
  LOGGED_OUT: "bg-red-100 text-red-700",
  RETIRED: "bg-gray-100 text-gray-600",
  // Parked on purpose — neutral, not an alarm colour. Its session is intact.
  PAUSED: "bg-slate-200 text-slate-700",
}

const STATUS_ICON: Record<WaBridgeSlot["status"], typeof CheckCircle> = {
  CONNECTED: CheckCircle,
  CONNECTING: Clock,
  DISCONNECTED: AlertTriangle,
  LOGGED_OUT: XCircle,
  RETIRED: XCircle,
  PAUSED: PauseCircle,
}

async function parseJson(res: Response): Promise<{ error?: string; code?: string }> {
  return res.json().catch(() => ({}))
}

// `initial` is null when page.tsx's server-side listWaBridgeNumbers() call
// failed (bridge unreachable at load) — distinct from an empty array (bridge
// reachable, zero numbers paired). Never conflate the two: this tab is the
// exact screen an operator opens *because* the bridge might be down.
export function WhatsAppBridgeTab({ initial }: { initial: WaBridgeSlot[] | null }) {
  const [numbers, setNumbers] = useState<WaBridgeSlot[] | null>(initial)
  const [newNumber, setNewNumber] = useState("")
  // Set when the bridge reports it does not recognise this number. Confirming
  // is a deliberate assertion that the number is not linked to another bridge:
  // a number added to two bridges makes WhatsApp revoke BOTH
  // sessions, taking the number down for hours.
  const [confirmUnknown, setConfirmUnknown] = useState(false)
  const [needsConfirm, setNeedsConfirm] = useState(false)
  const [pairing, setPairing] = useState<PairingResult | null>(null)
  const [priorityEdits, setPriorityEdits] = useState<Record<string, string>>({})
  const [confirmRetireId, setConfirmRetireId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Mutable mirror of `busy` the polling loop below needs to read without
  // re-subscribing its effect (and therefore its setTimeout chain) on every
  // render. Kept in sync via the effect right after the state.
  const busyRef = useRef(busy)
  useEffect(() => { busyRef.current = busy }, [busy])
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])
  const pollFailuresRef = useRef(0)
  // Guards against two polls in flight at once: handleVisibilityChange below
  // calls runPoll() directly (for the "fetch once immediately" requirement),
  // so a fast hidden→visible→hidden→visible toggle within one round-trip
  // could otherwise start a second poll before the first resolves, and
  // whichever settles last — not necessarily the most recent — would win.
  const isPollingRef = useRef(false)

  // A failed refresh means the bridge is unreachable RIGHT NOW — flip to the
  // same null state page.tsx would have produced, rather than leaving a
  // stale list on screen that looks current. Used after user-triggered
  // actions (add/promote/retire/priority) where a failure is trustworthy on
  // the first try — see poll() below for the background-polling variant.
  async function refresh() {
    try {
      const res = await fetch("/api/settings/whatsapp-bridge/numbers")
      const body = await res.json().catch(() => null) as { numbers?: WaBridgeSlot[]; error?: string } | null
      if (!res.ok || !body) {
        setNumbers(null)
        setError(body?.error ?? "Lost contact with the WhatsApp bridge.")
        return
      }
      // A confirmed successful round-trip, whatever triggered it — clear any
      // failure streak the background poll was mid-counting, so a stale
      // failure from before this action doesn't combine with the next poll
      // blip to flip to unreachable despite a proven-good response in between.
      pollFailuresRef.current = 0
      setNumbers(body.numbers ?? [])
    } catch {
      setNumbers(null)
      setError("Lost contact with the WhatsApp bridge.")
    }
  }

  // Background poll used by the effect below. Differs from refresh() in
  // three ways: (1) it never runs while a user action is in flight — busy
  // owns the result in that window, not the poll; (2) it tolerates a single
  // transient failure (see POLL_FAILURES_BEFORE_UNREACHABLE) instead of
  // blanking the screen on the first one; (3) on success it also clears a
  // pairing panel whose slot has since connected, since that panel is no
  // longer actionable once pairing has succeeded.
  const poll = useCallback(async () => {
    if (busyRef.current || isPollingRef.current) return
    isPollingRef.current = true
    try {
      const res = await fetch("/api/settings/whatsapp-bridge/numbers")
      const body = await res.json().catch(() => null) as { numbers?: WaBridgeSlot[]; error?: string } | null
      // A user action may have started (and taken ownership via busy) while
      // this fetch was in flight, or the tab may have unmounted — either
      // way, its own refresh() (or nothing, if unmounted) must win.
      if (!mountedRef.current || busyRef.current) return
      if (!res.ok || !body) {
        pollFailuresRef.current += 1
        if (pollFailuresRef.current >= POLL_FAILURES_BEFORE_UNREACHABLE) {
          setNumbers(null)
          setError(body?.error ?? "Lost contact with the WhatsApp bridge.")
        }
        return
      }
      pollFailuresRef.current = 0
      const next = body.numbers ?? []
      setNumbers(next)
      setPairing((p) => (p && next.some((n) => n.slotId === p.slotId && n.status === "CONNECTED") ? null : p))
    } catch {
      if (!mountedRef.current || busyRef.current) return
      pollFailuresRef.current += 1
      if (pollFailuresRef.current >= POLL_FAILURES_BEFORE_UNREACHABLE) {
        setNumbers(null)
        setError("Lost contact with the WhatsApp bridge.")
      }
    } finally {
      isPollingRef.current = false
    }
  }, [])

  // Recomputed every render so the effect below can depend on it directly.
  // This is what makes the interval react IMMEDIATELY when pairing starts or
  // a slot enters/leaves CONNECTING, rather than waiting for whatever timeout
  // happened to already be pending: a schedule set during a quiet SLOW_POLL_MS
  // period would otherwise keep ticking at 15s for up to 15s after pairing
  // begins — exactly the window this feature exists to make responsive.
  const isTransitional = (numbers?.some((n) => n.status === "CONNECTING") ?? false) || pairing !== null

  // Drives the poll on a self-rescheduling timer (not setInterval) so a slow
  // request can't stack overlapping polls. Pauses entirely while the tab is
  // hidden and does one immediate poll the moment it becomes visible again,
  // per document.visibilityState. Re-subscribes whenever `isTransitional`
  // flips, tearing down and immediately re-scheduling at the new interval;
  // when it doesn't flip, runPoll()'s own scheduleNext() call keeps the same
  // chain going at the same cadence.
  useEffect(() => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null
    let cancelled = false

    function clearScheduled() {
      if (timeoutId) {
        clearTimeout(timeoutId)
        timeoutId = null
      }
    }

    function scheduleNext() {
      clearScheduled()
      if (cancelled || document.visibilityState !== "visible") return
      timeoutId = setTimeout(runPoll, isTransitional ? FAST_POLL_MS : SLOW_POLL_MS)
    }

    async function runPoll() {
      if (cancelled) return
      await poll()
      scheduleNext()
    }

    function handleVisibilityChange() {
      if (cancelled) return
      if (document.visibilityState === "visible") {
        runPoll()
      } else {
        clearScheduled()
      }
    }

    scheduleNext()
    document.addEventListener("visibilitychange", handleVisibilityChange)

    return () => {
      cancelled = true
      clearScheduled()
      document.removeEventListener("visibilitychange", handleVisibilityChange)
    }
  }, [poll, isTransitional])

  async function addNumber() {
    if (newNumber.trim() === "") return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch("/api/settings/whatsapp-bridge/numbers", {
        method: "POST",
        body: JSON.stringify({ number: newNumber.trim(), confirmNew: confirmUnknown }),
      })
      const body = await parseJson(res)
      if (!res.ok) {
        // NUMBER_NOT_REGISTERED is the only refusal the operator can clear;
        // NUMBER_CONFLICT (already in this pool) stays a hard stop.
        if (body.code === "NUMBER_NOT_REGISTERED") setConfirmUnknown(false)
        setError(body.error ?? "Failed to add number.")
        setNeedsConfirm(body.code === "NUMBER_NOT_REGISTERED")
        return
      }
      setPairing(body as PairingResult)
      setNewNumber("")
      setNeedsConfirm(false)
      setConfirmUnknown(false)
      await refresh()
    } catch {
      setError("Network error adding number.")
    } finally {
      setBusy(false)
    }
  }

  async function promote(slotId: string) {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/settings/whatsapp-bridge/numbers/${slotId}/promote`, { method: "POST" })
      const body = await parseJson(res)
      if (!res.ok) { setError(body.error ?? "Failed to promote number."); return }
      await refresh()
    } catch {
      setError("Network error promoting number.")
    } finally {
      setBusy(false)
    }
  }

  async function setPriority(slotId: string, currentPriority: number) {
    const raw = priorityEdits[slotId]
    if (raw === undefined || raw.trim() === "") return
    const priority = Number(raw)
    if (!Number.isInteger(priority)) { setError("Priority must be a whole number."); return }
    if (priority === currentPriority) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/settings/whatsapp-bridge/numbers/${slotId}`, {
        method: "PATCH",
        body: JSON.stringify({ priority }),
      })
      const body = await parseJson(res)
      if (!res.ok) { setError(body.error ?? "Failed to update priority."); return }
      setPriorityEdits((p) => {
        const next = { ...p }
        delete next[slotId]
        return next
      })
      await refresh()
    } catch {
      setError("Network error updating priority.")
    } finally {
      setBusy(false)
    }
  }

  // Park / un-park a number. Unlike Retire this keeps the WhatsApp session,
  // so putting it back on the air needs no pairing code and nobody holding
  // the phone.
  async function setPaused(slotId: string, paused: boolean) {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/settings/whatsapp-bridge/numbers/${slotId}/pause`, {
        method: "POST",
        body: JSON.stringify({ paused }),
      })
      const body = await parseJson(res)
      if (!res.ok) { setError(body.error ?? "Failed to change pause state."); return }
      await refresh()
    } catch {
      setError("Network error changing pause state.")
    } finally {
      setBusy(false)
    }
  }

  // Re-link a session WhatsApp revoked. Revoked credentials cannot be
  // reconnected, so the bridge clears the slot and pairs the same number
  // again — one action instead of Retire-then-Add, which leaves the pool
  // empty if the operator stops after the first step.
  async function relink(slotId: string) {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/settings/whatsapp-bridge/numbers/${slotId}/relink`, { method: "POST" })
      const body = await parseJson(res)
      if (!res.ok) { setError(body.error ?? "Failed to re-link number."); return }
      setPairing(body as PairingResult)
      await refresh()
    } catch {
      setError("Network error re-linking number.")
    } finally {
      setBusy(false)
    }
  }

  // Retire is destructive: it logs the number out and deletes its bridge
  // session, so it must be re-paired from scratch afterwards. Requires an
  // inline two-step confirm — no window.confirm (breaks automation).
  async function retire(slotId: string) {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/settings/whatsapp-bridge/numbers/${slotId}`, { method: "DELETE" })
      const body = await parseJson(res)
      if (!res.ok) { setError(body.error ?? "Failed to retire number."); return }
      await refresh()
    } catch {
      setError("Network error retiring number.")
    } finally {
      setBusy(false)
      setConfirmRetireId(null)
    }
  }

  // Built once and rendered from BOTH branches below (reachable and
  // unreachable). The operator who is mid-pairing has ~2.5 minutes to act on
  // this code on their phone — a poll (or a refresh() after an unrelated
  // action) that flips `numbers` to null must never take this off screen
  // with it. The code was already issued by the bridge; a failed /numbers
  // call doesn't retract it, so the panel stays, with an honest caveat that
  // status can't currently be confirmed.
  const pairingPanel = pairing && (
    <div className="rounded-md border border-blue-200 bg-blue-50 p-3 text-sm">
      <p className="font-semibold text-blue-900">
        Pairing code: <span className="font-mono text-base tracking-wider">{pairing.pairingCode}</span>
      </p>
      <p className="mt-1 text-xs font-medium text-red-700">
        Expires at {new Date(pairing.expiresAt).toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit", second: "2-digit" })} — about 2.5 minutes from now. Start immediately.
      </p>
      <ol className="mt-2 list-decimal space-y-0.5 pl-4 text-xs text-blue-800">
        <li>On the phone with that number, open WhatsApp</li>
        <li>Settings &rarr; Linked devices &rarr; Link a device</li>
        <li>Tap &quot;Link with phone number instead&quot;</li>
        <li>Enter the code above</li>
      </ol>
      {numbers === null && (
        <p className="mt-2 text-xs font-semibold text-red-700">
          Lost contact with the bridge while this code is active — it may still work if entered before it expires, but status can&apos;t be confirmed right now.
        </p>
      )}
    </div>
  )

  if (numbers === null) {
    return (
      <div className="mt-4 space-y-4">
        {pairingPanel}
        <div className="flex items-center gap-2 rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">
          <XCircle className="h-4 w-4 shrink-0" />
          Could not reach the WhatsApp bridge. Outbound WhatsApp may be down — check the bridge container, then reopen this tab.
        </div>
      </div>
    )
  }

  const sorted = [...numbers].sort((a, b) => a.priority - b.priority)
  const anyConnected = sorted.some((n) => n.status === "CONNECTED")

  return (
    <div className="space-y-4 pt-4">
      {error && (
        <div className="flex items-center gap-2 rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">
          <XCircle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      {!anyConnected && (
        <div className="flex items-center gap-2 rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          No WhatsApp number is currently connected — outbound WhatsApp is down.
        </div>
      )}

      <div className="space-y-2">
        {sorted.length === 0 ? (
          <p className="text-sm text-gray-400">No numbers paired yet.</p>
        ) : (
          sorted.map((n) => {
            const Icon = STATUS_ICON[n.status]
            const isConfirming = confirmRetireId === n.slotId
            const priorityValue = priorityEdits[n.slotId] ?? String(n.priority)
            return (
              <div key={n.slotId} className="rounded-md border border-gray-200 px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${STATUS_STYLES[n.status]}`}>
                      <Icon className="h-3 w-3" />
                      {n.status}
                    </span>
                    <span className="font-medium text-gray-900">{n.number ? `+${n.number}` : "(pairing…)"}</span>
                  </div>

                  {!isConfirming ? (
                    <div className="flex items-center gap-2">
                      {n.status === "PAUSED" ? (
                        <Button size="sm" disabled={busy} onClick={() => setPaused(n.slotId, false)}>
                          Resume
                        </Button>
                      ) : n.status === "LOGGED_OUT" ? (
                        <Button size="sm" disabled={busy} onClick={() => relink(n.slotId)}>
                          Re-link
                        </Button>
                      ) : (
                        <Button size="sm" variant="outline" disabled={busy || n.status !== "CONNECTED"} onClick={() => promote(n.slotId)}>
                          Promote
                        </Button>
                      )}
                      {n.status !== "PAUSED" && n.status !== "LOGGED_OUT" && (
                        <Button size="sm" variant="outline" disabled={busy} onClick={() => setPaused(n.slotId, true)}>
                          Pause
                        </Button>
                      )}
                      <Button size="sm" variant="outline" className="border-red-300 text-red-700" disabled={busy} onClick={() => setConfirmRetireId(n.slotId)}>
                        Retire
                      </Button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-red-700">Logs out &amp; deletes the session — not undoable.</span>
                      <Button size="sm" variant="destructive" disabled={busy} onClick={() => retire(n.slotId)}>Confirm retire</Button>
                      <Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirmRetireId(null)}>Cancel</Button>
                    </div>
                  )}
                </div>

                <div className="mt-2 flex items-center gap-2 text-xs text-gray-400">
                  <label htmlFor={`priority-${n.slotId}`}>priority</label>
                  <Input
                    id={`priority-${n.slotId}`}
                    type="number"
                    className="h-7 w-16 text-xs"
                    value={priorityValue}
                    onChange={(e) => setPriorityEdits((p) => ({ ...p, [n.slotId]: e.target.value }))}
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-xs"
                    disabled={busy || priorityValue === String(n.priority) || priorityValue.trim() === ""}
                    onClick={() => setPriority(n.slotId, n.priority)}
                  >
                    Set
                  </Button>
                  <span>lower number = more preferred</span>
                </div>
              </div>
            )
          })
        )}
      </div>

      <div className="space-y-2 rounded-md border border-gray-200 p-4">
        <p className="text-sm font-medium text-gray-900">Add a number</p>
        <div className="flex gap-2">
          <Input
            placeholder="27821234567"
            value={newNumber}
            onChange={(e) => {
              setNewNumber(e.target.value)
              // A different number has to be confirmed on its own merits.
              setNeedsConfirm(false)
              setConfirmUnknown(false)
            }}
            className="max-w-xs"
          />
          <Button
            size="sm"
            onClick={addNumber}
            disabled={busy || newNumber.trim() === "" || (needsConfirm && !confirmUnknown)}
          >
            Add number
          </Button>
        </div>

        {needsConfirm && (
          <label className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
            <input
              type="checkbox"
              checked={confirmUnknown}
              onChange={(e) => setConfirmUnknown(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              This number is new to this bridge. Confirm it is <strong>not linked to any other
              WhatsApp bridge</strong> (including the other environment). One number running on two
              bridges makes both sessions conflict, and WhatsApp revokes them — that took the live
              number down for eight hours on 4 Aug 2026. You will only be asked once per number.
            </span>
          </label>
        )}

        {pairingPanel}
      </div>
    </div>
  )
}
