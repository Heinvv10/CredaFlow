"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import {
  allowedMessageReconciliationOutcomes,
  type MessageReconciliationOutcome,
} from "@/lib/messaging/reconciliation"

export function MessageReconciliationAction({
  messageId,
  dispatchState,
  provider,
  knownProviderMessageId,
  knownProviderAcceptedAt,
  knownSimulationReceiptId,
}: {
  messageId: string
  dispatchState?: string | null
  provider: string
  knownProviderMessageId?: string | null
  knownProviderAcceptedAt?: string | null
  knownSimulationReceiptId?: string | null
}) {
  const router = useRouter()
  const allowedOutcomes = allowedMessageReconciliationOutcomes(dispatchState)
  const [outcome, setOutcome] = useState<"" | MessageReconciliationOutcome>(
    allowedOutcomes.length === 1 ? allowedOutcomes[0] : "",
  )
  const [reason, setReason] = useState("")
  const [evidenceReference, setEvidenceReference] = useState("")
  const [providerMessageId, setProviderMessageId] = useState(knownProviderMessageId ?? "")
  const [providerAcceptedAt, setProviderAcceptedAt] = useState("")
  const [simulationReceiptId, setSimulationReceiptId] = useState(knownSimulationReceiptId ?? "")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const needsManualAcceptanceTime = outcome === "SENT" && dispatchState !== "ACCEPTED"
  const needsManualProviderId = needsManualAcceptanceTime && provider !== "MSGRAPH"
  const needsManualSimulationReceipt = outcome === "SIMULATED" && !knownSimulationReceiptId
  const canSubmit = outcome !== "" &&
    allowedOutcomes.includes(outcome) &&
    reason.trim().length >= 10 &&
    evidenceReference.trim().length >= 3 &&
    (!needsManualAcceptanceTime || providerAcceptedAt !== "") &&
    (!needsManualProviderId || providerMessageId.trim().length >= 1) &&
    (!needsManualSimulationReceipt || simulationReceiptId.trim().length >= 1)

  async function submit() {
    setSubmitting(true)
    setError(null)
    try {
      const response = await fetch(`/api/messaging/reconciliation/${messageId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          outcome,
          reason,
          evidenceReference,
          ...(outcome === "SENT" && providerMessageId ? { providerMessageId } : {}),
          ...(outcome === "SENT" && providerAcceptedAt
            ? { providerAcceptedAt: new Date(providerAcceptedAt).toISOString() }
            : {}),
          ...(outcome === "SIMULATED" && simulationReceiptId
            ? { simulationReceiptId }
            : {}),
        }),
      })
      const body = await response.json() as { error?: string }
      if (!response.ok) throw new Error(body.error ?? "Reconciliation failed")
      router.refresh()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Reconciliation failed")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="mt-4 grid gap-3 border-t border-amber-200 pt-4">
      <label className="grid gap-1 text-xs font-semibold text-gray-700">
        Verified provider outcome
        <select
          value={outcome}
          onChange={(event) => {
            const nextOutcome = event.target.value as typeof outcome
            setOutcome(nextOutcome)
            if (nextOutcome !== "SENT") {
              setProviderMessageId("")
              setProviderAcceptedAt("")
            }
            if (nextOutcome !== "SIMULATED" && !knownSimulationReceiptId) {
              setSimulationReceiptId("")
            }
          }}
          disabled={allowedOutcomes.length <= 1}
          className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-normal"
        >
          {allowedOutcomes.length > 1 ? <option value="">Select an outcome</option> : null}
          {allowedOutcomes.includes("NOT_SENT") ? <option value="NOT_SENT">Not sent</option> : null}
          {allowedOutcomes.includes("SENT") ? <option value="SENT">Provider accepted</option> : null}
          {allowedOutcomes.includes("SIMULATED") ? <option value="SIMULATED">Dry-run simulated</option> : null}
        </select>
      </label>
      {dispatchState === "ACCEPTED" ? (
        <p className="text-xs text-amber-900">
          Provider acceptance is already durable and can only be finalized as sent.
          {knownProviderMessageId ? ` Provider ID: ${knownProviderMessageId}.` : ""}
          {knownProviderAcceptedAt ? ` Accepted at: ${knownProviderAcceptedAt}.` : ""}
        </p>
      ) : null}
      {dispatchState === "SIMULATED" ? (
        <p className="text-xs text-amber-900">
          The dry-run outcome is already durable and can only be finalized as simulated.
        </p>
      ) : null}
      {needsManualProviderId ? (
        <label className="grid gap-1 text-xs font-semibold text-gray-700">
          Actual provider message ID
          <input
            value={providerMessageId}
            onChange={(event) => setProviderMessageId(event.target.value)}
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-normal"
            placeholder="Provider message ID"
          />
        </label>
      ) : null}
      {needsManualAcceptanceTime ? (
        <label className="grid gap-1 text-xs font-semibold text-gray-700">
          Provider acceptance time
          <input
            type="datetime-local"
            value={providerAcceptedAt}
            onChange={(event) => setProviderAcceptedAt(event.target.value)}
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-normal"
          />
        </label>
      ) : null}
      {needsManualSimulationReceipt ? (
        <label className="grid gap-1 text-xs font-semibold text-gray-700">
          Local simulation receipt ID
          <input
            value={simulationReceiptId}
            onChange={(event) => setSimulationReceiptId(event.target.value)}
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-normal"
            placeholder="Dry-run receipt ID"
          />
        </label>
      ) : null}
      <label className="grid gap-1 text-xs font-semibold text-gray-700">
        Evidence or case reference
        <input
          value={evidenceReference}
          onChange={(event) => setEvidenceReference(event.target.value)}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-normal"
          placeholder="Provider log, support case or dry-run record"
        />
      </label>
      <label className="grid gap-1 text-xs font-semibold text-gray-700">
        Reconciliation reason
        <textarea
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          minLength={10}
          maxLength={2000}
          className="min-h-20 rounded-lg border border-gray-300 px-3 py-2 text-sm font-normal"
          placeholder="What was checked and what it proved"
        />
      </label>
      {error ? <p className="text-xs text-red-700">{error}</p> : null}
      <button
        type="button"
        disabled={submitting || !canSubmit}
        onClick={submit}
        className="w-fit rounded-lg bg-[#4F46E5] px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
      >
        {submitting ? "Recording…" : "Record audited outcome"}
      </button>
    </div>
  )
}
