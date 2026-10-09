"use client"

import { useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { uploadStatementAction } from "./actions"
import { summariseUpload } from "./upload-summary"

type Feedback = { kind: "error" | "success"; text: string }

/**
 * Manual upload of an ABSA statement CSV.
 *
 * Runs the same ingest/reconcile pipeline as the automated worker endpoint, so
 * a re-upload of the same file is a no-op (deduped on the file's sha256).
 *
 * Matches normally land as PROPOSED rows for a human to confirm — but this does
 * NOT mean an upload cannot move money: with TenantConfig.absaAutoApplyHighConfidence
 * on, HIGH-confidence matches are booked as Payments during the import itself
 * (lib/bank-sync/import.ts). That is why `autoApplied` is surfaced below rather
 * than dropped — an operator must never have money posted without being told.
 */
export function StatementUpload() {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<Feedback | null>(null)

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setFeedback(null)
    setBusy(true)
    try {
      const result = await uploadStatementAction(new FormData(e.currentTarget))
      if (!result.ok) {
        setFeedback({ kind: "error", text: result.error })
        return
      }
      setFeedback({ kind: "success", text: summariseUpload(result) })
      // Clear the picker so a second click can't silently re-submit the same
      // file (harmless — the import dedups — but it reads as a broken button).
      if (inputRef.current) inputRef.current.value = ""
      router.refresh()
    } catch (err) {
      setFeedback({ kind: "error", text: err instanceof Error ? err.message : "Could not upload statement" })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-100 p-4 space-y-3">
      <div>
        <h2 className="font-semibold text-gray-900">Upload a statement</h2>
        <p className="text-sm text-gray-500">
          Download the CSV from ABSA Online Banking and upload it here. Re-uploading the same file is safe — it will not
          duplicate transactions.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-wrap items-center gap-3">
        <input
          ref={inputRef}
          type="file"
          name="file"
          accept=".csv,text/csv"
          required
          disabled={busy}
          className="border border-gray-300 rounded px-2 py-1 text-sm disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={busy}
          className="px-3 py-1 rounded-md bg-blue-600 text-white font-medium disabled:opacity-50"
        >
          {busy ? "Uploading…" : "Upload"}
        </button>
      </form>

      {feedback && (
        <div
          className={
            feedback.kind === "error"
              ? "bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-4 py-3"
              : "bg-green-50 border border-green-200 text-green-700 text-sm rounded-lg px-4 py-3"
          }
        >
          {feedback.text}
        </div>
      )}
    </div>
  )
}
