"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { toast } from "@/lib/toast"

type Props = {
  applicationId: string
  /** "rerun": a bureau result is already on file; a quieter, secondary action. */
  mode?: "start" | "retry" | "rerun"
}

type ReviewErrorBody = {
  error?: string
  mismatches?: Array<{ id: string; docType: string; fileName: string }>
}

export function ApplicationStartReviewButton({ applicationId, mode = "start" }: Props) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)

  async function startReview() {
    setLoading(true)
    try {
      const res = await fetch(`/api/applications/${applicationId}/review`, {
        method: "POST",
        // The review route only returns JSON when the client signals it can
        // accept JSON; otherwise it returns a 303 redirect that would silently
        // bypass our 422 error handling below.
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ action: "start_review" }),
      })
      if (res.ok) {
        const body = (await res.json()) as { bureauResult?: string }
        if (body.bureauResult === "failed") {
          toast.error("Bureau enquiry failed and was recorded. Retry after checking the provider connection.")
        } else if (body.bureauResult === "skipped") {
          toast.error("Bureau enquiry was skipped because client consent is unavailable.")
        } else {
          toast.success(mode === "start" ? "Review started" : "Bureau enquiry completed")
        }
        router.refresh()
        return
      }
      const body = (await res.json().catch(() => ({}))) as ReviewErrorBody
      // 422 carries a doc-mismatch list; show the user-facing summary the API
      // already wrote, not the raw JSON the native form would have rendered.
      toast.error(body.error ?? `Failed to start review (${res.status})`)
    } catch {
      toast.error("Failed to start review")
    } finally {
      setLoading(false)
    }
  }

  return (
    <Button type="button" onClick={startReview} disabled={loading} className="w-full" variant={mode === "rerun" ? "outline" : "default"}>
      {loading
        ? mode === "start" ? "Starting…" : "Retrying…"
        : mode === "retry" ? "Retry Bureau Enquiry" : mode === "rerun" ? "Re-run bureau enquiry" : "Start Review"}
    </Button>
  )
}
