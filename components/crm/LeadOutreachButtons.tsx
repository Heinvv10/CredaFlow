"use client"

import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { MessageCircle, Check } from "lucide-react"
import {
  LEAD_OUTREACH,
  LEAD_OUTREACH_KINDS,
  renderOutreachPreview,
  type LeadOutreachKind,
} from "@/lib/crm/lead-outreach-templates"
import type { LeadOutreachEligibility } from "@/lib/crm/lead-outreach-eligibility"

// Self-contained side-panel card incl. chrome: LeadDetailClient is over the
// 300-line cap, so it mounts this in one line. Imports copy/labels from the
// prisma-free templates module — lib/crm/lead-outreach.ts (the send path)
// pulls in prisma and must never reach the browser bundle.

// WhatsApp is the only outreach channel: SMS is send-only in this system, so
// the lead's reply — which every one of these messages asks for — would be
// silently dropped. See lib/crm/lead-outreach-templates.ts.
export function LeadOutreachButtons({
  leadId,
  eligibility,
  leadFirstName,
  agentName,
}: {
  leadId: string
  eligibility: LeadOutreachEligibility
  leadFirstName: string
  agentName: string
}) {
  const router = useRouter()
  const [busy, setBusy] = useState<LeadOutreachKind | null>(null)
  const [sent, setSent] = useState<LeadOutreachKind | null>(null)
  const [simulated, setSimulated] = useState<LeadOutreachKind | null>(null)
  const [pending, setPending] = useState<LeadOutreachKind | null>(null)
  const [reconciliationRequired, setReconciliationRequired] = useState<LeadOutreachKind | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<LeadOutreachKind | null>(null)
  const operationIds = useRef<Partial<Record<LeadOutreachKind, string>>>({})
  const operationLeadId = useRef(leadId)

  useEffect(() => {
    if (operationLeadId.current === leadId) return
    operationLeadId.current = leadId
    operationIds.current = {}
    setBusy(null)
    setSent(null)
    setSimulated(null)
    setPending(null)
    setReconciliationRequired(null)
    setError(null)
    setConfirming(null)
  }, [leadId])

  const send = async (kind: LeadOutreachKind) => {
    // `busy` also guards re-entry: these send immediately with no draft step,
    // so a double-click must not fire two WhatsApps at the lead.
    if (busy !== null) return
    setBusy(kind)
    setSent(null)
    setSimulated(null)
    setPending(null)
    setReconciliationRequired(null)
    setError(null)
    setConfirming(null)
    try {
      const operationId = operationIds.current[kind] ?? crypto.randomUUID()
      operationIds.current[kind] = operationId
      const submittedLeadId = leadId
      const res = await fetch(`/api/crm/leads/${leadId}/outreach`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, channel: "WHATSAPP", operationId }),
      })
      const data = await res.json()
      if (operationLeadId.current !== submittedLeadId) return
      if (!res.ok) {
        // 409 carries a reason/detail from the eligibility engine (opt-out,
        // blocked, no destination) — show the real reason, not "failed".
        setError(data.detail ?? data.reason ?? "Could not send")
        return
      }
      if (data.reconciliationRequired === true) {
        setReconciliationRequired(kind)
        setSimulated(null)
        setPending(null)
        setSent(null)
      } else if (data.simulated) {
        setSimulated(kind)
        setPending(null)
        setSent(null)
      } else if (data.pending) {
        setPending(kind)
        setSimulated(null)
        setSent(null)
      } else if (data.sent === true) {
        setSent(kind)
        setSimulated(null)
        setPending(null)
        delete operationIds.current[kind]
      } else {
        setError("The message outcome is unknown — do not resend; open reconciliation.")
      }
      router.refresh()
    } catch {
      if (operationLeadId.current === leadId) {
        setError("Could not send — check your connection and try again")
      }
    } finally {
      if (operationLeadId.current === leadId) setBusy(null)
    }
  }

  // The server re-checks this on every send — rendering the reason here is so
  // the agent knows what to do about it, not a security boundary.
  if (!eligibility.ok) {
    return (
      <div className="bg-white rounded-lg border border-gray-100 shadow-sm p-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-2">Outreach</p>
        <p className="text-[11px] text-gray-500 leading-snug">{eligibility.detail}</p>
      </div>
    )
  }

  return (
    <div className="bg-white rounded-lg border border-gray-100 shadow-sm p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-1">Outreach</p>
      <p className="text-[11px] text-gray-400 mb-3">Sends on WhatsApp immediately — no draft step</p>

      <div className="space-y-3">
        {LEAD_OUTREACH_KINDS.map((kind) => {
          const def = LEAD_OUTREACH[kind]
          const isConfirming = confirming === kind
          const justSent = sent === kind
          return (
            <div key={kind} className="border border-gray-100 rounded-md p-2.5">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-gray-700">{def.label}</p>
                  <p className="text-[11px] text-gray-400 leading-snug">{def.description}</p>
                </div>
                {justSent && <Check className="h-3.5 w-3.5 text-green-600 flex-shrink-0 mt-0.5" />}
                {simulated === kind && <span className="text-[10px] font-medium text-amber-700">SIMULATED</span>}
                {pending === kind && <span className="text-[10px] font-medium text-amber-700">PENDING — DO NOT RESEND</span>}
                {reconciliationRequired === kind && (
                  <span className="text-[10px] font-medium text-amber-800">RECONCILIATION REQUIRED</span>
                )}
              </div>

              {isConfirming ? (
                <div className="mt-2">
                  {/* The exact text that will be delivered. Lead.firstName is
                      typed by a member of the public and is interpolated into
                      this body, so a staff member must see what they are
                      actually sending — a one-click send with no preview makes
                      the click blind. Rendered with the same sanitiser the send
                      path uses, so preview and payload cannot diverge. */}
                  <p className="text-[11px] text-gray-600 bg-gray-50 border border-gray-100 rounded p-2 mb-2 whitespace-pre-wrap break-words">
                    {renderOutreachPreview(kind, { firstName: leadFirstName, agentName })}
                  </p>
                  <div className="flex gap-1.5">
                    <button
                      onClick={() => send(kind)}
                      disabled={busy !== null}
                      className="flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium border border-green-200 text-green-700 hover:bg-green-50 disabled:opacity-60"
                    >
                      <MessageCircle className="h-3 w-3" style={{ color: "#25D366" }} />
                      {busy === kind ? "Sending…" : "Confirm send"}
                    </button>
                    <button
                      onClick={() => setConfirming(null)}
                      disabled={busy !== null}
                      className="px-2 py-1 rounded text-[11px] text-gray-400 hover:text-gray-600 disabled:opacity-60"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => { setConfirming(kind); setError(null) }}
                  disabled={busy !== null}
                  className="mt-2 flex items-center justify-center gap-1 w-full px-2 py-1 rounded text-[11px] font-medium border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-60"
                >
                  <MessageCircle className="h-3 w-3" style={{ color: "#25D366" }} />
                  Send on WhatsApp…
                </button>
              )}
            </div>
          )
        })}
      </div>

      {error && <p className="mt-3 text-xs text-red-600">{error}</p>}
      {sent && !error && (
        <p className="mt-3 text-xs text-green-700">
          {LEAD_OUTREACH[sent].label} sent on WhatsApp — see the timeline.
        </p>
      )}
      {simulated && !error && (
        <p className="mt-3 text-xs text-amber-700">
          {LEAD_OUTREACH[simulated].label} simulated — no WhatsApp message was sent.
        </p>
      )}
      {pending && !error && (
        <p className="mt-3 text-xs text-amber-700">
          {LEAD_OUTREACH[pending].label} is still queued or retrying — do not send it again.
        </p>
      )}
    </div>
  )
}
